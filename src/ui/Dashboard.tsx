// 判定看板：KPI、筛选、统一判定表；数据与异常处置/导出同源

import { useMemo, useState } from "react";
import type { Role, SampleBatch } from "../domain/types";
import { AREAS, GRADES, type Area, type Grade } from "../domain/types";
import type { Store } from "../state/store";
import { MIN_VOLUME_L } from "../domain/evaluation";
import BatchTable from "./BatchTable";
import { exportEvaluationsCsv } from "./format";

interface Props {
  store: Store;
  role: Role;
  actor: string;
  onResample: (b: SampleBatch) => void;
}

type Filter = "all" | "abnormal" | "resample" | "signed";

export default function Dashboard({ store, role, actor, onResample }: Props) {
  const { evaluations, state } = store;
  const [grade, setGrade] = useState<Grade | "all">("all");
  const [area, setArea] = useState<Area | "all">("all");
  const [filter, setFilter] = useState<Filter>("all");

  const rows = useMemo(() => {
    return evaluations
      .filter((ev) => !ev.batch.supersededById)
      .filter((ev) => grade === "all" || ev.batch.grade === grade)
      .filter((ev) => area === "all" || ev.batch.area === area)
      .filter((ev) => {
        if (filter === "abnormal") return ev.verdict === "abnormal";
        if (filter === "resample") return ev.verdict === "resample";
        if (filter === "signed") return ev.signed;
        return true;
      })
      .sort((a, b) => b.batch.sampledAt - a.batch.sampledAt);
  }, [evaluations, grade, area, filter]);

  const kpi = useMemo(() => {
    const active = evaluations.filter((ev) => !ev.batch.supersededById);
    const pendingResample = active.filter((ev) => ev.verdict === "resample").length;
    const openAbnormal = active.filter(
      (ev) => ev.verdict === "abnormal" && !ev.signed
    ).length;
    const signed = active.filter((ev) => ev.signed).length;
    const qualified = active.filter((ev) => ev.verdict === "qualified").length;
    return { pendingResample, openAbnormal, signed, qualified, total: active.length };
  }, [evaluations]);

  const doExport = () => {
    exportEvaluationsCsv(
      rows,
      store.draftBatches.map((d) => ({ id: d.id, conflictWithId: d.conflictWithId }))
    );
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>统一判定 · 体积换算每立方米计数 · 适用当时阈值版本</p>
          <h2>判定看板</h2>
        </div>
        <button onClick={doExport}>导出当前视图 CSV</button>
      </div>

      <div className="kpi-row">
        <Kpi label="入库批次" value={kpi.total} tone="neutral" />
        <Kpi label="合格" value={kpi.qualified} tone="ok" />
        <Kpi label={`待补采（< ${MIN_VOLUME_L}L）`} value={kpi.pendingResample} tone="warn" />
        <Kpi label="未签认异常" value={kpi.openAbnormal} tone="danger" />
        <Kpi label="已签认冻结" value={kpi.signed} tone="neutral" />
      </div>

      <div className="filter-row">
        <span className="filter-label">等级</span>
        <button className={grade === "all" ? "chip on" : "chip"} onClick={() => setGrade("all")}>
          全部
        </button>
        {GRADES.map((g) => (
          <button key={g} className={grade === g ? "chip on" : "chip"} onClick={() => setGrade(g)}>
            {g}
          </button>
        ))}
        <span className="filter-label gap">区域</span>
        <button className={area === "all" ? "chip on" : "chip"} onClick={() => setArea("all")}>
          全部
        </button>
        {AREAS.map((a) => (
          <button key={a} className={area === a ? "chip on" : "chip"} onClick={() => setArea(a)}>
            {a}
          </button>
        ))}
      </div>
      <div className="filter-row">
        <span className="filter-label">判定</span>
        {(
          [
            ["all", "全部"],
            ["abnormal", "仅异常"],
            ["resample", "仅待补采"],
            ["signed", "仅已签认"],
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            className={filter === key ? "chip on" : "chip"}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
        <span className="cell-sub gap-left">
          共 {rows.length} 条（与异常处置页、CSV 导出同一判定结果）
        </span>
      </div>

      <BatchTable
        rows={rows}
        instruments={state.instruments}
        action={(ev) =>
          ev.verdict === "resample" && role === "inspector" ? (
            <button className="mini" onClick={() => onResample(ev.batch)}>
              补采
            </button>
          ) : null
        }
      />
    </section>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "warn" | "danger" | "neutral";
}) {
  return (
    <div className={`kpi kpi-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
