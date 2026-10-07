// React 状态封装：所有写操作委托给纯流转模块（src/domain/flow.ts）
// 看板 / 异常处置 / 导出均通过 evaluations 读取同一套判定结果

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AuditEntry,
  Role,
  SampleBatch,
} from "../domain/types";
import { buildSeed } from "../domain/seed";
import {
  evaluateBatch,
  evaluateBatches,
  type BatchEvaluation,
  type EvalContext,
} from "../domain/evaluation";
import {
  fromSeed,
  publishCalibration as flowPublishCalibration,
  publishThreshold as flowPublishThreshold,
  resolveDraft as flowResolveDraft,
  retryUploads as flowRetryUploads,
  setNetwork as flowSetNetwork,
  signDisposition as flowSignDisposition,
  submitBatch as flowSubmitBatch,
  submitResample as flowSubmitResample,
  type FlowState,
  type SubmitInput,
  type SubmitResult,
} from "../domain/flow";

const STORAGE_KEY = "hxwl-09-state-v2";

interface PersistShape {
  state: FlowState;
}

function freshState(): FlowState {
  return fromSeed(buildSeed());
}

function loadState(): FlowState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistShape;
      if (parsed.state && parsed.state.batches) return parsed.state;
    }
  } catch {
    /* 忽略损坏缓存 */
  }
  return freshState();
}

export function useStore() {
  const [state, setState] = useState<FlowState>(loadState);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state }));
  }, [state]);

  const submitBatch = useCallback(
    (input: SubmitInput, actor: string, role: Role): SubmitResult => {
      let result: SubmitResult = { kind: "ledger", batchId: "" };
      setState((s) => {
        const r = flowSubmitBatch(s, input, actor, role);
        result = r.result;
        return r.state;
      });
      return result;
    },
    []
  );

  const submitResample = useCallback(
    (originalId: string, input: SubmitInput, actor: string, role: Role): string => {
      let id = "";
      setState((s) => {
        const r = flowSubmitResample(s, originalId, input, actor, role);
        id = r.batchId;
        return r.state;
      });
      return id;
    },
    []
  );

  const retryUploads = useCallback(() => setState((s) => flowRetryUploads(s)), []);
  const resolveDraft = useCallback(
    (
      draftId: string,
      action: "discard" | "resubmit",
      actor: string,
      role: Role,
      resubmit?: SubmitInput
    ) =>
      setState((s) => flowResolveDraft(s, draftId, action, actor, role, resubmit)),
    []
  );
  const signDisposition = useCallback(
    (batchId: string, remark: string, actor: string, role: Role): boolean => {
      let ok = false;
      setState((s) => {
        const next = flowSignDisposition(s, batchId, remark, actor, role);
        ok = next !== s;
        return next;
      });
      return ok;
    },
    []
  );
  const publishCalibration = useCallback(
    (data: Parameters<typeof flowPublishCalibration>[1], actor: string, role: Role) =>
      setState((s) => flowPublishCalibration(s, data, actor, role)),
    []
  );
  const publishThreshold = useCallback(
    (data: Parameters<typeof flowPublishThreshold>[1], actor: string, role: Role) =>
      setState((s) => flowPublishThreshold(s, data, actor, role)),
    []
  );
  const setNetwork = useCallback((ok: boolean) => setState((s) => flowSetNetwork(s, ok)), []);

  const resetDemo = useCallback((actor: string, role: Role) => {
    setState((s) => {
      const fresh = freshState();
      return {
        ...fresh,
        seq: s.seq + 1,
        audit: [
          ...fresh.audit,
          {
            id: `A-${s.seq}`,
            at: Date.now(),
            actor,
            role,
            action: "reset" as const,
            detail: "重置为演示数据",
          } satisfies AuditEntry,
        ],
      };
    });
  }, []);

  const ctx: EvalContext = useMemo(
    () => ({
      instruments: state.instruments,
      calibrations: state.calibrations,
      policies: state.policies,
      dispositions: state.dispositions,
    }),
    [state.instruments, state.calibrations, state.policies, state.dispositions]
  );

  const ledgerBatches = useMemo(
    () => state.batches.filter((b) => b.status === "ledger"),
    [state.batches]
  );
  const draftBatches = useMemo(
    () => state.batches.filter((b) => b.status === "draft"),
    [state.batches]
  );
  const outboxBatches = useMemo(
    () => state.batches.filter((b) => b.status === "outbox"),
    [state.batches]
  );

  const evaluations = useMemo<BatchEvaluation[]>(
    () => evaluateBatches(ledgerBatches, ctx),
    [ledgerBatches, ctx]
  );

  const evaluate = useCallback((b: SampleBatch) => evaluateBatch(b, ctx), [ctx]);

  const actions = useMemo(
    () => ({
      submitBatch,
      submitResample,
      retryUploads,
      resolveDraft,
      signDisposition,
      publishCalibration,
      publishThreshold,
      setNetwork,
      resetDemo,
      evaluate,
    }),
    [
      submitBatch,
      submitResample,
      retryUploads,
      resolveDraft,
      signDisposition,
      publishCalibration,
      publishThreshold,
      setNetwork,
      resetDemo,
      evaluate,
    ]
  );

  return {
    state,
    ctx,
    actions,
    evaluations,
    ledgerBatches,
    draftBatches,
    outboxBatches,
  };
}

export type Store = ReturnType<typeof useStore>;
export { makeSampleKey } from "../domain/flow";
export type { SubmitInput } from "../domain/flow";
