/**
 * 统一判定引擎（纯函数）：
 *  - 采样按体积换算成每立方米计数
 *  - 采用采样“当时”的阈值版本与校准系数
 *  - 低于 2 升的批次待补采，不参与异常判定
 */
import type {
  Calibration,
  Determination,
  SampleBatch,
  ThresholdPolicy,
} from "./types";

export const MIN_VALID_VOLUME_L = 2;

/** 采样体积（升）= 流量(升/分钟) × 时长(秒) / 60 */
export function volumeLiters(flowRateLpm: number, durationSec: number): number {
  return (flowRateLpm * durationSec) / 60;
}

/** 每立方米计数 = 原始计数 × 校准系数 ÷ 体积(m³) */
export function countsPerCubicMeter(
  rawCount: number,
  volumeL: number,
  correctionFactor = 1
): number {
  if (volumeL <= 0) return 0;
  return Math.round((rawCount * correctionFactor * 1000) / volumeL);
}

/** 解析 at 时刻生效的阈值版本（effectiveFrom <= at 中最新的一份） */
export function resolvePolicy(
  policies: ThresholdPolicy[],
  at: string
): ThresholdPolicy | null {
  const t = Date.parse(at);
  let best: ThresholdPolicy | null = null;
  for (const p of policies) {
    const from = Date.parse(p.effectiveFrom);
    if (from <= t && (!best || from > Date.parse(best.effectiveFrom))) {
      best = p;
    }
  }
  return best;
}

/** 解析 at 时刻仪器适用的校准（calibratedAt <= at 中最新的一份） */
export function resolveCalibration(
  calibrations: Calibration[],
  instrumentId: string,
  at: string
): Calibration | null {
  const t = Date.parse(at);
  let best: Calibration | null = null;
  for (const c of calibrations) {
    if (c.instrumentId !== instrumentId) continue;
    const from = Date.parse(c.calibratedAt);
    if (from <= t && (!best || from > Date.parse(best.calibratedAt))) {
      best = c;
    }
  }
  return best;
}

export function findLimit(
  policy: ThresholdPolicy | null,
  roomClass: string,
  particleSizeUm: number
): number | null {
  if (!policy) return null;
  const hit = policy.limits.find(
    (l) => l.roomClass === roomClass && l.particleSizeUm === particleSizeUm
  );
  return hit ? hit.maxPerM3 : null;
}

/**
 * 对单个批次作出判定。
 * 阈值与校准都按 batch.sampledAt 解析 —— 政策/校准表更新后重新调用本函数即“按新依据重算”。
 */
export function determine(
  batch: SampleBatch,
  policies: ThresholdPolicy[],
  calibrations: Calibration[],
  now: string
): Determination {
  const volumeL = volumeLiters(batch.flowRateLpm, batch.durationSec);
  const calibration = resolveCalibration(
    calibrations,
    batch.instrumentId,
    batch.sampledAt
  );
  const correctionFactor = calibration?.correctionFactor ?? 1;
  const countsPerM3 = countsPerCubicMeter(
    batch.rawCount,
    volumeL,
    correctionFactor
  );
  const policy = resolvePolicy(policies, batch.sampledAt);
  const threshold = findLimit(policy, batch.roomClass, batch.particleSizeUm);

  const base = {
    volumeL,
    countsPerM3,
    thresholdPerM3: threshold,
    policyId: policy?.id ?? null,
    policyVersion: policy?.version ?? null,
    calibrationId: calibration?.id ?? null,
    correctionFactor,
    determinedAt: now,
  };

  if (volumeL < MIN_VALID_VOLUME_L) {
    return {
      ...base,
      status: "pending_resample",
      reason: `采样体积 ${volumeL.toFixed(2)}L 低于 ${MIN_VALID_VOLUME_L}L，待补采，不参与异常判定`,
    };
  }
  if (threshold == null) {
    return {
      ...base,
      status: "normal",
      reason: "未配置适用限值，按通过处理",
    };
  }
  if (countsPerM3 > threshold) {
    return {
      ...base,
      status: "exceeded",
      reason: `${countsPerM3.toLocaleString()} 个/m³ 超过限值 ${threshold.toLocaleString()} 个/m³`,
    };
  }
  return { ...base, status: "normal", reason: "未超限" };
}
