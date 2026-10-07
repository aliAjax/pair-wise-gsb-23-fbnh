// 纯状态流转：不依赖 React，供 useStore 与测试共用。
// 所有写操作在此集中判定并追加审计；断点重试只推进状态，绝不新增处置/审计。

import {
  buildSnapshot,
  evaluateBatch,
  type BatchEvaluation,
  type EvalContext,
} from "./evaluation";
import type {
  AuditAction,
  AuditEntry,
  Calibration,
  Channel,
  Disposition,
  Role,
  SampleBatch,
  ThresholdPolicy,
} from "./types";

export interface FlowState {
  instruments: import("./types").Instrument[];
  calibrations: Calibration[];
  policies: ThresholdPolicy[];
  batches: SampleBatch[];
  dispositions: Disposition[];
  audit: AuditEntry[];
  networkOk: boolean;
  seq: number;
}

export interface SubmitInput {
  room: string;
  area: SampleBatch["area"];
  grade: SampleBatch["grade"];
  instrumentId: string;
  sampledAt: number;
  durationSec: number;
  rawCount: number;
  channel: Channel;
  backfill?: boolean;
}

export type SubmitResult =
  | { kind: "ledger" | "outbox"; batchId: string }
  | { kind: "conflict"; batchId: string; conflictWithId: string };

export function makeSampleKey(room: string, sampledAt: number): string {
  return `${room.trim()}|${sampledAt}`;
}

export function evalContext(s: FlowState): EvalContext {
  return {
    instruments: s.instruments,
    calibrations: s.calibrations,
    policies: s.policies,
    dispositions: s.dispositions,
  };
}

export function evaluateAll(s: FlowState): BatchEvaluation[] {
  return s.batches.filter((b) => b.status === "ledger").map((b) => evaluateBatch(b, evalContext(s)));
}

export function fromSeed(seed: ReturnType<typeof import("./seed").buildSeed>, networkOk = true): FlowState {
  return {
    instruments: seed.instruments,
    calibrations: seed.calibrations,
    policies: seed.policies,
    batches: seed.batches,
    dispositions: seed.dispositions,
    audit: seed.audit,
    networkOk,
    seq: seed.audit.length + 100,
  };
}

/** 提交一次采样：首份有效入库；同 sampleKey 后到者留草稿并提示冲突 */
export function submitBatch(
  s: FlowState,
  input: SubmitInput,
  actor: string,
  role: Role
): { state: FlowState; result: SubmitResult } {
  let seq = s.seq;
  const newAudit: AuditEntry[] = [];
  const log = (
    actor2: string,
    role2: Role,
    action: AuditAction,
    detail: string,
    batchId?: string
  ) => {
    newAudit.push({
      id: `A-${seq}`,
      at: Date.now(),
      actor: actor2,
      role: role2,
      action,
      detail,
      batchId,
    });
    seq += 1;
  };

  const key = makeSampleKey(input.room, input.sampledAt);
  const prior = s.batches.find((b) => b.sampleKey === key && b.status !== "draft");

  const baseId = `B-${seq}`;
  const backfill = input.backfill ?? Date.now() - input.sampledAt > 60 * 60 * 1000;
  const base: SampleBatch = {
    id: baseId,
    sampleKey: key,
    room: input.room.trim(),
    area: input.area,
    grade: input.grade,
    instrumentId: input.instrumentId,
    sampledAt: input.sampledAt,
    durationSec: input.durationSec,
    rawCount: input.rawCount,
    channel: input.channel,
    submittedBy: actor,
    submittedAt: Date.now(),
    backfill,
    attempts: 0,
    status: "ledger",
  };

  if (prior) {
    const draft: SampleBatch = {
      ...base,
      id: `DRAFT-${seq}`,
      status: "draft",
      conflictWithId: prior.id,
    };
    seq += 1;
    log(
      actor,
      role,
      "conflict.draft",
      `${input.channel === "field" ? "现场" : "中心"}与首份有效记录 ${prior.id} 为同一次采样，留草稿并标记冲突`,
      draft.id
    );
    return {
      state: {
        ...s,
        seq,
        batches: [...s.batches, draft],
        audit: [...s.audit, ...newAudit],
      },
      result: { kind: "conflict", batchId: draft.id, conflictWithId: prior.id },
    };
  }

  const batch: SampleBatch = {
    ...base,
    status: s.networkOk ? "ledger" : "outbox",
    attempts: 1,
    lastError: s.networkOk
      ? undefined
      : "网络中断，已完成 0/1 批，等待断点重试",
  };

  // 异常判定由统一内核在读时算出，未签认不写处置单——因此重试/重放天然幂等，
  // 不会重复生成处置或审计；处置单在班组长签认时才落库（见 signDisposition）。
  log(
    actor,
    role,
    backfill ? "batch.backfill" : "batch.submit",
    `${input.room} ${input.channel === "field" ? "现场" : "中心"}批次${s.networkOk ? "入库（首份有效）" : "进入上传队列"}`,
    baseId
  );

  return {
    state: {
      ...s,
      seq,
      batches: [...s.batches, batch],
      audit: [...s.audit, ...newAudit],
    },
    result: { kind: s.networkOk ? "ledger" : "outbox", batchId: baseId },
  };
}

/** 断点重试：仅推进 outbox → ledger；不生成处置、不生成审计（幂等） */
export function retryUploads(s: FlowState): FlowState {
  if (!s.networkOk) {
    return {
      ...s,
      batches: s.batches.map((b) =>
        b.status === "outbox" ? { ...b, attempts: b.attempts + 1 } : b
      ),
    };
  }
  return {
    ...s,
    batches: s.batches.map((b) =>
      b.status === "outbox"
        ? { ...b, status: "ledger", attempts: b.attempts + 1, lastError: undefined }
        : b
    ),
  };
}

/** 补采：新批次入库并取代原低体积批次 */
export function submitResample(
  s: FlowState,
  originalId: string,
  input: SubmitInput,
  actor: string,
  role: Role
): { state: FlowState; batchId: string } {
  const original = s.batches.find((b) => b.id === originalId);
  if (!original) return { state: s, batchId: "" };

  let seq = s.seq;
  const id = `B-${seq}`;
  seq += 1;
  const batch: SampleBatch = {
    id,
    sampleKey: makeSampleKey(input.room, input.sampledAt),
    room: input.room.trim(),
    area: input.area,
    grade: input.grade,
    instrumentId: input.instrumentId,
    sampledAt: input.sampledAt,
    durationSec: input.durationSec,
    rawCount: input.rawCount,
    channel: input.channel,
    submittedBy: actor,
    submittedAt: Date.now(),
    backfill: false,
    attempts: 1,
    status: "ledger",
    supersedesId: originalId,
  };

  const batches = s.batches
    .map((b) => (b.id === originalId ? { ...b, supersededById: id } : b))
    .concat(batch);

  // 补采批次的异常判定同样由统一内核在读时算出；此处不写处置单，保证重算/重放不产生重复记录。
  const newAudit: AuditEntry[] = [
    {
      id: `A-${seq}`,
      at: Date.now(),
      actor,
      role,
      action: "batch.resample",
      batchId: id,
      detail: `${input.room} 补采入库，原低体积批次 ${originalId} 被取代`,
    },
  ];
  seq += 1;

  return {
    state: {
      ...s,
      seq,
      batches,
      audit: [...s.audit, ...newAudit],
    },
    batchId: id,
  };
}

/** 草稿处理：丢弃 或 改时刻作为新采样入库 */
export function resolveDraft(
  s: FlowState,
  draftId: string,
  action: "discard" | "resubmit",
  actor: string,
  role: Role,
  resubmit?: SubmitInput
): FlowState {
  const draft = s.batches.find((b) => b.id === draftId);
  if (!draft || draft.status !== "draft") return s;

  let batches = s.batches.filter((b) => b.id !== draftId);
  let detail = `草稿 ${draftId} 已丢弃`;

  if (action === "resubmit" && resubmit) {
    const key = makeSampleKey(resubmit.room, resubmit.sampledAt);
    const clash = batches.find((b) => b.sampleKey === key && b.status !== "draft");
    if (clash) {
      batches.push({
        ...draft,
        sampleKey: key,
        room: resubmit.room.trim(),
        sampledAt: resubmit.sampledAt,
        conflictWithId: clash.id,
      });
      return { ...s, batches };
    }
    const nb: SampleBatch = {
      ...draft,
      id: `B-${s.seq}`,
      sampleKey: key,
      room: resubmit.room.trim(),
      area: resubmit.area,
      grade: resubmit.grade,
      instrumentId: resubmit.instrumentId,
      sampledAt: resubmit.sampledAt,
      durationSec: resubmit.durationSec,
      rawCount: resubmit.rawCount,
      channel: resubmit.channel,
      status: "ledger",
      conflictWithId: undefined,
      attempts: 1,
      submittedAt: Date.now(),
      submittedBy: actor,
    };
    batches.push(nb);
    detail = `草稿 ${draftId} 已作为新批次 ${nb.id} 入库`;
  }

  return {
    ...s,
    seq: s.seq + 1,
    batches,
    audit: [
      ...s.audit,
      {
        id: `A-${s.seq}`,
        at: Date.now(),
        actor,
        role,
        action: "conflict.resolve",
        detail,
      },
    ],
  };
}

/** 签认：冻结当前判定原值与依据 */
export function signDisposition(
  s: FlowState,
  batchId: string,
  remark: string,
  actor: string,
  role: Role
): FlowState {
  const batch = s.batches.find((b) => b.id === batchId);
  if (!batch) return s;
  const ev = evaluateBatch(batch, evalContext(s));
  if (ev.verdict !== "abnormal" || ev.signed) return s;
  const snapshot = buildSnapshot(batch, evalContext(s));
  if (!snapshot) return s;

  let dispositions: Disposition[];
  const existing = s.dispositions.find((d) => d.batchId === batchId);
  if (existing) {
    dispositions = s.dispositions.map((d) =>
      d.batchId === batchId
        ? {
            ...d,
            remark: remark || d.remark,
            signed: true,
            signedAt: Date.now(),
            signedBy: actor,
            frozen: snapshot,
          }
        : d
    );
  } else {
    dispositions = [
      ...s.dispositions,
      {
        id: `DSP-${s.seq}`,
        batchId,
        remark,
        createdAt: Date.now(),
        createdBy: actor,
        signed: true,
        signedAt: Date.now(),
        signedBy: actor,
        frozen: snapshot,
      },
    ];
  }

  return {
    ...s,
    seq: s.seq + 1,
    dispositions,
    audit: [
      ...s.audit,
      {
        id: `A-${s.seq}`,
        at: Date.now(),
        actor,
        role,
        action: "disposition.sign",
        batchId,
        detail: `${batch.room} 异常已签认，原值 ${snapshot.perM3} 粒/m³ 与依据 ${snapshot.policyVersion} 冻结`,
      },
    ],
  };
}

export function publishCalibration(
  s: FlowState,
  data: Omit<Calibration, "id" | "createdAt" | "createdBy">,
  actor: string,
  role: Role
): FlowState {
  const cal: Calibration = { ...data, id: `CAL-${s.seq}`, createdAt: Date.now(), createdBy: actor };
  return {
    ...s,
    seq: s.seq + 1,
    calibrations: [...s.calibrations, cal],
    audit: [
      ...s.audit,
      {
        id: `A-${s.seq}`,
        at: Date.now(),
        actor,
        role,
        action: "calibration.publish",
        detail: `仪器 ${cal.instrumentId} 校准系数更新为 ${cal.factor}，未签认异常按新依据重算，已签认保留原值`,
      },
    ],
  };
}

export function publishThreshold(
  s: FlowState,
  data: Omit<ThresholdPolicy, "id" | "createdAt" | "createdBy">,
  actor: string,
  role: Role
): FlowState {
  const pol: ThresholdPolicy = { ...data, id: `POL-${s.seq}`, createdAt: Date.now(), createdBy: actor };
  return {
    ...s,
    seq: s.seq + 1,
    policies: [...s.policies, pol],
    audit: [
      ...s.audit,
      {
        id: `A-${s.seq}`,
        at: Date.now(),
        actor,
        role,
        action: "threshold.publish",
        detail: `发布阈值 ${pol.version}，未签认异常按新依据重算，已签认保留原版本`,
      },
    ],
  };
}

export function setNetwork(s: FlowState, ok: boolean): FlowState {
  return { ...s, networkOk: ok };
}
