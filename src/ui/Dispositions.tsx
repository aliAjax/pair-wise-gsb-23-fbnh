// 异常处置：未签认异常按最新依据重算；班组长签认后冻结原值与依据

import { useMemo, useState } from "react";
import type { Role } from "../domain/types";
import type { Store } from "../state/store";
import { fmtDateTime, fmtNum, exportEvaluationsCsv } from "./format";

interface Props {
  store: Store;
  role: Role;
  actor: string;
}

export default function Dispositions({ store, role, actor }: Props) {
  const { evaluations } = store;
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<string | null>(null);

  const abnormal = useMemo(
    () =>
      evaluations
        .filter((ev) => ev.verdict === "abnormal")
        .sort(
          (a, b) => Number(a.signed) - Number(b.signed) || b.batch.sampledAt - a.batch.sampledAt
        ),
    [evaluations]
  );

  const sign = (batchId: string) => {
    const ok = store.actions.signDisposition(batchId, remarks[batchId] ?? "", actor, role);
    setFlash(
      ok
        ? `已签认 ${batchId}：当前判定原值与依据冻结，今后校准/阈值更新不再改变该记录。`
        : `签认失败：${batchId} 不是可签认的异常批次`
    );
  };

  const doExport = () => {
    exportEvaluationsCsv(
      abnormal,
      [],
      `异常处置清单_${new Date().toISOString().slice(0, 10)}.csv`
    );
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>同一判定内核 · 看板/处置/导出一致</p>
          <h2>异常处置</h2>
        </div>
        <button onClick={doExport}>导出异常清单 CSV</button>
      </div>

      <p className="rule-note">
        规则：校准系数或阈值版本更新后，<strong>未签认</strong>异常自动按新依据重算；
        <strong>已签认</strong>异常保留签认时的原值、阈值版本与校准系数（冻结），仅旁示现行重算值。
        低于 2 L 的批次不进入异常列表。
      </p>

      {abnormal.length === 0 ? <p className="empty">当前无异常批次。</p> : null}

      <div className="dsp-list">
        {abnormal.map((ev) => {
          const b = ev.batch;
          return (
            <article key={b.id} className={`dsp-card ${ev.signed ? "signed" : ""}`}>
              <header>
                <div>
                  <strong>{b.id}</strong>
                  <span className="cell-sub">
                    {b.room} · {b.grade} · 采样于 {fmtDateTime(b.sampledAt)}
                  </span>
                </div>
                {ev.signed ? (
                  <span className="tag tag-green">已签认 · {ev.disposition?.signedBy}</span>
                ) : (
                  <span className="tag tag-red">未签认 · 依据更新自动重算</span>
                )}
              </header>

              <div className="dsp-grid">
                <div>
                  <span className="cell-sub">采样体积</span>
                  <strong>{ev.volumeL.toFixed(2)} L</strong>
                </div>
                <div>
                  <span className="cell-sub">{ev.signed ? "签认时计数（保留原值）" : "现行计数"}</span>
                  <strong className="text-danger">{fmtNum(ev.perM3)} 粒/m³</strong>
                </div>
                <div>
                  <span className="cell-sub">
                    {ev.signed ? "签认阈值（保留原版本）" : "当前有效阈值版本"}
                  </span>
                  <strong>
                    ≤ {fmtNum(ev.limit)}（{ev.active?.policyVersion}）
                  </strong>
                </div>
                <div>
                  <span className="cell-sub">校准系数</span>
                  <strong>{ev.factor}</strong>
                </div>
              </div>

              <p className="basis">判定依据：{ev.basis}</p>

              {ev.signed && ev.live ? (
                <p className="drift-box">
                  现行依据重算为 {fmtNum(ev.live.perM3)} 粒/m³（{ev.live.policyVersion}
                  ，系数 {ev.live.factor}，阈值 {fmtNum(ev.live.limit)}）。已签认记录保留原值，不随之变更。
                </p>
              ) : null}

              {ev.disposition?.remark ? (
                <p className="remark">处置备注：{ev.disposition.remark}</p>
              ) : null}

              {!ev.signed ? (
                <div className="dsp-actions">
                  <input
                    placeholder="处置备注（原因、措施、复测安排）"
                    value={remarks[b.id] ?? ev.disposition?.remark ?? ""}
                    onChange={(e) => setRemarks((m) => ({ ...m, [b.id]: e.target.value }))}
                  />
                  <button
                    className="primary-action"
                    disabled={role !== "leader"}
                    title={role !== "leader" ? "仅班组长可签认" : ""}
                    onClick={() => sign(b.id)}
                  >
                    班组长签认
                  </button>
                </div>
              ) : (
                <p className="cell-sub">
                  签认时间 {ev.disposition?.signedAt ? fmtDateTime(ev.disposition.signedAt) : "—"}
                </p>
              )}
            </article>
          );
        })}
      </div>

      {flash ? <p className="msg msg-ok">{flash}</p> : null}
    </section>
  );
}
