import { useMemo, useReducer, useRef, useState } from "react";
import "./styles.css";
import { CleanroomStore, PermissionError } from "./domain/store";
import {
  actors,
  calibrationV2,
  createSeededStore,
  pendingUploads,
  policyV2,
} from "./domain/seed";
import type { Actor, BatchRecord, Disposition } from "./domain/types";
import { DISPOSITION_LABEL, ROLE_LABEL, STATUS_LABEL } from "./domain/types";

const ROLE_ORDER: Actor[] = [actors.inspector, actors.teamLead, actors.auditor];

const STATUS_CLASS: Record<string, string> = {
  normal: "chip-ok",
  exceeded: "chip-danger",
  pending_resample: "chip-warn",
};

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
  });
}

function fmtNum(n: number | null | undefined) {
  return n == null ? "-" : n.toLocaleString();
}

interface UploadState {
  phase: "idle" | "failed" | "done";
  log: string[];
}

function App() {
  const seeded = useRef(createSeededStore());
  const store: CleanroomStore = seeded.current.store;
  const [, bump] = useReducer((x: number) => x + 1, 0);

  const [actor, setActor] = useState<Actor>(actors.inspector);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadState>({ phase: "idle", log: [] });
  const [policyPublished, setPolicyPublished] = useState(false);
  const [calibrationAdded, setCalibrationAdded] = useState(false);
  const [supplemented, setSupplemented] = useState(false);
  const [ackNote, setAckNote] = useState("已确认，安排复测");

  const snap = store.snapshot();
  const metrics = store.metrics();
  const canWrite = actor.role !== "auditor";
  const canLead = actor.role === "team_lead";

  const run = (fn: () => void) => {
    try {
      setError(null);
      fn();
    } catch (e) {
      setError(e instanceof PermissionError ? e.message : String(e));
    } finally {
      bump();
    }
  };

  // 第一次上传：U-01、U-02 服务端已入库，但客户端只收到 U-01 的确认即断线
  const simulateUpload = () =>
    run(() => {
      const log: string[] = [];
      for (const b of pendingUploads.slice(0, 2)) {
        const r = store.ingest(actor, b);
        log.push(`${b.id} 服务端已${r.outcome === "stored" ? "入库" : "处理"}`);
      }
      log.push("✕ 网络中断：U-02 的确认包丢失，U-02/U-03/U-04 标记为未完成");
      setUpload({ phase: "failed", log });
    });

  // 断点重试：只重发未完成批次；U-02 为重放，不新增处置或审计
  const retryUpload = () =>
    run(() => {
      const auditBefore = snap.audit.length;
      const dispBefore = snap.dispositions.length;
      const log = [...upload.log];
      for (const b of pendingUploads.slice(1)) {
        const r = store.ingest(actor, b);
        if (r.outcome === "replayed") {
          log.push(`↻ ${b.id} 重放：服务端已有此批次，未新增处置或审计`);
        } else if (r.outcome === "draft_conflict") {
          log.push(`⚠ ${b.id} 与已入库批次 ${r.record.conflictWith} 为同一次采样，留作冲突草稿`);
        } else {
          log.push(`✓ ${b.id} 入库：${STATUS_LABEL[r.record.determination!.status]}`);
        }
      }
      log.push(
        `重试完成：审计 +${store.snapshot().audit.length - auditBefore} 条，处置 +${store.snapshot().dispositions.length - dispBefore} 条（重放部分为 0）`
      );
      setUpload({ phase: "done", log });
    });

  const exportCsv = () => {
    const blob = new Blob(["﻿" + store.exportCsv()], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "洁净室判定导出.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const recordOf = (batchId: string): BatchRecord | undefined =>
    snap.records.find((r) => r.batch.id === batchId);

  const dispositions = useMemo(
    () =>
      [...snap.dispositions].sort((a, b) =>
        a.status === b.status ? a.id.localeCompare(b.id) : a.status === "open" ? -1 : 1
      ),
    [snap.dispositions]
  );

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-09 · 统一判定引擎</p>
          <h1>半导体洁净室巡检</h1>
          <p className="subtitle">
            采样批次、仪器校准、阈值政策与异常处置共用同一套判定：按体积换算每立方米计数，
            采用采样当时的阈值版本；低于 2 升待补采；依据更新后未签认重算、已签认冻结。
          </p>
        </div>
        <div className="stack-card">
          <span>当前角色（巡检员可补录 · 班组长可签认 · 审计员只读）</span>
          <div className="role-switch">
            {ROLE_ORDER.map((a) => (
              <button
                key={a.id}
                className={actor.id === a.id ? "role-active" : ""}
                onClick={() => setActor(a)}
              >
                {ROLE_LABEL[a.role]} {a.name}
              </button>
            ))}
          </div>
        </div>
      </section>

      {error && <div className="banner-error">⚠ {error}</div>}

      <section className="metrics-grid">
        <article className="metric-card">
          <span>在库批次</span>
          <strong>{metrics.stored}</strong>
          <i className="status-ok" />
        </article>
        <article className="metric-card">
          <span>超限未签认</span>
          <strong>{metrics.exceededOpen}</strong>
          <i className="status-danger" />
        </article>
        <article className="metric-card">
          <span>待补采（&lt;2L）</span>
          <strong>{metrics.pendingResample}</strong>
          <i className="status-watch" />
        </article>
        <article className="metric-card">
          <span>冲突草稿</span>
          <strong>{metrics.conflictDrafts}</strong>
          <i className="status-draft" />
        </article>
      </section>

      <section className="workspace">
        <section className="panel">
          <div className="section-heading">
            <div>
              <p>采样批次</p>
              <h2>判定一览</h2>
            </div>
            <button className="primary-action" onClick={exportCsv}>
              导出 CSV（与看板同一判定）
            </button>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>批次</th>
                <th>采样点 / 等级</th>
                <th>体积(L)</th>
                <th>计数(个/m³)</th>
                <th>限值</th>
                <th>判定</th>
                <th>依据（阈值/校准）</th>
                <th>来源</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {snap.records.map((r) => {
                const d = r.determination;
                const isDraft = r.state === "draft_conflict";
                return (
                  <tr key={r.batch.id} className={isDraft ? "row-draft" : ""}>
                    <td>
                      {r.batch.id}
                      {r.batch.isSupplement && <em className="tag">补录</em>}
                      {r.frozen && <em className="tag tag-lock">已签认冻结</em>}
                    </td>
                    <td>
                      {r.batch.pointId} · {r.batch.roomClass} · {r.batch.particleSizeUm}µm
                    </td>
                    <td>{d ? d.volumeL.toFixed(2) : "-"}</td>
                    <td>{d ? fmtNum(d.countsPerM3) : "-"}</td>
                    <td>{d ? fmtNum(d.thresholdPerM3) : "-"}</td>
                    <td>
                      {isDraft ? (
                        <span className="chip chip-draft">冲突草稿</span>
                      ) : (
                        <span className={`chip ${STATUS_CLASS[d!.status]}`}>
                          {STATUS_LABEL[d!.status]}
                        </span>
                      )}
                    </td>
                    <td className="basis">
                      {isDraft
                        ? `与 ${r.conflictWith} 重复，不参与判定`
                        : `${d?.policyId ?? "-"} v${d?.policyVersion ?? "-"} / ${d?.calibrationId ?? "-"}`}
                    </td>
                    <td>{r.batch.source === "field" ? "现场" : "中心"}</td>
                    <td>
                      {d?.status === "pending_resample" && !supplemented && (
                        <button
                          disabled={!canWrite}
                          title={canWrite ? "补录一份足量采样" : "当前角色只读"}
                          onClick={() =>
                            run(() => {
                              const b = seeded.current.supplementFor(r.batch.id);
                              if (b) store.ingest(actor, b);
                              setSupplemented(true);
                            })
                          }
                        >
                          补录
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="upload-box">
            <div className="section-heading">
              <div>
                <p>上传中心</p>
                <h2>断点续传演示（4 个待传批次）</h2>
              </div>
              <div className="btn-row">
                <button
                  onClick={simulateUpload}
                  disabled={!canWrite || upload.phase !== "idle"}
                >
                  模拟上传（中途断线）
                </button>
                <button
                  className="primary-action"
                  onClick={retryUpload}
                  disabled={!canWrite || upload.phase !== "failed"}
                >
                  从断点重试未完成批次
                </button>
              </div>
            </div>
            {upload.log.length > 0 && (
              <ul className="log-list">
                {upload.log.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <aside className="panel narrow">
          <h2>判定依据</h2>
          <p className="muted">
            当前阈值：{snap.policies[snap.policies.length - 1].id} v
            {snap.policies[snap.policies.length - 1].version}（
            {snap.policies[snap.policies.length - 1].note}）
          </p>
          <p className="muted">
            校准：{snap.calibrations.map((c) => `${c.id}(×${c.correctionFactor})`).join("、")}
          </p>
          <div className="btn-col">
            <button
              disabled={!canLead || policyPublished}
              title={canLead ? "发布后未签认异常按新依据重算" : "需班组长"}
              onClick={() =>
                run(() => {
                  store.publishPolicy(actor, policyV2);
                  setPolicyPublished(true);
                })
              }
            >
              发布加严阈值 TP-2026Q4（ISO5→3000）
            </button>
            <button
              disabled={!canLead || calibrationAdded}
              title={canLead ? "录入后未签认异常按新系数重算" : "需班组长"}
              onClick={() =>
                run(() => {
                  store.addCalibration(actor, calibrationV2);
                  setCalibrationAdded(true);
                })
              }
            >
              录入 P-01 新校准（×0.92）
            </button>
          </div>
          <p className="muted small">
            依据更新只重算未签认批次；已签认（如 B-2604）保留原值和依据。
          </p>

          <h2>审计日志</h2>
          <ul className="audit-list">
            {[...snap.audit].reverse().slice(0, 14).map((e) => (
              <li key={e.seq}>
                <span className="audit-meta">
                  #{e.seq} {fmtTime(e.at)} · {e.actor}
                </span>
                <span>{e.detail}</span>
              </li>
            ))}
          </ul>
        </aside>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>异常处置</p>
            <h2>处置单（与看板、导出同一判定）</h2>
          </div>
          {canLead && (
            <input
              value={ackNote}
              onChange={(e) => setAckNote(e.target.value)}
              placeholder="签认意见"
              className="ack-input"
            />
          )}
        </div>
        {dispositions.length === 0 && <p className="muted">当前无异常。</p>}
        <div className="record-list">
          {dispositions.map((d: Disposition) => {
            const rec = recordOf(d.batchId);
            const shown =
              d.status === "acknowledged" && d.snapshot
                ? d.snapshot
                : rec?.determination ?? null;
            return (
              <article key={d.id} className="record-card">
                <div className={`record-index idx-${d.status}`}>{d.id}</div>
                <div className="disposition-body">
                  <h3>
                    批次 {d.batchId} · {rec?.batch.pointId} ·{" "}
                    <span className={`chip chip-disp-${d.status}`}>
                      {DISPOSITION_LABEL[d.status]}
                    </span>
                  </h3>
                  <p>
                    {shown
                      ? `${fmtNum(shown.countsPerM3)} 个/m³（限值 ${fmtNum(
                          shown.thresholdPerM3
                        )}）· 依据 ${shown.policyId} v${shown.policyVersion} / ${shown.calibrationId}`
                      : "—"}
                    {d.status === "acknowledged" &&
                      ` · ${d.acknowledgedBy} 签认：${d.note}（原值与依据已冻结）`}
                    {d.status === "closed" && " · 重算后不再超限，自动关闭"}
                  </p>
                </div>
                {d.status === "open" && (
                  <button
                    className="primary-action"
                    disabled={!canLead}
                    title={canLead ? "签认并冻结原值与依据" : "需班组长签认"}
                    onClick={() => run(() => store.acknowledge(actor, d.batchId, ackNote))}
                  >
                    签认
                  </button>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}

export default App;
