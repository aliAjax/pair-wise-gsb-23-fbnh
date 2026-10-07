import { describe, expect, it } from "vitest";
import {
  countsPerCubicMeter,
  determine,
  resolvePolicy,
  volumeLiters,
} from "./determination";
import { CleanroomStore, PermissionError } from "./store";
import type { Actor, SampleBatch, ThresholdPolicy } from "./types";

const wang: Actor = { id: "u-wang", name: "王磊", role: "team_lead" };
const chen: Actor = { id: "u-chen", name: "陈洁", role: "inspector" };
const zhao: Actor = { id: "u-zhao", name: "赵敏", role: "auditor" };

const policyV1: ThresholdPolicy = {
  id: "TP-V1",
  version: 1,
  effectiveFrom: "2026-07-01T00:00:00+08:00",
  limits: [
    { roomClass: "ISO 5", particleSizeUm: 0.5, maxPerM3: 3520 },
    { roomClass: "ISO 6", particleSizeUm: 0.5, maxPerM3: 35200 },
  ],
};

const policyV2: ThresholdPolicy = {
  id: "TP-V2",
  version: 2,
  effectiveFrom: "2026-10-01T00:00:00+08:00",
  limits: [
    { roomClass: "ISO 5", particleSizeUm: 0.5, maxPerM3: 3000 },
    { roomClass: "ISO 6", particleSizeUm: 0.5, maxPerM3: 30000 },
  ],
};

let clock = Date.parse("2026-10-07T10:00:00+08:00");
const tick = () => new Date((clock += 60_000)).toISOString();

function makeStore() {
  clock = Date.parse("2026-10-07T10:00:00+08:00");
  return new CleanroomStore(
    {
      policies: [policyV1],
      calibrations: [
        {
          id: "CAL-1",
          instrumentId: "P-01",
          calibratedAt: "2026-09-01T00:00:00+08:00",
          correctionFactor: 1,
          certificateNo: "QC-1",
        },
      ],
    },
    tick
  );
}

function batch(p: Partial<SampleBatch> & Pick<SampleBatch, "id" | "sampledAt" | "rawCount" | "durationSec">): SampleBatch {
  return {
    samplingKey: `${p.pointId ?? "CR-1201"}|${p.sampledAt}`,
    pointId: "CR-1201",
    roomClass: "ISO 5",
    instrumentId: "P-01",
    particleSizeUm: 0.5,
    flowRateLpm: 2.83,
    source: "field",
    submittedBy: "陈洁",
    ...p,
  };
}

describe("体积换算与当时阈值版本", () => {
  it("按体积换算成每立方米计数", () => {
    expect(volumeLiters(2.83, 60)).toBeCloseTo(2.83);
    expect(countsPerCubicMeter(12, 2.83)).toBe(4240);
    expect(countsPerCubicMeter(12, 2.83, 0.92)).toBe(3901);
  });

  it("判定采用采样当时生效的阈值版本", () => {
    // 9/30 采样在 v2(10/1 生效)之前 → 用 v1；10/7 采样 → 用 v2
    const policies = [policyV1, policyV2];
    expect(resolvePolicy(policies, "2026-09-30T23:00:00+08:00")?.id).toBe("TP-V1");
    expect(resolvePolicy(policies, "2026-10-07T08:00:00+08:00")?.id).toBe("TP-V2");

    const store = new CleanroomStore({ policies, calibrations: [] }, tick);
    const r = store.ingest(chen, batch({ id: "X-1", sampledAt: "2026-10-07T08:00:00+08:00", durationSec: 60, rawCount: 9 }));
    // 9 → 3180/m³：v1(3520) 下正常，v2(3000) 下超限；采样当时已是 v2
    expect(r.record.determination?.policyId).toBe("TP-V2");
    expect(r.record.determination?.status).toBe("exceeded");
  });
});

describe("低于 2 升的批次", () => {
  it("待补采，不参与异常判定", () => {
    const store = makeStore();
    const r = store.ingest(chen, batch({ id: "S-1", sampledAt: "2026-10-07T08:00:00+08:00", durationSec: 30, rawCount: 999 }));
    expect(r.record.determination?.status).toBe("pending_resample");
    expect(store.snapshot().dispositions).toHaveLength(0); // 不生成异常处置
    expect(store.metrics().pendingResample).toBe(1);
  });
});

describe("现场与中心重复提交", () => {
  it("首份有效记录入库，后到者留草稿并看见冲突", () => {
    const store = makeStore();
    const at = "2026-10-07T09:05:00+08:00";
    const first = store.ingest(chen, batch({ id: "F-1", sampledAt: at, durationSec: 60, rawCount: 9 }));
    const dup = store.ingest(chen, batch({ id: "C-1", sampledAt: at, durationSec: 60, rawCount: 9, source: "center", submittedBy: "中心系统" }));
    expect(first.outcome).toBe("stored");
    expect(dup.outcome).toBe("draft_conflict");
    expect(dup.record.conflictWith).toBe("F-1");
    expect(dup.record.determination).toBeNull(); // 草稿不参与判定
    expect(store.metrics().conflictDrafts).toBe(1);
  });
});

describe("断点重试与重放", () => {
  it("同一批次重放不新增处置或审计", () => {
    const store = makeStore();
    const b = batch({ id: "U-2", sampledAt: "2026-10-07T09:46:00+08:00", durationSec: 60, rawCount: 14 }); // 超限
    const first = store.ingest(chen, b);
    expect(first.outcome).toBe("stored");
    const auditLen = store.snapshot().audit.length;
    const dispLen = store.snapshot().dispositions.length;

    const replay = store.ingest(chen, b); // 上传失败后重试同一批次
    expect(replay.outcome).toBe("replayed");
    expect(store.snapshot().audit.length).toBe(auditLen); // 审计不新增
    expect(store.snapshot().dispositions.length).toBe(dispLen); // 处置不新增
  });
});

describe("校准或阈值更新后的重算", () => {
  it("未签认异常按新依据重算，已签认保留原值和依据", () => {
    const store = makeStore();
    store.ingest(chen, batch({ id: "A-1", sampledAt: "2026-10-07T08:00:00+08:00", durationSec: 60, rawCount: 12 })); // 4240 超限
    store.ingest(chen, batch({ id: "A-2", sampledAt: "2026-10-07T08:30:00+08:00", durationSec: 60, rawCount: 9 })); // 3180 v1 正常
    store.acknowledge(wang, "A-1", "已通知厂务"); // A-1 签认冻结

    store.publishPolicy(wang, policyV2); // ISO5 加严到 3000，生效 10/1 覆盖今日

    const a1 = store.snapshot().records.find((r) => r.batch.id === "A-1")!;
    const a2 = store.snapshot().records.find((r) => r.batch.id === "A-2")!;
    // 已签认：保留原值 4240 与原依据 TP-V1
    expect(a1.determination?.countsPerM3).toBe(4240);
    expect(a1.determination?.policyId).toBe("TP-V1");
    // 未签认：按新依据重算，3180 > 3000 转为超限并生成处置
    expect(a2.determination?.status).toBe("exceeded");
    expect(a2.determination?.policyId).toBe("TP-V2");
    expect(store.snapshot().dispositions.some((d) => d.batchId === "A-2" && d.status === "open")).toBe(true);
  });

  it("校准更新后未签认按新系数重算，不再超限的异常自动关闭", () => {
    const store = makeStore();
    store.ingest(chen, batch({ id: "C-1", sampledAt: "2026-10-07T08:00:00+08:00", durationSec: 60, rawCount: 9 })); // 3180 正常(v1)
    store.publishPolicy(wang, policyV2); // → 3180 > 3000 超限，生成处置
    expect(store.snapshot().dispositions[0]?.status).toBe("open");

    store.addCalibration(wang, {
      id: "CAL-2",
      instrumentId: "P-01",
      calibratedAt: "2026-10-06T00:00:00+08:00",
      correctionFactor: 0.92, // 3180 → 2926 < 3000
      certificateNo: "QC-2",
    });
    const rec = store.snapshot().records.find((r) => r.batch.id === "C-1")!;
    expect(rec.determination?.countsPerM3).toBe(2926);
    expect(rec.determination?.calibrationId).toBe("CAL-2");
    expect(rec.determination?.status).toBe("normal");
    expect(store.snapshot().dispositions[0]?.status).toBe("closed"); // 自动关闭
  });
});

describe("角色权限", () => {
  it("巡检员可提交/补录，班组长可签认，审计员只读", () => {
    const store = makeStore();
    expect(() => store.ingest(zhao, batch({ id: "Z-1", sampledAt: "2026-10-07T08:00:00+08:00", durationSec: 60, rawCount: 1 }))).toThrow(PermissionError);

    store.ingest(chen, batch({ id: "P-1", sampledAt: "2026-10-07T08:00:00+08:00", durationSec: 60, rawCount: 99 })); // 超限
    expect(() => store.acknowledge(chen, "P-1", "越权")).toThrow(PermissionError);
    expect(() => store.acknowledge(zhao, "P-1", "越权")).toThrow(PermissionError);
    expect(() => store.publishPolicy(chen, policyV2)).toThrow(PermissionError);

    const d = store.acknowledge(wang, "P-1", "确认，安排复测");
    expect(d.status).toBe("acknowledged");
    expect(d.snapshot?.countsPerM3).toBeGreaterThan(3520);
  });
});

describe("同一判定出口", () => {
  it("看板指标、异常处置与导出读同一份判定", () => {
    const store = makeStore();
    store.ingest(chen, batch({ id: "E-1", sampledAt: "2026-10-07T08:00:00+08:00", durationSec: 60, rawCount: 12 })); // 超限
    store.ingest(chen, batch({ id: "E-2", sampledAt: "2026-10-07T08:10:00+08:00", durationSec: 30, rawCount: 5 })); // 待补采

    const m = store.metrics();
    expect(m.exceededOpen).toBe(1);
    expect(m.pendingResample).toBe(1);

    const csv = store.exportCsv();
    const row1 = csv.split("\n").find((l) => l.includes("E-1"))!;
    const row2 = csv.split("\n").find((l) => l.includes("E-2"))!;
    expect(row1).toContain("超限");
    expect(row1).toContain("TP-V1");
    expect(row2).toContain("待补采");
  });
});
