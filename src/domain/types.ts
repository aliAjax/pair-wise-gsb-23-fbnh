/**
 * 洁净室粒子计数巡检 —— 领域模型
 * 采样批次、仪器校准、阈值政策、异常处置共用同一套判定。
 */

export type Role = "inspector" | "team_lead" | "auditor";

export const ROLE_LABEL: Record<Role, string> = {
  inspector: "巡检员",
  team_lead: "班组长",
  auditor: "审计员",
};

export interface Actor {
  id: string;
  name: string;
  role: Role;
}

/** 阈值政策版本：按生效时间解析，采样判定采用“当时”版本 */
export interface ThresholdPolicy {
  id: string;
  version: number;
  effectiveFrom: string; // ISO 时间
  limits: ThresholdLimit[];
  note?: string;
}

export interface ThresholdLimit {
  roomClass: string; // 如 ISO 5
  particleSizeUm: number; // 粒径 µm
  maxPerM3: number; // 限值 个/m³
}

/** 仪器校准：修正系数按校准生效时间作用于采样计数 */
export interface Calibration {
  id: string;
  instrumentId: string;
  calibratedAt: string; // 生效时间
  correctionFactor: number; // 乘到原始计数上
  certificateNo: string;
}

/** 采样批次（客户端生成，id 即幂等键） */
export interface SampleBatch {
  id: string;
  /** 同一次采样的业务键（点位+采样结束时刻），现场与中心各自提交时相同 */
  samplingKey: string;
  pointId: string;
  roomClass: string;
  instrumentId: string;
  particleSizeUm: number;
  flowRateLpm: number; // 流量 升/分钟
  durationSec: number; // 采样时长 秒（现场常用 30~300）
  rawCount: number; // 原始粒子计数
  sampledAt: string; // 采样结束时间
  source: "field" | "center";
  submittedBy: string;
  isSupplement?: boolean; // 补录标记
}

export type DeterminationStatus = "normal" | "exceeded" | "pending_resample";

export const STATUS_LABEL: Record<DeterminationStatus, string> = {
  normal: "正常",
  exceeded: "超限",
  pending_resample: "待补采",
};

/** 判定结果：看板、异常处置、导出都读它 */
export interface Determination {
  status: DeterminationStatus;
  volumeL: number;
  countsPerM3: number;
  thresholdPerM3: number | null;
  /** 判定依据：阈值版本 + 校准编号 */
  policyId: string | null;
  policyVersion: number | null;
  calibrationId: string | null;
  correctionFactor: number;
  determinedAt: string;
  reason: string;
}

export type RecordState = "stored" | "draft_conflict";

export interface BatchRecord {
  batch: SampleBatch;
  state: RecordState;
  /** 冲突草稿指向已入库批次 */
  conflictWith?: string;
  determination: Determination | null; // 草稿不参与判定
  /** 已签认冻结：重算不再触碰，保留原值和依据 */
  frozen: boolean;
  storedAt: string;
}

export type DispositionStatus = "open" | "acknowledged" | "closed";

export const DISPOSITION_LABEL: Record<DispositionStatus, string> = {
  open: "未签认",
  acknowledged: "已签认",
  closed: "重算关闭",
};

export interface Disposition {
  id: string;
  batchId: string;
  status: DispositionStatus;
  openedAt: string;
  /** 签认时快照：原值与依据永久保留 */
  snapshot: Determination | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  note: string | null;
  history: Array<{ at: string; action: string; detail: string }>;
}

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  role: Role | "system";
  action: string;
  detail: string;
}

export type IngestOutcome = "stored" | "draft_conflict" | "replayed";

export interface IngestResult {
  outcome: IngestOutcome;
  record: BatchRecord;
}
