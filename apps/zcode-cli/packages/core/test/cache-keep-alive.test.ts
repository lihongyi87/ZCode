import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKeepAlivePingMessage,
  resolveKeepAliveIdleThresholdMs,
} from "../src/runtime/methods/cache-keep-alive.js";
import {
  DEFAULT_MICROCOMPACT_THRESHOLD_RATIO,
  buildDefaultMicrocompactThreshold,
} from "../src/compact/microcompact.js";

/**
 * 缓存保活器测试：阈值解析与 ping 消息构造（Plan ④）。
 * 定时器行为与投影依赖 runtime 内部件，由活体烟测覆盖（four-feature-e2e-validation.md）。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/cache-keep-alive.test.ts
 */

test("空闲阈值：默认 25 分钟，显式配置生效，非法值回退", () => {
  assert.equal(resolveKeepAliveIdleThresholdMs(undefined), 25 * 60_000);
  assert.equal(resolveKeepAliveIdleThresholdMs({}), 25 * 60_000);
  assert.equal(resolveKeepAliveIdleThresholdMs({ idleThresholdMs: 10 * 60_000 }), 10 * 60_000);
  assert.equal(resolveKeepAliveIdleThresholdMs({ idleThresholdMs: -1 }), 25 * 60_000);
  assert.equal(resolveKeepAliveIdleThresholdMs({ idleThresholdMs: Number.NaN }), 25 * 60_000);
});

test("ping 消息：user 角色 + 固定文本", () => {
  const ping = buildKeepAlivePingMessage();
  assert.equal(ping.role, "user");
  assert.ok(JSON.stringify(ping.content).includes("keep-alive ping"));
});

test("微压缩阈值 env 旋钮：默认走比例口径（回归保护）", () => {
  // 无 env 时：min(0.9×阈值, 阈值−2K buffer)——以 200K 阈值为例 ≈ 165K。
  const t = buildDefaultMicrocompactThreshold(178_000);
  const byRatio = Math.floor(178_000 * DEFAULT_MICROCOMPACT_THRESHOLD_RATIO);
  const byBuffer = 178_000 - 2_000;
  assert.equal(t, Math.min(byRatio, byBuffer));
});
