// 核心规则自测：esbuild 打包后 node 执行
import { buildSeed } from "../src/domain/seed";
import {
  evaluateBatch,
  sampleVolume,
  activePolicy,
  MIN_VOLUME_L,
} from "../src/domain/evaluation";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`FAIL: ${name} ${extra}`);
  }
}

const now = Date.now();
const seed = buildSeed(now);
const ctx0 = {
  instruments: seed.instruments,
  calibrations: seed.calibrations,
  policies: seed.policies,
  dispositions: seed.dispositions,
};

// 1. 体积换算
assert("30s @2.83Lpm = 1.415L", Math.abs(sampleVolume(2.83, 30) - 1.415) < 1e-9);
assert("2L 下限", MIN_VOLUME_L === 2);

// 2. 低体积批次 → resample，不判异
const low = seed.batches.find((b) => b.id === "B2026100701")!;
const evLow = evaluateBatch(low, ctx0);
assert("低体积 resample", evLow.verdict === "resample", evLow.verdict);
assert("低体积无 active", evLow.active === null);

// 3. 阈值版本选择
assert(
  "当前有效版本为 2025版",
  activePolicy(seed.policies, now)?.version === "2025版"
);
assert(
  "15 天前有效版本为 2024版",
  activePolicy(seed.policies, now - 15 * 24 * 3600 * 1000)?.version === "2024版"
);

// 4. 未签认：12 天前 ISO6，原 2024版合格，2025版重算 → 异常 28975
const flip = seed.batches.find((b) => b.id === "B2026092502")!;
const evFlip = evaluateBatch(flip, ctx0);
assert("未签认按新阈值重算异常", evFlip.verdict === "abnormal");
assert("浓度 28975", evFlip.perM3 === 28975, String(evFlip.perM3));
assert("版本 2025版", evFlip.active?.policyVersion === "2025版");
assert("未签认", evFlip.signed === false);

// 同一批次在仅 2024版政策下合格（验证“翻转”确实由阈值更新引起）
const evFlipV1 = evaluateBatch(flip, { ...ctx0, policies: seed.policies.filter((p) => p.id === "POL-V1") });
assert("回退 2024版 时合格", evFlipV1.verdict === "qualified", evFlipV1.verdict);

// 5. 合格批次
const q1 = seed.batches.find((b) => b.id === "B2026100601")!;
const evQ1 = evaluateBatch(q1, ctx0);
assert("ISO5 1413 合格", evQ1.verdict === "qualified", String(evQ1.perM3));
const q2 = seed.batches.find((b) => b.id === "B2026100703")!;
assert("ISO7 黄光区 226148 合格", evaluateBatch(q2, ctx0).verdict === "qualified");

// 6. 已签认冻结：4594 / 2024版 / 系数1；现行 2025版 ISO5 同限，perM3 不变但版本变化
const signed = seed.batches.find((b) => b.id === "B2026092202")!;
const evSigned = evaluateBatch(signed, ctx0);
assert("签认 abnormal 保留", evSigned.verdict === "abnormal");
assert("签认原值 4594", evSigned.perM3 === 4594, String(evSigned.perM3));
assert("签认版本 2024版", evSigned.active?.policyVersion === "2024版");
assert("旁示现行版本 2025版", evSigned.live?.policyVersion === "2025版");
assert("签认系数 1", evSigned.factor === 1);

// 7. 再收紧阈值：未签认翻转批次仍随新版；已签认不变
const ctxTight = {
  ...ctx0,
  policies: [
    ...seed.policies,
    {
      id: "POL-V3",
      version: "2026版",
      effectiveAt: now,
      createdAt: now,
      createdBy: "t",
      note: "ISO6 收紧至 25000",
      limits: { "ISO 5": 3520, "ISO 6": 25000, "ISO 7": 352000 },
    },
  ],
};
assert(
  "未签认随 2026版 仍异常且版本更新",
  evaluateBatch(flip, ctxTight).active?.policyVersion === "2026版"
);
const s2 = evaluateBatch(signed, ctxTight);
assert("已签认版本仍冻结 2024版", s2.active?.policyVersion === "2024版" && s2.perM3 === 4594);
assert("已签认旁示 2026版", s2.live?.policyVersion === "2026版");

// 8. 校准更新：未签认重算系数；已签认冻结系数
const ctxCal = {
  ...ctx0,
  calibrations: [
    ...seed.calibrations,
    {
      id: "CAL-X",
      instrumentId: "LPC-01",
      effectiveAt: now,
      factor: 2,
      note: "t",
      createdAt: now,
      createdBy: "t",
    },
  ],
};
const probe = {
  ...flip,
  id: "PROBE-1",
  sampleKey: "PROBE",
  instrumentId: "LPC-01",
  durationSec: 60,
  rawCount: 100,
};
assert("系数1 时 35336", evaluateBatch(probe, ctx0).perM3 === 35336);
assert("系数2 时 70671", evaluateBatch(probe, ctxCal).perM3 === 70671);
assert("已签认系数仍冻结 1", evaluateBatch(signed, ctxCal).factor === 1);

// 9. outbox 批次可被纯函数预览判定（入库与否不影响判定逻辑）
const ob = seed.batches.find((b) => b.id === "B2026100704")!;
const evOb = evaluateBatch(ob, ctx0);
assert("outbox 预览异常 35336", evOb.verdict === "abnormal" && evOb.perM3 === 35336);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
