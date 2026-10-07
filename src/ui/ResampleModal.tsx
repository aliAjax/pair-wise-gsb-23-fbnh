// 补采弹窗：仅对低于 2L 的批次；补采批次入库后原批次标记已补采，不再判异

import { useMemo, useState } from "react";
import type { Role, SampleBatch } from "../domain/types";
import { AREAS, GRADES } from "../domain/types";
import type { Store } from "../state/store";
import { MIN_VOLUME_L, activePolicy, sampleVolume } from "../domain/evaluation";
import { fmtDateTime, toDatetimeLocalValue } from "./format";

interface Props {
  store: Store;
  original: SampleBatch | null;
  role: Role;
  actor: string;
  onClose: () => void;
}

export default function ResampleModal({ store, original, role, actor, onClose }: Props) {
  const [durationSec, setDurationSec] = useState(120);
  const [rawCount, setRawCount] = useState(0);
  const [sampledAt, setSampledAt] = useState(toDatetimeLocalValue(Date.now()));
  const [done, setDone] = useState<string | null>(null);

  const inst = useMemo(
    () => store.state.instruments.find((i) => i.id === (original?.instrumentId ?? "")),
    [store.state.instruments, original?.instrumentId]
  );

  if (!original || !inst) return null;

  const sampledTs = new Date(sampledAt).getTime() || Date.now();
  const volumeL = sampleVolume(inst.flowLpm, durationSec);
  const belowMin = volumeL < MIN_VOLUME_L;
  const policy = activePolicy(store.state.policies, Date.now());
  const perM3 = volumeL > 0 ? Math.round((rawCount / volumeL) * 1000) : 0;
  const limit = policy?.limits[original.grade] ?? null;
  const abnormal = !belowMin && limit !== null && perM3 > limit;

  const submit = () => {
    if (belowMin) return;
    const id = store.actions.submitResample(
      original.id,
      {
        room: original.room,
        area: original.area,
        grade: original.grade,
        instrumentId: original.instrumentId,
        sampledAt: sampledTs,
        durationSec,
        rawCount,
        channel: original.channel,
      },
      actor,
      role
    );
    setDone(id);
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="section-heading">
          <div>
            <p>补采（原批次体积不足）</p>
            <h2>{original.id} · {original.room}</h2>
          </div>
          <button onClick={onClose}>关闭</button>
        </div>

        {done ? (
          <div>
            <p className="msg msg-ok">
              补采批次 {done} 已入库，原批次 {original.id} 标记为已补采；补采批次按{" "}
              {policy?.version} 阈值{abnormal ? "判定异常" : "判定合格"}。
            </p>
            <button className="primary-action" onClick={onClose}>
              完成
            </button>
          </div>
        ) : (
          <>
            <p className="cell-sub">
              原批次采样时刻 {fmtDateTime(original.sampledAt)}，时长 {original.durationSec}s，
              体积 {sampleVolume(inst.flowLpm, original.durationSec).toFixed(2)} L（低于 {MIN_VOLUME_L} L，未参与异常判定）。
            </p>
            <div className="form-grid compact">
              <label>
                <span>补采时刻</span>
                <input
                  type="datetime-local"
                  value={sampledAt}
                  onChange={(e) => setSampledAt(e.target.value)}
                />
              </label>
              <label>
                <span>时长（秒，≥ {Math.ceil((MIN_VOLUME_L / inst.flowLpm) * 60)}s 才够 2L）</span>
                <input
                  type="number"
                  min={1}
                  value={durationSec}
                  onChange={(e) => setDurationSec(Number(e.target.value) || 0)}
                />
              </label>
              <label>
                <span>0.5μm 计数</span>
                <input
                  type="number"
                  min={0}
                  value={rawCount}
                  onChange={(e) => setRawCount(Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
            </div>
            <div className="form-grid compact">
              <div className="readonly-cell">区域 {AREAS.find((a) => a === original.area)}</div>
              <div className="readonly-cell">等级 {GRADES.find((g) => g === original.grade)}</div>
              <div className="readonly-cell">仪器 {inst.id}</div>
            </div>
            <div className={`preview ${belowMin ? "preview-warn" : abnormal ? "preview-danger" : ""}`}>
              体积 <strong>{volumeL.toFixed(2)} L</strong> · 换算{" "}
              <strong>{perM3.toLocaleString("zh-CN")}</strong> 粒/m³ · 当时阈值{" "}
              {policy?.version}
              {limit !== null ? ` ≤ ${limit.toLocaleString("zh-CN")}` : ""}
              {belowMin ? (
                <span className="tag tag-amber">仍低于 {MIN_VOLUME_L} L，不能提交</span>
              ) : abnormal ? (
                <span className="tag tag-red">将判异常</span>
              ) : (
                <span className="tag tag-green">将判合格</span>
              )}
            </div>
            <div className="form-actions">
              <button className="primary-action" disabled={belowMin} onClick={submit}>
                提交补采
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
