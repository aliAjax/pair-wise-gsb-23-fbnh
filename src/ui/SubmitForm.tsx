// 采样录入：巡检员可提交、补录；实时预览体积换算与当时阈值判定

import { useMemo, useState } from "react";
import type { Role } from "../domain/types";
import {
  AREAS,
  GRADES,
  type Area,
  type Channel,
  type Grade,
} from "../domain/types";
import type { Store } from "../state/store";
import { makeSampleKey } from "../state/store";
import { activePolicy, sampleVolume } from "../domain/evaluation";
import { MIN_VOLUME_L } from "../domain/evaluation";
import { toDatetimeLocalValue } from "./format";

interface Props {
  store: Store;
  role: Role;
  actor: string;
}

const DURATION_PRESETS = [30, 60, 180, 300];

export default function SubmitForm({ store, role, actor }: Props) {
  const { state, actions } = store;
  const instruments = state.instruments;
  const canSubmit = role === "inspector";

  const [room, setRoom] = useState("CR-1208");
  const [area, setArea] = useState<Area>("一般区");
  const [grade, setGrade] = useState<Grade>("ISO 6");
  const [instrumentId, setInstrumentId] = useState(instruments[0].id);
  const [sampledAt, setSampledAt] = useState(
    toDatetimeLocalValue(Date.now() + 2 * 60 * 60 * 1000)
  );
  const [durationSec, setDurationSec] = useState(60);
  const [rawCount, setRawCount] = useState(50);
  const [channel, setChannel] = useState<Channel>("field");
  const [message, setMessage] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(
    null
  );

  const sampledTs = useMemo(() => new Date(sampledAt).getTime() || Date.now(), [sampledAt]);
  const inst = instruments.find((i) => i.id === instrumentId)!;
  const volumeL = sampleVolume(inst.flowLpm, durationSec);
  const belowMin = volumeL < MIN_VOLUME_L;
  const policy = activePolicy(state.policies, Date.now());
  const previewPerM3 = useMemo(() => {
    if (volumeL <= 0) return 0;
    const cal = [...state.calibrations]
      .filter((c) => c.instrumentId === instrumentId)
      .sort((a, b) => b.effectiveAt - a.effectiveAt)[0];
    return Math.round(((rawCount * (cal?.factor ?? 1)) / volumeL) * 1000);
  }, [rawCount, volumeL, state.calibrations, instrumentId]);
  const limit = policy?.limits[grade] ?? null;
  const previewAbnormal = !belowMin && limit !== null && previewPerM3 > limit;

  const existing = state.batches.find(
    (b) => b.sampleKey === makeSampleKey(room, sampledTs) && b.status !== "draft"
  );

  const submit = () => {
    if (!room.trim()) {
      setMessage({ kind: "err", text: "请填写房间编号" });
      return;
    }
    const backfill = Date.now() - sampledTs > 60 * 60 * 1000;
    const r = actions.submitBatch(
      {
        room,
        area,
        grade,
        instrumentId,
        sampledAt: sampledTs,
        durationSec,
        rawCount,
        channel,
        backfill,
      },
      actor,
      role
    );
    if (r.kind === "conflict") {
      setMessage({
        kind: "warn",
        text: `与首份有效记录 ${r.conflictWithId} 为同一次采样：本份已留为草稿，可在“冲突与上传”中查看处理。`,
      });
    } else if (r.kind === "outbox") {
      setMessage({
        kind: "warn",
        text: `批次 ${r.batchId} 进入上传队列（断网），恢复网络后可从断点重试，重放不会重复生成处置。`,
      });
    } else {
      setMessage({
        kind: "ok",
        text: `批次 ${r.batchId} 入库${
          belowMin ? "；体积低于 2L，标记待补采，不参与异常判定" : previewAbnormal ? "；判定异常，进入异常处置（未签认，依据更新会重算）" : "；判定合格"
        }。`,
      });
    }
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>采样录入（30 秒 – 5 分钟）</p>
          <h2>提交一次采样</h2>
        </div>
        <div className="net-switch">
          <label className="inline">
            <input
              type="checkbox"
              checked={state.networkOk}
              onChange={(e) => actions.setNetwork(e.target.checked)}
              disabled={!canSubmit && role !== "engineer"}
            />
            网络正常
          </label>
        </div>
      </div>

      {!canSubmit ? (
        <p className="empty">当前角色为只读/签认角色，采样录入由巡检员操作（右上角切换角色体验）。</p>
      ) : (
        <>
          <div className="form-grid">
            <label>
              <span>房间编号</span>
              <input value={room} onChange={(e) => setRoom(e.target.value)} />
            </label>
            <label>
              <span>区域</span>
              <select value={area} onChange={(e) => setArea(e.target.value as Area)}>
                {AREAS.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
            <label>
              <span>洁净等级</span>
              <select value={grade} onChange={(e) => setGrade(e.target.value as Grade)}>
                {GRADES.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
            <label>
              <span>仪器</span>
              <select
                value={instrumentId}
                onChange={(e) => setInstrumentId(e.target.value)}
              >
                {instruments.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.id} · {i.name}（{i.flowLpm} L/min）
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>采样时刻</span>
              <input
                type="datetime-local"
                value={sampledAt}
                onChange={(e) => setSampledAt(e.target.value)}
              />
            </label>
            <label>
              <span>0.5μm 原始计数（粒）</span>
              <input
                type="number"
                min={0}
                value={rawCount}
                onChange={(e) => setRawCount(Math.max(0, Number(e.target.value) || 0))}
              />
            </label>
            <label>
              <span>采样时长（秒）</span>
              <input
                type="number"
                min={1}
                max={600}
                value={durationSec}
                onChange={(e) => setDurationSec(Math.max(1, Number(e.target.value) || 0))}
              />
              <div className="preset-row">
                {DURATION_PRESETS.map((s) => (
                  <button
                    type="button"
                    key={s}
                    className={durationSec === s ? "chip on" : "chip"}
                    onClick={() => setDurationSec(s)}
                  >
                    {s < 60 ? `${s}秒` : s === 60 ? "1分钟" : `${s / 60}分钟`}
                  </button>
                ))}
              </div>
            </label>
            <label>
              <span>提交渠道</span>
              <div className="seg">
                <button
                  type="button"
                  className={channel === "field" ? "seg-btn on" : "seg-btn"}
                  onClick={() => setChannel("field")}
                >
                  现场
                </button>
                <button
                  type="button"
                  className={channel === "center" ? "seg-btn on" : "seg-btn"}
                  onClick={() => setChannel("center")}
                >
                  中心
                </button>
              </div>
            </label>
          </div>

          <div className={`preview ${belowMin ? "preview-warn" : previewAbnormal ? "preview-danger" : ""}`}>
            <div>
              采样体积 <strong>{volumeL.toFixed(2)} L</strong>
              {belowMin ? (
                <span className="tag tag-amber">低于 {MIN_VOLUME_L} L → 待补采，不判异</span>
              ) : (
                <span className="tag tag-green">≥ {MIN_VOLUME_L} L 参与判定</span>
              )}
            </div>
            <div>
              换算 <strong>{previewPerM3.toLocaleString("zh-CN")}</strong> 粒/m³
              {limit !== null && !belowMin ? (
                <span className={previewAbnormal ? "tag tag-red" : "tag tag-green"}>
                  当时阈值 {policy?.version} ≤ {limit.toLocaleString("zh-CN")} →{" "}
                  {previewAbnormal ? "将判异常" : "合格"}
                </span>
              ) : (
                <span className="tag">阈值版本：{policy?.version ?? "无"}</span>
              )}
            </div>
            <div className="cell-sub">
              {existing
                ? `提示：同一次采样已存在首份有效记录 ${existing.id}（${existing.channel === "field" ? "现场" : "中心"}），提交后本份将留草稿并显示冲突`
                : "同房间+同采样时刻视为同一次采样"}
            </div>
          </div>

          <div className="form-actions">
            <button className="primary-action" onClick={submit}>
              提交采样（{actor}）
            </button>
            {Date.now() - sampledTs > 60 * 60 * 1000 && (
              <span className="tag tag-blue">检测为补录：允许巡检员事后补录并标注</span>
            )}
          </div>
          {message ? <p className={`msg msg-${message.kind}`}>{message.text}</p> : null}
        </>
      )}
    </section>
  );
}
