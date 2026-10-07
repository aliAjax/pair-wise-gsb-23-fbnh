/**
 * 仓储与业务规则：
 *  - 入库幂等：批次 id 即幂等键，断点重试/重放不新增处置或审计
 *  - 同一次采样（samplingKey）首份有效记录入库，后到者留草稿并标记冲突
 *  - 校准或阈值更新后，未签认异常按新依据重算；已签认冻结，保留原值和依据
 *  - 角色权限：巡检员可提交/补录，班组长可签认与发布依据，审计员只读
 */
import { determine } from "./determination";
import type {
  Actor,
  AuditEntry,
  BatchRecord,
  Calibration,
  Determination,
  Disposition,
  IngestResult,
  SampleBatch,
  ThresholdPolicy,
} from "./types";
import { DISPOSITION_LABEL, ROLE_LABEL, STATUS_LABEL } from "./types";

export class PermissionError extends Error {}

export interface StoreSnapshot {
  policies: ThresholdPolicy[];
  calibrations: Calibration[];
  records: BatchRecord[];
  dispositions: Disposition[];
  audit: AuditEntry[];
}

export class CleanroomStore {
  private policies: ThresholdPolicy[];
  private calibrations: Calibration[];
  private records = new Map<string, BatchRecord>(); // key: batch.id（幂等键）
  private samplingIndex = new Map<string, string>(); // samplingKey -> 已入库批次 id
  private dispositions = new Map<string, Disposition>(); // key: batchId
  private auditLog: AuditEntry[] = [];
  private seq = 0;
  private dispositionSeq = 0;

  constructor(
    seed: { policies?: ThresholdPolicy[]; calibrations?: Calibration[] } = {},
    private now: () => string = () => new Date().toISOString()
  ) {
    this.policies = [...(seed.policies ?? [])];
    this.calibrations = [...(seed.calibrations ?? [])];
  }

  // ---------- 权限 ----------
  private requireRole(actor: Actor, roles: Actor["role"][], action: string) {
    if (!roles.includes(actor.role)) {
      throw new PermissionError(
        `${ROLE_LABEL[actor.role]}无权执行「${action}」（需 ${roles
          .map((r) => ROLE_LABEL[r])
          .join("/")}）`
      );
    }
  }

  private audit(actor: Actor | null, action: string, detail: string) {
    this.auditLog.push({
      seq: ++this.seq,
      at: this.now(),
      actor: actor?.name ?? "系统",
      role: actor?.role ?? "system",
      action,
      detail,
    });
  }

  // ---------- 入库（幂等 + 冲突） ----------
  /**
   * 提交采样批次。断点重试直接重调本方法：
   * 同一批次 id 重放时返回首次结果，不新增处置或审计。
   */
  ingest(actor: Actor, batch: SampleBatch): IngestResult {
    this.requireRole(actor, ["inspector", "team_lead"], "提交采样批次");

    const existing = this.records.get(batch.id);
    if (existing) {
      return { outcome: "replayed", record: existing }; // 重放：零副作用
    }

    const now = this.now();
    const storedId = this.samplingIndex.get(batch.samplingKey);
    if (storedId) {
      // 现场与中心重复提交同一次采样：首份已入库，本份留草稿并看见冲突
      const draft: BatchRecord = {
        batch,
        state: "draft_conflict",
        conflictWith: storedId,
        determination: null,
        frozen: false,
        storedAt: now,
      };
      this.records.set(batch.id, draft);
      this.audit(
        actor,
        "ingest.conflict",
        `批次 ${batch.id}（${batch.source === "center" ? "中心" : "现场"}）与已入库批次 ${storedId} 为同一次采样，留作冲突草稿`
      );
      return { outcome: "draft_conflict", record: draft };
    }

    const determination = determine(
      batch,
      this.policies,
      this.calibrations,
      now
    );
    const record: BatchRecord = {
      batch,
      state: "stored",
      determination,
      frozen: false,
      storedAt: now,
    };
    this.records.set(batch.id, record);
    this.samplingIndex.set(batch.samplingKey, batch.id);
    this.audit(
      actor,
      "ingest.stored",
      `批次 ${batch.id} 入库：${STATUS_LABEL[determination.status]}，${determination.countsPerM3.toLocaleString()} 个/m³（依据 ${determination.policyId ?? "无阈值"} / ${determination.calibrationId ?? "无校准"}）`
    );
    if (determination.status === "exceeded") {
      this.openDisposition(batch.id, determination, now);
    }
    return { outcome: "stored", record };
  }

  private openDisposition(
    batchId: string,
    determination: Determination,
    now: string
  ) {
    const id = `EX-${String(++this.dispositionSeq).padStart(3, "0")}`;
    const disposition: Disposition = {
      id,
      batchId,
      status: "open",
      openedAt: now,
      snapshot: null,
      acknowledgedBy: null,
      acknowledgedAt: null,
      note: null,
      history: [
        {
          at: now,
          action: "opened",
          detail: `判定超限：${determination.reason}`,
        },
      ],
    };
    this.dispositions.set(batchId, disposition);
    this.audit(null, "disposition.opened", `异常 ${id} 生成（批次 ${batchId}）：${determination.reason}`);
  }

  // ---------- 签认 ----------
  /** 班组长签认：冻结原值与依据，之后重算不再触碰 */
  acknowledge(actor: Actor, batchId: string, note: string): Disposition {
    this.requireRole(actor, ["team_lead"], "签认异常");
    const disposition = this.dispositions.get(batchId);
    const record = this.records.get(batchId);
    if (!disposition || !record) throw new Error(`批次 ${batchId} 无异常处置单`);
    if (disposition.status !== "open") {
      throw new Error(`异常 ${disposition.id} 当前为「${DISPOSITION_LABEL[disposition.status]}」，不能签认`);
    }
    const now = this.now();
    disposition.status = "acknowledged";
    disposition.snapshot = record.determination; // 原值和依据快照
    disposition.acknowledgedBy = actor.name;
    disposition.acknowledgedAt = now;
    disposition.note = note;
    disposition.history.push({
      at: now,
      action: "acknowledged",
      detail: `${actor.name} 签认：${note}`,
    });
    record.frozen = true;
    this.audit(
      actor,
      "disposition.acknowledged",
      `异常 ${disposition.id}（批次 ${batchId}）签认，冻结判定值 ${disposition.snapshot?.countsPerM3.toLocaleString()} 个/m³ 与依据 ${disposition.snapshot?.policyId}/${disposition.snapshot?.calibrationId}`
    );
    return disposition;
  }

  // ---------- 依据更新 → 未签认重算 ----------
  publishPolicy(actor: Actor, policy: ThresholdPolicy) {
    this.requireRole(actor, ["team_lead"], "发布阈值版本");
    this.policies.push(policy);
    this.audit(
      actor,
      "policy.published",
      `阈值版本 ${policy.id}（v${policy.version}）发布，生效于 ${policy.effectiveFrom}`
    );
    this.recalculate(`阈值版本 ${policy.id} 发布`);
  }

  addCalibration(actor: Actor, calibration: Calibration) {
    this.requireRole(actor, ["team_lead"], "录入仪器校准");
    this.calibrations.push(calibration);
    this.audit(
      actor,
      "calibration.added",
      `校准 ${calibration.id}（仪器 ${calibration.instrumentId}，系数 ×${calibration.correctionFactor}）生效于 ${calibration.calibratedAt}`
    );
    this.recalculate(`校准 ${calibration.id} 录入`);
  }

  /** 未签认异常按新依据重算；已签认（frozen）保留原值和依据 */
  private recalculate(trigger: string) {
    const now = this.now();
    for (const record of this.records.values()) {
      if (record.state !== "stored" || record.frozen) continue;
      const before = record.determination;
      const after = determine(
        record.batch,
        this.policies,
        this.calibrations,
        now
      );
      const changed =
        !before ||
        before.status !== after.status ||
        before.countsPerM3 !== after.countsPerM3 ||
        before.policyId !== after.policyId ||
        before.calibrationId !== after.calibrationId;
      if (!changed) continue;

      record.determination = after;
      this.audit(
        null,
        "determination.recalculated",
        `批次 ${record.batch.id} 因${trigger}重算：${before ? STATUS_LABEL[before.status] : "-"} ${before?.countsPerM3.toLocaleString() ?? "-"} → ${STATUS_LABEL[after.status]} ${after.countsPerM3.toLocaleString()} 个/m³（依据 ${after.policyId ?? "无"}/${after.calibrationId ?? "无"}）`
      );

      const disposition = this.dispositions.get(record.batch.id);
      if (after.status === "exceeded" && !disposition) {
        this.openDisposition(record.batch.id, after, now);
      } else if (disposition && disposition.status === "open") {
        if (after.status === "exceeded") {
          disposition.history.push({
            at: now,
            action: "recalculated",
            detail: `按新依据重算仍超限：${after.reason}`,
          });
        } else {
          disposition.status = "closed";
          disposition.history.push({
            at: now,
            action: "closed",
            detail: `按新依据重算后不再超限（${STATUS_LABEL[after.status]}），自动关闭`,
          });
          this.audit(
            null,
            "disposition.closed",
            `异常 ${disposition.id}（批次 ${record.batch.id}）重算后不再超限，自动关闭`
          );
        }
      }
    }
  }

  // ---------- 查询（看板 / 异常处置 / 导出共用） ----------
  snapshot(): StoreSnapshot {
    return {
      policies: [...this.policies],
      calibrations: [...this.calibrations],
      records: [...this.records.values()],
      dispositions: [...this.dispositions.values()],
      audit: [...this.auditLog],
    };
  }

  metrics() {
    const records = [...this.records.values()];
    const stored = records.filter((r) => r.state === "stored");
    return {
      stored: stored.length,
      exceededOpen: [...this.dispositions.values()].filter(
        (d) => d.status === "open"
      ).length,
      pendingResample: stored.filter(
        (r) => r.determination?.status === "pending_resample"
      ).length,
      conflictDrafts: records.filter((r) => r.state === "draft_conflict").length,
    };
  }

  /** 导出 CSV：与看板、异常处置读同一份 determination */
  exportCsv(): string {
    const header = [
      "批次号",
      "采样点",
      "洁净等级",
      "粒径(µm)",
      "来源",
      "体积(L)",
      "计数(个/m³)",
      "限值(个/m³)",
      "判定",
      "阈值版本",
      "校准编号",
      "处置状态",
      "签认人",
      "记录状态",
    ];
    const rows = [...this.records.values()].map((r) => {
      const d = r.determination;
      const disp = this.dispositions.get(r.batch.id);
      return [
        r.batch.id,
        r.batch.pointId,
        r.batch.roomClass,
        String(r.batch.particleSizeUm),
        r.batch.source === "field" ? "现场" : "中心",
        d ? d.volumeL.toFixed(2) : "-",
        d ? String(d.countsPerM3) : "-",
        d?.thresholdPerM3 != null ? String(d.thresholdPerM3) : "-",
        d ? STATUS_LABEL[d.status] : "冲突草稿",
        d?.policyId ?? "-",
        d?.calibrationId ?? "-",
        disp ? DISPOSITION_LABEL[disp.status] : "-",
        disp?.acknowledgedBy ?? "-",
        r.state === "stored" ? (r.frozen ? "已签认冻结" : "在库") : `冲突草稿(与 ${r.conflictWith} 重复)`,
      ];
    });
    return [header, ...rows]
      .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
  }
}
