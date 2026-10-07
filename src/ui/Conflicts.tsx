// 冲突与上传队列：首份有效入库后到者留草稿；失败批次从断点重试，重放不新增处置/审计

import type { Role, SampleBatch } from "../domain/types";
import { CHANNEL_LABEL } from "../domain/types";
import type { Store } from "../state/store";
import { evaluateBatch } from "../domain/evaluation";
import { fmtDateTime, fmtNum } from "./format";

interface Props {
  store: Store;
  role: Role;
  actor: string;
}

export default function Conflicts({ store, role, actor }: Props) {
  const { state, actions } = store;
  const outbox = state.batches.filter((b) => b.status === "outbox");
  const drafts = state.batches.filter((b) => b.status === "draft");

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>现场 / 中心并发 · 首份有效入库</p>
          <h2>冲突草稿与上传队列</h2>
        </div>
      </div>

      <h3 className="sub-h">上传队列（断点续传）</h3>
          <p className="rule-note">
            重试只推进未完成批次的入库状态；已完成批次不会重复处理，重放
            <strong>不新增处置单、不新增审计记录</strong>。
          </p>
      {outbox.length === 0 ? (
        <p className="empty">队列已清空。可在“提交采样”处关闭“网络正常”制造失败批次。</p>
      ) : (
        <>
          <div className="queue-list">
            {outbox.map((b) => {
              const ev = evaluateBatch(b, {
                instruments: state.instruments,
                calibrations: state.calibrations,
                policies: state.policies,
                dispositions: state.dispositions,
              });
              return (
                <article key={b.id} className="queue-card">
                  <div>
                    <strong>{b.id}</strong>
                    <span className="cell-sub">
                      {b.room} · {b.grade} · {CHANNEL_LABEL[b.channel]} · 采样{" "}
                      {fmtDateTime(b.sampledAt)}
                    </span>
                    <div className="cell-sub">
                      断点：已完成 0/1 批 · 尝试 {b.attempts} 次 · {b.lastError}
                    </div>
                  </div>
                  <div className="queue-side">
                    <span className="tag tag-amber">待上传 · 预览 {fmtNum(ev.perM3)} 粒/m³</span>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="form-actions">
            <button
              className="primary-action"
              disabled={!state.networkOk || role !== "inspector"}
              onClick={() => actions.retryUploads()}
              title={!state.networkOk ? "请先恢复网络" : role !== "inspector" ? "巡检员操作" : ""}
            >
              从断点重试未完成批次
            </button>
            <span className="cell-sub">
              {state.networkOk
                ? "网络已恢复，点击重试后批次入库并进入统一判定"
                : "网络仍中断，重试只会累计尝试次数"}
            </span>
          </div>
        </>
      )}

      <h3 className="sub-h">冲突草稿（后到者）</h3>
      {drafts.length === 0 ? (
        <p className="empty">暂无冲突草稿。用相同房间与采样时刻、另一渠道再提交一次即可复现。</p>
      ) : (
        <div className="queue-list">
          {drafts.map((d) => {
            const winner = state.batches.find((w) => w.id === d.conflictWithId);
            return (
              <DraftCard
                key={d.id}
                draft={d}
                winner={winner}
                canResolve={role === "inspector"}
                actor={actor}
                onDiscard={() => actions.resolveDraft(d.id, "discard", actor, role)}
                onKeepAsNew={(sampledAt) =>
                  actions.resolveDraft(
                    d.id,
                    "resubmit",
                    actor,
                    role,
                    {
                      room: d.room,
                      area: d.area,
                      grade: d.grade,
                      instrumentId: d.instrumentId,
                      sampledAt,
                      durationSec: d.durationSec,
                      rawCount: d.rawCount,
                      channel: d.channel,
                    }
                  )
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function DraftCard({
  draft,
  winner,
  canResolve,
  actor,
  onDiscard,
  onKeepAsNew,
}: {
  draft: SampleBatch;
  winner?: SampleBatch;
  canResolve: boolean;
  actor: string;
  onDiscard: () => void;
  onKeepAsNew: (sampledAt: number) => void;
}) {
  return (
    <article className="queue-card conflict">
      <div>
        <strong>{draft.id}</strong>
        <span className="tag tag-red">冲突 · 留草稿（未入库不判异）</span>
        <div className="cell-sub">
          {draft.room} · {draft.grade} · {CHANNEL_LABEL[draft.channel]} · {draft.submittedBy} ·
          原始 {draft.rawCount} 粒 / {draft.durationSec}s
        </div>
        {winner ? (
          <div className="winner-box">
            首份有效记录：<strong>{winner.id}</strong>（{CHANNEL_LABEL[winner.channel]} ·{" "}
            {winner.submittedBy} · 提交 {fmtDateTime(winner.submittedAt)}）
            <div className="cell-sub">
              本方提交于 {fmtDateTime(draft.submittedAt)}，按首份有效原则未入库
            </div>
          </div>
        ) : null}
      </div>
      {canResolve ? (
        <div className="queue-side col">
          <button className="mini" onClick={() => onKeepAsNew(Date.now())}>
            作为新采样保留（改时刻入库）
          </button>
          <button className="mini ghost" onClick={onDiscard}>
            丢弃草稿
          </button>
        </div>
      ) : (
        <div className="queue-side">
          <span className="cell-sub">巡检员可处理（当前 {actor}）</span>
        </div>
      )}
    </article>
  );
}
