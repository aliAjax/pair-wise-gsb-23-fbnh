// 审计日志：所有角色只读；重放/重算不新增审计

import { useMemo, useState } from "react";
import type { AuditAction } from "../domain/types";
import { AUDIT_ACTION_LABEL, ROLE_LABEL } from "../domain/types";
import type { Store } from "../state/store";
import { fmtDateTime } from "./format";

const ACTIONS: AuditAction[] = [
  "batch.submit",
  "batch.backfill",
  "batch.resample",
  "disposition.auto",
  "disposition.sign",
  "calibration.publish",
  "threshold.publish",
  "conflict.draft",
  "conflict.resolve",
  "reset",
];

export default function AuditLog({ store }: { store: Store }) {
  const [action, setAction] = useState<AuditAction | "all">("all");
  const rows = useMemo(
    () =>
      store.state.audit
        .filter((e) => action === "all" || e.action === action)
        .sort((a, b) => b.at - a.at),
    [store.state.audit, action]
  );

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>审计员只读 · 断点重试与自动重算不产生审计</p>
          <h2>审计日志</h2>
        </div>
      </div>
      <div className="filter-row">
        <button className={action === "all" ? "chip on" : "chip"} onClick={() => setAction("all")}>
          全部
        </button>
        {ACTIONS.map((a) => (
          <button
            key={a}
            className={action === a ? "chip on" : "chip"}
            onClick={() => setAction(a)}
          >
            {AUDIT_ACTION_LABEL[a]}
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <table className="batch-table audit-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>操作人 / 角色</th>
              <th>动作</th>
              <th>批次</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">{fmtDateTime(e.at)}</td>
                <td>
                  {e.actor}
                  <div className="cell-sub">{ROLE_LABEL[e.role]}</div>
                </td>
                <td>
                  <span className="tag">{AUDIT_ACTION_LABEL[e.action]}</span>
                </td>
                <td className="nowrap">{e.batchId ?? "—"}</td>
                <td>{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
