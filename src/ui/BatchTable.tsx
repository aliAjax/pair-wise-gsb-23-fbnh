// 统一判定表：看板、异常处置、导出使用同一份 evaluations 数据

import type { BatchEvaluation } from "../domain/evaluation";
import type { Instrument } from "../domain/types";
import { CHANNEL_LABEL } from "../domain/types";
import { fmtDateTime, fmtNum, verdictClass, verdictText } from "./format";

interface Props {
  rows: BatchEvaluation[];
  instruments: Instrument[];
  action?: (ev: BatchEvaluation) => React.ReactNode;
  emptyText?: string;
}

export default function BatchTable({ rows, instruments, action, emptyText }: Props) {
  if (rows.length === 0) {
    return <p className="empty">{emptyText ?? "暂无记录"}</p>;
  }

  const instName = (id: string) =>
    instruments.find((i) => i.id === id)?.id ?? id;

  return (
    <div className="table-wrap">
      <table className="batch-table">
        <thead>
          <tr>
            <th>批次 / 房间</th>
            <th>采样</th>
            <th>体积 / 时长</th>
            <th>原始计数</th>
            <th>系数</th>
            <th>粒/m³</th>
            <th>阈值(版本)</th>
            <th>判定</th>
            <th>状态</th>
            {action ? <th>操作</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((ev) => {
            const b = ev.batch;
            const superseded = !!b.supersededById;
            return (
              <tr
                key={b.id}
                className={superseded ? "row-dim" : ""}
                title={ev.basis}
              >
                <td>
                  <div className="cell-id">
                    {b.id}
                    {b.backfill ? <span className="tag tag-blue">补录</span> : null}
                    {b.supersedesId ? (
                      <span className="tag tag-blue">补采</span>
                    ) : null}
                  </div>
                  <div className="cell-sub">
                    {b.room} · {b.area} · {b.grade}
                  </div>
                </td>
                <td>
                  <div>{fmtDateTime(b.sampledAt)}</div>
                  <div className="cell-sub">
                    {CHANNEL_LABEL[b.channel]} · {instName(b.instrumentId)}
                  </div>
                </td>
                <td>
                  <div>{ev.volumeL.toFixed(2)} L</div>
                  <div className="cell-sub">{b.durationSec}s</div>
                </td>
                <td className="num">{fmtNum(b.rawCount)}</td>
                <td className="num">{ev.factor ?? "—"}</td>
                <td className="num strong">{fmtNum(ev.perM3)}</td>
                <td>
                  <div className="num">{ev.limit !== null ? fmtNum(ev.limit) : "—"}</div>
                  <div className="cell-sub">{ev.active?.policyVersion ?? "—"}</div>
                </td>
                <td>
                  <span className={`badge ${verdictClass(ev.verdict)}`}>
                    {verdictText(ev.verdict)}
                  </span>
                </td>
                <td>
                  {superseded ? (
                    <span className="tag">已补采 {b.supersededById}</span>
                  ) : ev.verdict === "resample" ? (
                    <span className="tag tag-amber">等待补采</span>
                  ) : ev.signed ? (
                    <div>
                      <span className="tag tag-green">已签认</span>
                      <div className="cell-sub">
                        {ev.disposition?.signedBy}
                        {ev.disposition?.signedAt
                          ? " " + fmtDateTime(ev.disposition.signedAt)
                          : ""}
                      </div>
                      {ev.live &&
                      (ev.live.perM3 !== ev.perM3 ||
                        ev.live.policyVersion !== ev.active?.policyVersion ||
                        ev.live.factor !== ev.factor) ? (
                        <div className="drift">
                          现行重算 {fmtNum(ev.live.perM3)}（{ev.live.policyVersion}
                          /系数{ev.live.factor}），签认值保留
                        </div>
                      ) : null}
                    </div>
                  ) : ev.verdict === "abnormal" ? (
                    <span className="tag tag-red">待签认</span>
                  ) : (
                    <span className="tag">—</span>
                  )}
                </td>
                {action ? <td>{action(ev)}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
