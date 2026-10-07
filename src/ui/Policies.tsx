// 校准与阈值政策管理：发布后未签认异常按新依据重算，已签认保留原值原依据

import { useState } from "react";
import type { Role } from "../domain/types";
import { GRADES, type Grade } from "../domain/types";
import type { Store } from "../state/store";
import { fmtDateTime } from "./format";

interface Props {
  store: Store;
  role: Role;
  actor: string;
}

export default function Policies({ store, role, actor }: Props) {
  const { state, actions } = store;
  const canManage = role === "engineer";

  // 新校准
  const [calInstrument, setCalInstrument] = useState(state.instruments[0].id);
  const [factor, setFactor] = useState(1);
  const [calNote, setCalNote] = useState("");

  // 新阈值
  const [version, setVersion] = useState("2026版");
  const baseLimits = { ...state.policies.slice().sort((a, b) => b.effectiveAt - a.effectiveAt)[0].limits };
  const [limits, setLimits] = useState<Record<Grade, number>>(baseLimits);
  const [polNote, setPolNote] = useState("");

  const publishCal = () => {
    actions.publishCalibration(
      {
        instrumentId: calInstrument,
        effectiveAt: Date.now(),
        factor,
        note: calNote || `校准系数更新为 ${factor}`,
      },
      actor,
      role
    );
    setCalNote("");
  };

  const publishPol = () => {
    actions.publishThreshold(
      {
        version,
        effectiveAt: Date.now(),
        note: polNote || `发布 ${version}`,
        limits,
      },
      actor,
      role
    );
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>判定依据版本化</p>
          <h2>仪器校准与阈值政策</h2>
        </div>
      </div>

      <div className="policy-grid">
        <div>
          <h3 className="sub-h">校准记录（现行系数取每台仪器最新一条）</h3>
          <div className="policy-list">
            {state.instruments.map((inst) => {
              const cals = state.calibrations
                .filter((c) => c.instrumentId === inst.id)
                .sort((a, b) => b.effectiveAt - a.effectiveAt);
              return (
                <article key={inst.id} className="policy-card">
                  <header>
                    <strong>{inst.id}</strong>
                    <span className="cell-sub">
                      {inst.name} · 标称 {inst.flowLpm} L/min
                    </span>
                  </header>
                  {cals.map((c, i) => (
                    <div key={c.id} className={i === 0 ? "policy-row current" : "policy-row"}>
                      <span className={`tag ${i === 0 ? "tag-green" : ""}`}>
                        系数 {c.factor}
                      </span>
                      <span className="cell-sub">生效 {fmtDateTime(c.effectiveAt)}</span>
                      <span className="cell-sub">{c.note}</span>
                    </div>
                  ))}
                </article>
              );
            })}
          </div>

          {canManage ? (
            <div className="inline-form">
              <h4>发布新校准</h4>
              <div className="form-grid compact">
                <label>
                  <span>仪器</span>
                  <select value={calInstrument} onChange={(e) => setCalInstrument(e.target.value)}>
                    {state.instruments.map((i) => (
                      <option key={i.id}>{i.id}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>修正系数</span>
                  <input
                    type="number"
                    step={0.01}
                    value={factor}
                    onChange={(e) => setFactor(Number(e.target.value))}
                  />
                </label>
                <label className="wide">
                  <span>说明</span>
                  <input value={calNote} onChange={(e) => setCalNote(e.target.value)} placeholder="如：送检后修正为 1.06" />
                </label>
              </div>
              <button className="primary-action" onClick={publishCal}>
                发布并触发未签认重算
              </button>
            </div>
          ) : (
            <p className="cell-sub">仅厂务工程师可发布校准。</p>
          )}
        </div>

        <div>
          <h3 className="sub-h">阈值版本（未签认记录按当前有效版本判定）</h3>
          <div className="policy-list">
            {state.policies
              .slice()
              .sort((a, b) => b.effectiveAt - a.effectiveAt)
              .map((p, i) => (
                <article key={p.id} className={`policy-card ${i === 0 ? "current-card" : ""}`}>
                  <header>
                    <strong>{p.version}</strong>
                    {i === 0 ? <span className="tag tag-green">现行</span> : null}
                    <span className="cell-sub">生效 {fmtDateTime(p.effectiveAt)}</span>
                  </header>
                  <div className="limit-row">
                    {GRADES.map((g) => (
                      <span key={g} className="limit-chip">
                        {g}：≤ {p.limits[g].toLocaleString("zh-CN")}
                      </span>
                    ))}
                  </div>
                  <p className="cell-sub">{p.note}</p>
                </article>
              ))}
          </div>

          {canManage ? (
            <div className="inline-form">
              <h4>发布新阈值版本</h4>
              <div className="form-grid compact">
                <label className="wide">
                  <span>版本名</span>
                  <input value={version} onChange={(e) => setVersion(e.target.value)} />
                </label>
                {GRADES.map((g) => (
                  <label key={g}>
                    <span>{g} 上限（粒/m³）</span>
                    <input
                      type="number"
                      value={limits[g]}
                      onChange={(e) =>
                        setLimits((m) => ({ ...m, [g]: Number(e.target.value) }))
                      }
                    />
                  </label>
                ))}
                <label className="wide">
                  <span>说明</span>
                  <input value={polNote} onChange={(e) => setPolNote(e.target.value)} />
                </label>
              </div>
              <button className="primary-action" onClick={publishPol}>
                立即发布（影响所有未签认记录）
              </button>
            </div>
          ) : (
            <p className="cell-sub">仅厂务工程师可发布阈值版本。</p>
          )}
        </div>
      </div>
    </section>
  );
}
