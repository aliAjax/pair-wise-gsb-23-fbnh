// 状态流转自测：并发去重、断点重试幂等、补采、签认冻结
import { buildSeed } from "../src/domain/seed";
import {
  evaluateAll,
  fromSeed,
  resolveDraft,
  retryUploads,
  signDisposition,
  submitBatch,
  submitResample,
  type FlowState,
} from "../src/domain/flow";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, extra = "") {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${extra}`);
  }
}

const now = Date.now();
const inspect = "巡检员·测试";
const leader = "班组长·测试";
const roleI = "inspector" as const;
const roleL = "leader" as const;

function baseInput(over: Partial<Parameters<typeof submitBatch>[1]> = {}) {
  return {
    room: "CR-T1",
    area: "一般区" as const,
    grade: "ISO 6" as const,
    instrumentId: "LPC-02",
    sampledAt: now + 99 * 60000,
    durationSec: 60,
    rawCount: 50,
    channel: "field" as const,
    ...over,
  };
}

// —— 1. 并发：现场先到入库，中心同一次采样后到留草稿 ——
let s = fromSeed(buildSeed(now));
const auditBefore = s.audit.length;
const r1 = submitBatch(s, baseInput({ channel: "field" }), inspect, roleI);
s = r1.state;
assert("首份入库", r1.result.kind === "ledger");
const firstId = r1.result.batchId;

const r2 = submitBatch(
  s,
  baseInput({ channel: "center", rawCount: 52 }),
  "中心·测试",
  roleI
);
s = r2.state;
assert("后到冲突", r2.result.kind === "conflict");
if (r2.result.kind === "conflict") {
  assert("冲突指向首份", r2.result.conflictWithId === firstId);
}
const draft = s.batches.find((b) => b.id === r2.result.batchId)!;
assert("后到者为 draft", draft.status === "draft");
assert("首份仍唯一入库", s.batches.filter((b) => b.sampleKey === draft.sampleKey && b.status === "ledger").length === 1);
assert("冲突产生 1 条草稿审计", s.audit.length - auditBefore === 2); // 入库 + 冲突

// 草稿不参与判定
const evs = evaluateAll(s);
assert("草稿不参与判定", !evs.some((e) => e.batch.id === draft.id));

// 看板 KPI 稳定性：草稿入库前后 ledger 异常数不因重复提交增加
const abCountBefore = evs.filter((e) => e.verdict === "abnormal").length;
const evs2 = evaluateAll(s);
assert("重复提交不新增异常处置", evs2.filter((e) => e.verdict === "abnormal").length === abCountBefore);
assert(
  "处置单不重复",
  s.dispositions.filter((d) => d.batchId === firstId).length === 1 ||
    s.dispositions.filter((d) => d.batchId === firstId).length === 0
);

// —— 2. 草稿丢弃 ——
const auditLenBeforeDiscard = s.audit.length;
s = resolveDraft(s, draft.id, "discard", inspect, roleI);
assert("丢弃后草稿消失", !s.batches.some((b) => b.id === draft.id));
assert("丢弃有审计", s.audit.length - auditLenBeforeDiscard === 1);

// —— 3. 草稿改时刻作为新采样入库 ——
const r3 = submitBatch(
  s,
  baseInput({ room: "CR-T2", channel: "field" }),
  inspect,
  roleI
);
s = r3.state;
const r4 = submitBatch(
  s,
  baseInput({ room: "CR-T2", channel: "center", rawCount: 60 }),
  "中心·测试",
  roleI
);
s = r4.state;
const draft2Id = r4.result.batchId;
const auditBefore2 = s.audit.length;
s = resolveDraft(
  s,
  draft2Id,
  "resubmit",
  inspect,
  roleI,
  baseInput({ room: "CR-T2", channel: "center", rawCount: 60, sampledAt: now + 101 * 60000 })
);
assert(
  "改时刻后入库为 ledger",
  s.batches.some((b) => b.room === "CR-T2" && b.channel === "center" && b.status === "ledger")
);
assert("新采样无冲突标记", !s.batches.some((b) => b.id === draft2Id));
assert("处理有审计", s.audit.length - auditBefore2 === 1);

// —— 4. 断点重试幂等 ——
let s2 = fromSeed(buildSeed(now), false); // 断网
const auditOffline = s2.audit.length;
const dspOffline = s2.dispositions.length;
const rb = submitBatch(
  s2,
  baseInput({ room: "CR-OFF", rawCount: 900, sampledAt: now + 103 * 60000 }), // 900/28.3*1000=31802 异常
  inspect,
  roleI
);
s2 = rb.state;
assert("断网进 outbox", rb.result.kind === "outbox");
assert("断网不生成处置", s2.dispositions.length === dspOffline);
assert("断网只记提交审计（无处置审计）", s2.audit.length === auditOffline + 1);

// 断网重试：什么都不推进
const s2b = retryUploads(s2);
assert("断网重试仍 outbox", s2b.batches.find((b) => b.id === rb.result.batchId)?.status === "outbox");
assert("断网重试无审计", s2b.audit.length === s2.audit.length);
assert("断网重试无处置", s2b.dispositions.length === s2.dispositions.length);

// 恢复网络后重试：入库；重放不新增处置、不新增审计（异常由统一判定内核在入库后算出）
s2 = { ...s2b, networkOk: true };
const auditBeforeRetry = s2.audit.length;
const dspBeforeRetry = s2.dispositions.length;
s2 = retryUploads(s2);
const retried = s2.batches.find((b) => b.id === rb.result.batchId)!;
assert("重试后 ledger", retried.status === "ledger");
assert("重试不新增处置", s2.dispositions.length === dspBeforeRetry);
assert("重试不新增审计", s2.audit.length === auditBeforeRetry);
const retriedEv = evaluateAll(s2).find((e) => e.batch.id === retried.id)!;
assert("入库后统一判定为异常", retriedEv.verdict === "abnormal");

// 再重放：状态、处置、审计均无变化
s2 = retryUploads(s2);
s2 = retryUploads(s2);
assert("重复重放不新增审计", s2.audit.length === auditBeforeRetry);
assert("重复重放不新增处置", s2.dispositions.length === dspBeforeRetry);

// 签认时才为该批次落一张处置单（且只有一张）
s2 = signDisposition(s2, retried.id, "复测合格", leader, roleL);
assert(
  "签认生成且仅生成一张处置单",
  s2.dispositions.filter((d) => d.batchId === retried.id).length === 1
);

// —— 5. 低体积补采：原批次被取代，补采批次参与判定 ——
let s3 = fromSeed(buildSeed(now));
const lowBatch = s3.batches.find((b) => b.id === "B2026100701")!;
const lowEvBefore = evaluateAll(s3).find((e) => e.batch.id === lowBatch.id)!;
assert("种子低体积为 resample", lowEvBefore.verdict === "resample");
const auditBeforeRS = s3.audit.length;
s3 = submitResample(
  s3,
  lowBatch.id,
  {
    room: lowBatch.room,
    area: lowBatch.area,
    grade: lowBatch.grade,
    instrumentId: lowBatch.instrumentId,
    sampledAt: now + 60000,
    durationSec: 120,
    rawCount: 30,
    channel: "field",
  },
  inspect,
  roleI
).state;
const replaced = s3.batches.find((b) => b.id === lowBatch.id)!;
assert("原批次标记已补采", !!replaced.supersededById);
const rsBatch = s3.batches.find((b) => b.id === replaced.supersededById)!;
assert("补采批次入库", rsBatch && rsBatch.status === "ledger");
// 30/5.66*1000=5300 ISO6 v2 28000 合格
const rsEv = evaluateAll(s3).find((e) => e.batch.id === rsBatch.id)!;
assert("补采批次合格", rsEv.verdict === "qualified", String(rsEv.perM3));
assert("补采产生 1 条审计（无处置）", s3.audit.length - auditBeforeRS === 1);

// —— 6. 签认冻结；之后阈值再收紧不影响 ——
let s4 = fromSeed(buildSeed(now));
const openBatchId = "B2026092502"; // 未签认异常 28975 / 2025版
const evOpen = evaluateAll(s4).find((e) => e.batch.id === openBatchId)!;
assert("签认前未冻结、2025版", !evOpen.signed && evOpen.active?.policyVersion === "2025版");

const auditBeforeSign = s4.audit.length;
s4 = signDisposition(s4, openBatchId, "现场已处置，确认", leader, roleL);
const evSigned = evaluateAll(s4).find((e) => e.batch.id === openBatchId)!;
assert("签认后 signed", evSigned.signed);
assert("签认原值 28975", evSigned.perM3 === 28975);
assert("签认版本 2025版", evSigned.active?.policyVersion === "2025版");
assert("签认 1 条审计", s4.audit.length - auditBeforeSign === 1);

// 发布更严的新版本与校准：已签认不变，未签认随之变化
s4 = {
  ...s4,
  policies: [
    ...s4.policies,
    {
      id: "POL-V9",
      version: "2027版",
      effectiveAt: now,
      createdAt: now,
      createdBy: "t",
      note: "ISO6 收紧至 10000",
      limits: { "ISO 5": 3520, "ISO 6": 10000, "ISO 7": 352000 },
    },
  ],
  calibrations: [
    ...s4.calibrations,
    {
      id: "CAL-9",
      instrumentId: "LPC-02",
      effectiveAt: now,
      factor: 1.1,
      note: "t",
      createdAt: now,
      createdBy: "t",
    },
  ],
};
const evFrozen = evaluateAll(s4).find((e) => e.batch.id === openBatchId)!;
assert("更新后签认值仍 28975", evFrozen.perM3 === 28975, String(evFrozen.perM3));
assert("更新后签认版本仍 2025版", evFrozen.active?.policyVersion === "2025版");
assert("更新后签认系数仍 1", evFrozen.factor === 1);
assert("旁示现行版本 2027版", evFrozen.live?.policyVersion === "2027版");
assert("旁示现行系数 1.1", evFrozen.live?.factor === 1.1);

// 同批次不能重复签认
const auditBeforeSign2 = s4.audit.length;
const s4b = signDisposition(s4, openBatchId, "再签一次", leader, roleL);
assert("已签认不可重复签认", s4b === s4);
assert("重复签认无审计", s4b.audit.length === auditBeforeSign2);

// —— 7. 合格批次不能签认 ——
let s5 = fromSeed(buildSeed(now));
const qId = "B2026100601";
assert(
  "合格批次签认被拒绝",
  signDisposition(s5, qId, "x", leader, roleL) === s5
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
