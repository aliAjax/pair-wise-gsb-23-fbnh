// 领域模型：采样批次、仪器校准、阈值政策、异常处置、审计

export type Role = "inspector" | "engineer" | "leader" | "auditor";

export const ROLE_LABEL: Record<Role, string> = {
  inspector: "巡检员",
  engineer: "厂务工程师",
  leader: "班组长",
  auditor: "审计员",
};

export type Grade = "ISO 5" | "ISO 6" | "ISO 7";
export const GRADES: Grade[] = ["ISO 5", "ISO 6", "ISO 7"];

export type Area = "一般区" | "黄光区";
export const AREAS: Area[] = ["一般区", "黄光区"];

export interface Calibration {
  id: string;
  instrumentId: string;
  /** 生效时刻（ms） */
  effectiveAt: number;
  /** 修正系数：校正计数 = 原始计数 × factor */
  factor: number;
  note: string;
  createdAt: number;
  createdBy: string;
}

export interface Instrument {
  id: string;
  name: string;
  model: string;
  /** 标称采样流量 L/min */
  flowLpm: number;
}

/** 阈值政策（版本化，按生效时间适用） */
export interface ThresholdPolicy {
  id: string;
  version: string;
  effectiveAt: number;
  createdAt: number;
  createdBy: string;
  note: string;
  /** 各等级 0.5μm 粒子上限，单位：粒/m³ */
  limits: Record<Grade, number>;
}

export type Channel = "field" | "center";
export const CHANNEL_LABEL: Record<Channel, string> = {
  field: "现场",
  center: "中心",
};

export type BatchStatus = "outbox" | "ledger" | "draft";

export interface SampleBatch {
  id: string;
  /** 同一次采样去重键：房间|采样时刻 */
  sampleKey: string;
  room: string;
  area: Area;
  grade: Grade;
  instrumentId: string;
  sampledAt: number;
  durationSec: number;
  /** 0.5μm 通道原始计数 */
  rawCount: number;
  channel: Channel;
  submittedBy: string;
  submittedAt: number;
  status: BatchStatus;
  /** 是否补录（采样时刻早于提交时刻较多） */
  backfill: boolean;
  /** 上传队列信息 */
  attempts: number;
  lastError?: string;
  /** 后到草稿指向首份有效批次 */
  conflictWithId?: string;
  /** 本批次是对某低体积批次的补采 */
  supersedesId?: string;
  /** 低体积批次已被哪一批补采 */
  supersededById?: string;
}

/** 一次完整判定的结果快照（签认时冻结） */
export interface DeterminationSnapshot {
  volumeL: number;
  factor: number;
  perM3: number;
  policyId: string;
  policyVersion: string;
  calibrationId: string;
  limit: number;
  verdict: Verdict;
  basis: string;
  computedAt: number;
}

export type Verdict = "qualified" | "abnormal" | "resample";

export const VERDICT_LABEL: Record<Verdict, string> = {
  qualified: "合格",
  abnormal: "异常",
  resample: "待补采",
};

export interface Disposition {
  id: string;
  batchId: string;
  remark: string;
  createdAt: number;
  createdBy: string;
  /** 未签认：现行判定随依据更新重算；签认后冻结 */
  signed: boolean;
  signedAt?: number;
  signedBy?: string;
  frozen?: DeterminationSnapshot;
}

export type AuditAction =
  | "batch.submit"
  | "batch.backfill"
  | "batch.resample"
  | "disposition.auto"
  | "disposition.sign"
  | "calibration.publish"
  | "threshold.publish"
  | "conflict.draft"
  | "conflict.resolve"
  | "reset";

export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  "batch.submit": "批次入库",
  "batch.backfill": "补录入库",
  "batch.resample": "补采入库",
  "disposition.auto": "异常单生成",
  "disposition.sign": "异常签认",
  "calibration.publish": "校准发布",
  "threshold.publish": "阈值发布",
  "conflict.draft": "冲突留草稿",
  "conflict.resolve": "草稿处理",
  reset: "演示重置",
};

export interface AuditEntry {
  id: string;
  at: number;
  actor: string;
  role: Role;
  action: AuditAction;
  batchId?: string;
  detail: string;
}
