import assert from "node:assert/strict";
import test from "node:test";

import { isPlausibleStepSample, smoothLiveEstimate } from "../src/v4/composer/StreamSpeedPill.tsx";

/**
 * 速度药丸 v3 防冲刷回归：重连重放/缓冲一次性冲刷会把数千字符在数百毫秒内
 * 送达，隐含速度破万（实测经常飙到上万 tok/s）。锁死两条防护的性质：
 * 1. 超解码合理上限的样本必被弃样（不污染滑窗均值）；
 * 2. 实时估算永远不超上限，且向上一读数收敛（不因单批次抖动跳变）。
 *
 * 运行：node scripts/run-tests.mjs（packages/ui 已登记）
 */

test("弃样：隐含速度超解码合理上限（重连重放冲刷伪象）", () => {
  // 2400 tokens 在 200ms 内到达 = 12000 tok/s——v2 实测的飙万形态。
  assert.equal(isPlausibleStepSample(2400, 200), false);
  // 刚好越线（401 tok/s）也弃。
  assert.equal(isPlausibleStepSample(401, 1000), false);
});

test("弃样：时长区间与最小 token 量的原有守卫不回归", () => {
  assert.equal(isPlausibleStepSample(60, 299), false); // <300ms
  assert.equal(isPlausibleStepSample(60, 120_001), false); // >120s
  assert.equal(isPlausibleStepSample(49, 1000), false); // <50 tok，信噪比差
  assert.equal(isPlausibleStepSample(0, 500), false);
});

test("保留：真实解码速度的样本入窗", () => {
  assert.equal(isPlausibleStepSample(60, 1000), true); // 60 tok/s
  assert.equal(isPlausibleStepSample(300, 1000), true); // 300 tok/s（flash 系峰值）
  assert.equal(isPlausibleStepSample(400, 1000), true); // 恰在上限
});

test("实时估算：冲刷原始值被截断到解码合理上限", () => {
  // 无上一读数：12480 → 400
  assert.equal(smoothLiveEstimate(null, 12_480), 400);
  assert.equal(smoothLiveEstimate(undefined as unknown as null, 999_999), 400);
});

test("实时估算：向上一读数收敛一半（抗单批次抖动）", () => {
  // 上一读数 60，冲刷原始 12000 → (60+400)/2 = 230，不会瞬间跳到 400。
  assert.ok(Math.abs(smoothLiveEstimate(60, 12_000) - 230) < 1e-9);
  // 正常上升也一样平滑：60 → 原始 100 → 80。
  assert.ok(Math.abs(smoothLiveEstimate(60, 100) - 80) < 1e-9);
  // 下降同理：100 → 原始 40 → 70。
  assert.ok(Math.abs(smoothLiveEstimate(100, 40) - 70) < 1e-9);
});

test("实时估算：负值/非有限值防御", () => {
  assert.equal(smoothLiveEstimate(null, -5), 0);
  assert.equal(smoothLiveEstimate(50, Number.NaN), 50); // NaN 收敛回上一读数
});
