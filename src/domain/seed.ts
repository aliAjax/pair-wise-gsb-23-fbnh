/**
 * 演示数据：围绕“今天（2026-10-07）”的一次早班巡检。
 * 覆盖：体积换算、当时阈值版本、<2L 待补采、现场/中心冲突、
 *       断点重试重放、校准与阈值更新后的未签认重算、已签认冻结。
 */
import { CleanroomStore } from "./store";
import type { Actor, Calibration, SampleBatch, ThresholdPolicy } from "./types";

export const actors: Record<string, Actor> = {
  inspector: { id: "u-chen", name: "陈洁", role: "inspector" },
  teamLead: { id: "u-wang", name: "王磊", role: "team_lead" },
  auditor: { id: "u-zhao", name: "赵敏", role: "auditor" },
};

const FLOW = 2.83; // 0.1 CFM 标准粒子计数器，升/分钟

export const policyV1: ThresholdPolicy = {
  id: "TP-2026H2",
  version: 1,
  effectiveFrom: "2026-07-01T00:00:00+08:00",
  note: "ISO 14644-1 限值",
  limits: [
    { roomClass: "ISO 5", particleSizeUm: 0.5, maxPerM3: 3520 },
    { roomClass: "ISO 6", particleSizeUm: 0.5, maxPerM3: 35200 },
    { roomClass: "ISO 7", particleSizeUm: 0.5, maxPerM3: 352000 },
    { roomClass: "ISO 5", particleSizeUm: 5, maxPerM3: 29 },
    { roomClass: "ISO 6", particleSizeUm: 5, maxPerM3: 293 },
    { roomClass: "ISO 7", particleSizeUm: 5, maxPerM3: 2930 },
  ],
};

/** 演示用加严阈值（班组长发布后触发未签认重算） */
export const policyV2: ThresholdPolicy = {
  id: "TP-2026Q4",
  version: 2,
  effectiveFrom: "2026-10-01T00:00:00+08:00",
  note: "客户要求加严内控",
  limits: [
    { roomClass: "ISO 5", particleSizeUm: 0.5, maxPerM3: 3000 },
    { roomClass: "ISO 6", particleSizeUm: 0.5, maxPerM3: 30000 },
    { roomClass: "ISO 7", particleSizeUm: 0.5, maxPerM3: 320000 },
    { roomClass: "ISO 5", particleSizeUm: 5, maxPerM3: 25 },
    { roomClass: "ISO 6", particleSizeUm: 5, maxPerM3: 260 },
    { roomClass: "ISO 7", particleSizeUm: 5, maxPerM3: 2600 },
  ],
};

export const calibrationBase: Calibration[] = [
  {
    id: "CAL-260901",
    instrumentId: "P-01",
    calibratedAt: "2026-09-01T00:00:00+08:00",
    correctionFactor: 1.0,
    certificateNo: "QC-2026-091",
  },
  {
    id: "CAL-260902",
    instrumentId: "P-02",
    calibratedAt: "2026-09-01T00:00:00+08:00",
    correctionFactor: 1.0,
    certificateNo: "QC-2026-092",
  },
];

/** 演示用新校准：P-01 读数偏高 8%，系数 ×0.92，生效覆盖今日批次 */
export const calibrationV2: Calibration = {
  id: "CAL-261006",
  instrumentId: "P-01",
  calibratedAt: "2026-10-06T00:00:00+08:00",
  correctionFactor: 0.92,
  certificateNo: "QC-2026-118",
};

function batch(partial: Partial<SampleBatch> & Pick<SampleBatch, "id" | "pointId" | "roomClass" | "sampledAt" | "rawCount" | "durationSec">): SampleBatch {
  return {
    samplingKey: `${partial.pointId}|${partial.sampledAt}`,
    instrumentId: "P-01",
    particleSizeUm: 0.5,
    flowRateLpm: FLOW,
    source: "field",
    submittedBy: actors.inspector.name,
    ...partial,
  };
}

/** 断点续传演示队列：U-02 的确认包会“丢失”，重试时重放它 */
export const pendingUploads: SampleBatch[] = [
  batch({ id: "U-01", pointId: "CR-2107", roomClass: "ISO 6", sampledAt: "2026-10-07T09:40:00+08:00", durationSec: 60, rawCount: 95 }),
  batch({ id: "U-02", pointId: "CR-1201", roomClass: "ISO 5", sampledAt: "2026-10-07T09:46:00+08:00", durationSec: 60, rawCount: 14 }),
  batch({ id: "U-03", pointId: "CR-3105", roomClass: "ISO 7", sampledAt: "2026-10-07T09:52:00+08:00", durationSec: 45, rawCount: 700 }),
  // 中心系统对 B-2605 同一次采样的重复上报 → 冲突草稿
  batch({ id: "U-04", pointId: "CR-1201", roomClass: "ISO 5", sampledAt: "2026-10-07T09:05:00+08:00", durationSec: 60, rawCount: 9, source: "center", submittedBy: "中心系统" }),
];

export interface Seeded {
  store: CleanroomStore;
  tick: () => string;
  supplementFor: (batchId: string) => SampleBatch | null;
}

export function createSeededStore(): Seeded {
  // 确定性时钟：从今日 10:00 起每次调用前进 1 分钟，审计时间线清晰
  let clockMs = Date.parse("2026-10-07T10:00:00+08:00");
  const tick = () => {
    clockMs += 60_000;
    return new Date(clockMs).toISOString();
  };
  const store = new CleanroomStore(
    { policies: [policyV1], calibrations: calibrationBase },
    tick
  );

  const chen = actors.inspector;
  const wang = actors.teamLead;

  // 已入库批次
  store.ingest(chen, batch({ id: "B-2601", pointId: "CR-1201", roomClass: "ISO 5", sampledAt: "2026-10-07T08:12:00+08:00", durationSec: 60, rawCount: 12 })); // 4240/m³ 超限
  store.ingest(chen, batch({ id: "B-2602", pointId: "CR-1201", roomClass: "ISO 5", sampledAt: "2026-10-07T08:20:00+08:00", durationSec: 30, rawCount: 5 })); // 1.42L < 2L 待补采
  store.ingest(chen, batch({ id: "B-2603", pointId: "CR-2107", roomClass: "ISO 6", sampledAt: "2026-10-07T08:31:00+08:00", durationSec: 120, rawCount: 180, instrumentId: "P-02" })); // 31802/m³ 正常
  store.ingest(chen, batch({ id: "B-2604", pointId: "Y-0302", roomClass: "ISO 7", sampledAt: "2026-10-07T08:47:00+08:00", durationSec: 300, rawCount: 5100 })); // 360424/m³ 超限
  store.ingest(chen, batch({ id: "B-2605", pointId: "CR-1201", roomClass: "ISO 5", sampledAt: "2026-10-07T09:05:00+08:00", durationSec: 60, rawCount: 9 })); // 3180/m³ 正常(v1)
  // 中心重复上报同一次采样 → 冲突草稿
  store.ingest(chen, batch({ id: "B-2606", pointId: "CR-1201", roomClass: "ISO 5", sampledAt: "2026-10-07T09:05:00+08:00", durationSec: 60, rawCount: 9, source: "center", submittedBy: "中心系统" }));

  // 班组长签认 B-2604：冻结原值与依据
  store.acknowledge(wang, "B-2604", "已通知厂务清洗 FFU，复测合格后关闭");

  // 补录：为待补采批次生成一份足量补采单（巡检员）
  const supplementFor = (batchId: string): SampleBatch | null => {
    if (batchId !== "B-2602") return null;
    return batch({
      id: "B-2602B",
      pointId: "CR-1201",
      roomClass: "ISO 5",
      sampledAt: "2026-10-07T10:20:00+08:00",
      durationSec: 90, // 4.25L ≥ 2L
      rawCount: 8,
      isSupplement: true,
    });
  };

  return { store, tick, supplementFor };
}
