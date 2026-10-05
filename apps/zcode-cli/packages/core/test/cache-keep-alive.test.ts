import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKeepAlivePingMessage,
  cancelCacheKeepAlive,
  resolveKeepAliveIdleThresholdMs,
  sendCacheKeepAliveRequestImpl,
} from "../src/runtime/methods/cache-keep-alive.js";
import {
  DEFAULT_MICROCOMPACT_THRESHOLD_RATIO,
  buildDefaultMicrocompactThreshold,
} from "../src/compact/microcompact.js";

/**
 * 缓存保活器测试：阈值解析、ping 消息构造、fire 后续排（Plan ④）。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/cache-keep-alive.test.ts
 */

test("空闲阈值：默认 12 分钟（TTL 实测 15min 全存活取保守值），显式配置生效，非法值回退", () => {
  assert.equal(resolveKeepAliveIdleThresholdMs(undefined), 12 * 60_000);
  assert.equal(resolveKeepAliveIdleThresholdMs({}), 12 * 60_000);
  assert.equal(resolveKeepAliveIdleThresholdMs({ idleThresholdMs: 10 * 60_000 }), 10 * 60_000);
  assert.equal(resolveKeepAliveIdleThresholdMs({ idleThresholdMs: -1 }), 12 * 60_000);
  assert.equal(resolveKeepAliveIdleThresholdMs({ idleThresholdMs: Number.NaN }), 12 * 60_000);
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

test("fire 后续排：ping 完成后重挂定时器（空闲期链式保活），失败也不抛", async () => {
  // 最小 runtime 桩：无模型选择 → 请求体提前返回，但 finally 续排必须发生。
  const runtime = {
    config: { cacheKeepAlive: { enabled: true, idleThresholdMs: 60_000 } },
    getSessionModelSelection: () => null,
  } as unknown as Parameters<typeof sendCacheKeepAliveRequestImpl>[0];
  await sendCacheKeepAliveRequestImpl(runtime);
  assert.ok(runtime.cacheKeepAliveTimer, "fire 后未续排——空闲超过两个 TTL 窗缓存照样过期");
  cancelCacheKeepAlive(runtime);

  // 活动让路不续排：turn 在进行中时 fire，本轮不排（turn 结束会重排）。
  const busy = {
    config: { cacheKeepAlive: {} },
    activeTurn: { turnId: "t1" },
    getSessionModelSelection: () => null,
  } as unknown as Parameters<typeof sendCacheKeepAliveRequestImpl>[0];
  await sendCacheKeepAliveRequestImpl(busy);
  assert.equal(busy.cacheKeepAliveTimer, undefined);
});
