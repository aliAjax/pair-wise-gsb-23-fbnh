// 演示种子数据
// 时间线：15 天前签认的异常冻结在 2024版；10 天前 2025版收紧 ISO6；
// 12 天前的 ISO6 合格批次按新依据重算为未签认异常（签认后才会再次冻结）。

import type {
  AuditEntry,
  Calibration,
  Disposition,
  Instrument,
  SampleBatch,
  ThresholdPolicy,
} from "./types";

export interface Seed {
  instruments: Instrument[];
  calibrations: Calibration[];
  policies: ThresholdPolicy[];
  batches: SampleBatch[];
  dispositions: Disposition[];
  audit: AuditEntry[];
}

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

export function buildSeed(now: number = Date.now()): Seed {
  const yesterday9 = new Date(now - DAY).setHours(9, 0, 0, 0);

  const instruments: Instrument[] = [
    { id: "LPC-01", name: "尘埃粒子计数器A", model: "2.83L/min 便携", flowLpm: 2.83 },
    { id: "LPC-02", name: "尘埃粒子计数器B", model: "28.3L/min 推车", flowLpm: 28.3 },
  ];

  const calibrations: Calibration[] = [
    {
      id: "CAL-1001",
      instrumentId: "LPC-01",
      effectiveAt: now - 60 * DAY,
      factor: 1,
      note: "年度校准，系数 1.00",
      createdAt: now - 60 * DAY,
      createdBy: "厂务工程师",
    },
    {
      id: "CAL-1002",
      instrumentId: "LPC-02",
      effectiveAt: now - 45 * DAY,
      factor: 1,
      note: "年度校准，系数 1.00",
      createdAt: now - 45 * DAY,
      createdBy: "厂务工程师",
    },
  ];

  const policies: ThresholdPolicy[] = [
    {
      id: "POL-V1",
      version: "2024版",
      effectiveAt: new Date(new Date(now).getFullYear() - 1 + "-01-01T00:00:00").getTime(),
      createdAt: now - 300 * DAY,
      createdBy: "厂务工程师",
      note: "基线阈值",
      limits: { "ISO 5": 3520, "ISO 6": 35200, "ISO 7": 352000 },
    },
    {
      id: "POL-V2",
      version: "2025版",
      effectiveAt: now - 10 * DAY,
      createdAt: now - 10 * DAY,
      createdBy: "厂务工程师",
      note: "ISO 6 由 35200 收紧至 28000；未签认记录按本版重算",
      limits: { "ISO 5": 3520, "ISO 6": 28000, "ISO 7": 352000 },
    },
  ];

  // LPC-01 (2.83 L/min)：30s=1.415L(<2)；45s=2.1225L；60s=2.83L；120s=5.66L
  // LPC-02 (28.3 L/min)：30s=14.15L；60s=28.3L

  const batches: SampleBatch[] = [
    // 昨日 ISO5：40/28.3*1000 = 1413 ≤ 3520 合格（首份现场，中心后到留草稿）
    {
      id: "B2026100601",
      sampleKey: "CR-1201|" + yesterday9,
      room: "CR-1201",
      area: "一般区",
      grade: "ISO 5",
      instrumentId: "LPC-02",
      sampledAt: yesterday9,
      durationSec: 60,
      rawCount: 40,
      channel: "field",
      submittedBy: "巡检员·王巡",
      submittedAt: yesterday9 + 5 * MIN,
      status: "ledger",
      backfill: false,
      attempts: 1,
    },
    // 12 天前 ISO6：820/28.3*1000 = 28975，2024版(35200)合格；
    // 2025版收紧后未签认重算 → 28975 > 28000 异常，待班组长签认
    {
      id: "B2026092502",
      sampleKey: "CR-2208|" + (now - 12 * DAY),
      room: "CR-2208",
      area: "一般区",
      grade: "ISO 6",
      instrumentId: "LPC-02",
      sampledAt: now - 12 * DAY,
      durationSec: 60,
      rawCount: 820,
      channel: "field",
      submittedBy: "巡检员·王巡",
      submittedAt: now - 12 * DAY + 6 * MIN,
      status: "ledger",
      backfill: false,
      attempts: 1,
    },
    // 今日低体积（30s 便携机 = 1.415L < 2L）→ 待补采，不参与异常判定
    {
      id: "B2026100701",
      sampleKey: "CR-2107|" + (now - 3 * 60 * MIN),
      room: "CR-2107",
      area: "一般区",
      grade: "ISO 6",
      instrumentId: "LPC-01",
      sampledAt: now - 3 * 60 * MIN,
      durationSec: 30,
      rawCount: 6,
      channel: "field",
      submittedBy: "巡检员·李检",
      submittedAt: now - 3 * 60 * MIN + MIN,
      status: "ledger",
      backfill: false,
      attempts: 1,
    },
    // 15 天前 ISO5 异常，10 天前阈值更新之前已签认 → 冻结 2024版原值
    {
      id: "B2026092202",
      sampleKey: "CR-1203|" + (now - 15 * DAY),
      room: "CR-1203",
      area: "一般区",
      grade: "ISO 5",
      instrumentId: "LPC-02",
      sampledAt: now - 15 * DAY,
      durationSec: 60,
      rawCount: 130,
      channel: "center",
      submittedBy: "中心·赵核",
      submittedAt: now - 15 * DAY + 10 * MIN,
      status: "ledger",
      backfill: false,
      attempts: 1,
    },
    // 今日黄光区 ISO7：3200/14.15*1000 = 226148 ≤ 352000 合格
    {
      id: "B2026100703",
      sampleKey: "Y-0302|" + (now - 2 * 60 * MIN),
      room: "Y-0302",
      area: "黄光区",
      grade: "ISO 7",
      instrumentId: "LPC-02",
      sampledAt: now - 2 * 60 * MIN,
      durationSec: 30,
      rawCount: 3200,
      channel: "field",
      submittedBy: "巡检员·王巡",
      submittedAt: now - 2 * 60 * MIN + MIN,
      status: "ledger",
      backfill: false,
      attempts: 1,
    },
    // 上传失败待重试（入库判定将为异常：100/2.83*1000=35336 > 28000）
    {
      id: "B2026100704",
      sampleKey: "CR-1205|" + (now - 60 * MIN),
      room: "CR-1205",
      area: "一般区",
      grade: "ISO 6",
      instrumentId: "LPC-01",
      sampledAt: now - 60 * MIN,
      durationSec: 60,
      rawCount: 100,
      channel: "field",
      submittedBy: "巡检员·李检",
      submittedAt: now - 59 * MIN,
      status: "outbox",
      backfill: false,
      attempts: 2,
      lastError: "网络中断，已完成 0/1 批，等待断点重试",
    },
    // 中心后到，与昨日首份现场记录同一次采样 → 草稿冲突
    {
      id: "DRAFT-01",
      sampleKey: "CR-1201|" + yesterday9,
      room: "CR-1201",
      area: "一般区",
      grade: "ISO 5",
      instrumentId: "LPC-02",
      sampledAt: yesterday9,
      durationSec: 60,
      rawCount: 41,
      channel: "center",
      submittedBy: "中心·赵核",
      submittedAt: yesterday9 + 25 * MIN,
      status: "draft",
      backfill: false,
      attempts: 0,
      conflictWithId: "B2026100601",
    },
  ];

  const dispositions: Disposition[] = [
    {
      id: "DSP-01",
      batchId: "B2026092202",
      remark: "回风高效过滤器检漏异常，已更换并复测合格",
      createdAt: now - 15 * DAY + 12 * MIN,
      createdBy: "系统",
      signed: true,
      signedAt: now - 15 * DAY + 40 * MIN,
      signedBy: "班组长·周班",
      frozen: {
        volumeL: 28.3,
        factor: 1,
        perM3: 4594,
        policyId: "POL-V1",
        policyVersion: "2024版",
        calibrationId: "CAL-1002",
        limit: 3520,
        verdict: "abnormal",
        basis:
          "体积 28.30 L；校准系数 1（CAL-1002）；阈值 2024版（判定当时有效）≤ 3520 粒/m³",
        computedAt: now - 15 * DAY + 40 * MIN,
      },
    },
    // 未签认异常（如 B2026092502）不预落处置单：由统一判定内核实时算出，签认时才落库，
    // 这样阈值/校准重算与上传重放都不会产生重复处置记录。
  ];

  const audit: AuditEntry[] = [
    {
      id: "A-01",
      at: now - 15 * DAY + 12 * MIN,
      actor: "系统",
      role: "engineer",
      action: "disposition.auto",
      batchId: "B2026092202",
      detail: "判定异常 4594 粒/m³ 超 2024版阈值 3520，自动生成异常单",
    },
    {
      id: "A-02",
      at: now - 15 * DAY + 40 * MIN,
      actor: "班组长·周班",
      role: "leader",
      action: "disposition.sign",
      batchId: "B2026092202",
      detail: "班组长签认，原值 4594 与依据 2024版/CAL-1002 冻结",
    },
    {
      id: "A-03",
      at: now - 12 * DAY + 6 * MIN,
      actor: "巡检员·王巡",
      role: "inspector",
      action: "batch.submit",
      batchId: "B2026092502",
      detail: "CR-2208 现场批次入库（当时 2024版判定 28975 ≤ 35200 合格）",
    },
    {
      id: "A-04",
      at: now - 10 * DAY,
      actor: "厂务工程师",
      role: "engineer",
      action: "threshold.publish",
      detail: "发布 2025版：ISO6 收紧至 28000；未签认记录重算（B2026092502 翻转为异常），已签认保留原值",
    },
    {
      id: "A-05",
      at: yesterday9 + 5 * MIN,
      actor: "巡检员·王巡",
      role: "inspector",
      action: "batch.submit",
      batchId: "B2026100601",
      detail: "CR-1201 现场批次入库（首份有效）",
    },
    {
      id: "A-06",
      at: yesterday9 + 25 * MIN,
      actor: "中心·赵核",
      role: "inspector",
      action: "conflict.draft",
      batchId: "DRAFT-01",
      detail: "与 B2026100601 为同一次采样，中心记录留草稿",
    },
    {
      id: "A-07",
      at: now - 3 * 60 * MIN + MIN,
      actor: "巡检员·李检",
      role: "inspector",
      action: "batch.submit",
      batchId: "B2026100701",
      detail: "CR-2107 体积 1.42L < 2L，标记待补采，不参与异常判定",
    },
    {
      id: "A-08",
      at: now - 59 * MIN,
      actor: "巡检员·李检",
      role: "inspector",
      action: "batch.submit",
      batchId: "B2026100704",
      detail: "CR-1205 上传失败，保留断点：0/1，重放时不新增处置或审计",
    },
  ];

  return { instruments, calibrations, policies, batches, dispositions, audit };
}
