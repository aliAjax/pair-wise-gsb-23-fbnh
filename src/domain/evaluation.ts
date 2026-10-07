// 统一判定内核：看板、异常处置、导出都调用同一个 evaluateBatch，保证结果一致

import type {
  Calibration,
  DeterminationSnapshot,
  Disposition,
  Instrument,
  SampleBatch,
  ThresholdPolicy,
  Verdict,
} from "./types";

export const MIN_VOLUME_L = 2; // 低于 2 升：待补采，不参与异常判定

export function sampleVolume(flowLpm: number, durationSec: number): number {
  return (flowLpm * durationSec) / 60;
}

/**
 * 阈值版本：取判定时刻（重算时为当前时刻）已生效的最新版本。
 * 未签认记录随新版本重算；签认时的版本冻结进快照，即“当时阈值版本”。
 */
export function activePolicy(
  policies: ThresholdPolicy[],
  at: number
): ThresholdPolicy | undefined {
  return policies
    .filter((p) => p.effectiveAt <= at)
    .sort((a, b) => b.effectiveAt - a.effectiveAt)[0];
}

/** 校准依据：未签认记录始终按最新校准重算；签认记录使用冻结快照 */
export function latestCalibration(
  calibrations: Calibration[],
  instrumentId: string
): Calibration | undefined {
  return calibrations
    .filter((c) => c.instrumentId === instrumentId)
    .sort((a, b) => b.effectiveAt - a.effectiveAt)[0];
}

export interface EvalContext {
  instruments: Instrument[];
  calibrations: Calibration[];
  policies: ThresholdPolicy[];
  dispositions: Disposition[];
  /** 计算时刻（重算基准时刻），默认当前时间 */
  now?: number;
}

export interface BatchEvaluation {
  batch: SampleBatch;
  volumeL: number;
  belowMin: boolean;
  perM3: number | null;
  correctedCount: number | null;
  factor: number | null;
  calibration: Calibration | null;
  policy: ThresholdPolicy | null;
  limit: number | null;
  verdict: Verdict;
  basis: string;
  disposition: Disposition | undefined;
  signed: boolean;
  /** 实际呈现的判定：签认后为冻结快照，否则为现行判定 */
  active: {
    volumeL: number;
    factor: number;
    perM3: number;
    limit: number;
    policyId: string;
    policyVersion: string;
    calibrationId: string;
  } | null;
  /** 现行判定（签认批次额外给出，用于对比冻结值） */
  live: {
    perM3: number;
    limit: number;
    policyVersion: string;
    factor: number;
  } | null;
}

function roundInt(n: number): number {
  return Math.round(n);
}

function snapshotFromBatch(
  batch: SampleBatch,
  ctx: EvalContext,
  now: number
): DeterminationSnapshot | { volumeL: number } {
  const inst = ctx.instruments.find((i) => i.id === batch.instrumentId);
  const flow = inst?.flowLpm ?? 0;
  const volumeL = sampleVolume(flow, batch.durationSec);

  if (volumeL < MIN_VOLUME_L) {
    return { volumeL };
  }

  const cal = latestCalibration(ctx.calibrations, batch.instrumentId);
  const factor = cal?.factor ?? 1;
  const policy = activePolicy(ctx.policies, now);
  const limit = policy?.limits[batch.grade] ?? null;

  const corrected = batch.rawCount * factor;
  const perM3 = roundInt((corrected / volumeL) * 1000);
  const verdict: Verdict =
    limit === null ? "qualified" : perM3 > limit ? "abnormal" : "qualified";

  return {
    volumeL,
    factor,
    perM3,
    policyId: policy?.id ?? "none",
    policyVersion: policy?.version ?? "无版本",
    calibrationId: cal?.id ?? "none",
    limit: limit ?? -1,
    verdict,
    basis:
      `体积 ${volumeL.toFixed(2)} L；校准系数 ${factor}（${cal?.id ?? "无校准记录，系数1"}）；` +
      `阈值 ${policy?.version ?? "无版本"}（判定当时有效）≤ ${limit ?? "—"} 粒/m³`,
    computedAt: now,
  };
}

export function evaluateBatch(
  batch: SampleBatch,
  ctx: EvalContext
): BatchEvaluation {
  const now = ctx.now ?? Date.now();
  const disposition = ctx.dispositions.find((d) => d.batchId === batch.id);

  const inst = ctx.instruments.find((i) => i.id === batch.instrumentId);
  const flow = inst?.flowLpm ?? 0;
  const volumeL = sampleVolume(flow, batch.durationSec);
  const belowMin = volumeL < MIN_VOLUME_L;

  // 低体积批次：待补采，不参与异常判定
  if (belowMin) {
    const cal = latestCalibration(ctx.calibrations, batch.instrumentId);
    const factor = cal?.factor ?? 1;
    const perM3 = roundInt(((batch.rawCount * factor) / volumeL) * 1000);
    return {
      batch,
      volumeL,
      belowMin: true,
      perM3,
      correctedCount: roundInt(batch.rawCount * factor),
      factor,
      calibration: cal ?? null,
      policy: null,
      limit: null,
      verdict: "resample",
      basis: `体积 ${volumeL.toFixed(2)} L < ${MIN_VOLUME_L} L，待补采，不参与异常判定`,
      disposition,
      signed: false,
      active: null,
      live: null,
    };
  }

  const liveSnap = snapshotFromBatch(batch, ctx, now) as DeterminationSnapshot;

  // 已签认：保留原值和依据（冻结），同时给出按新依据的重算值做对比
  if (disposition?.signed && disposition.frozen) {
    const frozen = disposition.frozen;
    return {
      batch,
      volumeL,
      belowMin: false,
      perM3: frozen.perM3,
      correctedCount: null,
      factor: frozen.factor,
      calibration: null,
      policy:
        ctx.policies.find((p) => p.id === frozen.policyId) ?? null,
      limit: frozen.limit,
      verdict: frozen.verdict,
      basis: `签认冻结依据：${frozen.basis}`,
      disposition,
      signed: true,
      active: {
        volumeL: frozen.volumeL,
        factor: frozen.factor,
        perM3: frozen.perM3,
        limit: frozen.limit,
        policyId: frozen.policyId,
        policyVersion: frozen.policyVersion,
        calibrationId: frozen.calibrationId,
      },
      live: {
        perM3: liveSnap.perM3,
        limit: liveSnap.limit,
        policyVersion: liveSnap.policyVersion,
        factor: liveSnap.factor,
      },
    };
  }

  // 未签认：按当前依据（最新校准 + 当时阈值版本）实时判定
  return {
    batch,
    volumeL,
    belowMin: false,
    perM3: liveSnap.perM3,
    correctedCount: roundInt(batch.rawCount * liveSnap.factor),
    factor: liveSnap.factor,
    calibration:
      ctx.calibrations.find((c) => c.id === liveSnap.calibrationId) ?? null,
    policy:
      ctx.policies.find((p) => p.id === liveSnap.policyId) ?? null,
    limit: liveSnap.limit === -1 ? null : liveSnap.limit,
    verdict: liveSnap.verdict,
    basis: liveSnap.basis,
    disposition,
    signed: false,
    active: {
      volumeL: liveSnap.volumeL,
      factor: liveSnap.factor,
      perM3: liveSnap.perM3,
      limit: liveSnap.limit === -1 ? -1 : liveSnap.limit,
      policyId: liveSnap.policyId,
      policyVersion: liveSnap.policyVersion,
      calibrationId: liveSnap.calibrationId,
    },
    live: null,
  };
}

export function evaluateBatches(
  batches: SampleBatch[],
  ctx: EvalContext
): BatchEvaluation[] {
  return batches
    .filter((b) => b.status === "ledger")
    .map((b) => evaluateBatch(b, ctx));
}

/** 签认时冻结当前判定快照 */
export function buildSnapshot(
  batch: SampleBatch,
  ctx: EvalContext
): DeterminationSnapshot | null {
  const now = ctx.now ?? Date.now();
  const snap = snapshotFromBatch(batch, ctx, now);
  if ("verdict" in snap) return snap;
  return null; // 低体积批次无判定快照
}
