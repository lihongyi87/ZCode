import assert from "node:assert/strict";
import test from "node:test";

import {
  beginStreamRecoveryAttempt,
  hasStreamRecoveryBudget,
  resetStreamRecoveryBudgetOnSuccess,
} from "../src/runtime/methods/streaming-recovery.js";
import type { RegularTurnLoopState } from "../src/runtime/methods/turn-loop-state.js";

/**
 * 流恢复预算语义回归：预算 = 「连续失败次数」，不是整个 turn 生命周期累计。
 *
 * 背景（「长任务经常自己停止」根因）：长任务一个 turn 横跨上百个模型步、
 * 可运行数小时。GLM 网关偶发流抖动每次消耗 1 次恢复额度，旧实现只增不重置，
 * 累计到 STREAM_RECOVERY_MAX_RETRIES(10) 后预算耗尽——下一次抖动直接杀死
 * 整个 turn。修复：模型步完整返回即归零；同一处连续失败仍在 10 次内熔断。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/streaming-recovery.test.ts
 */

const state = (retryCount: number) =>
  ({ streamRecoveryRetryCount: retryCount }) as unknown as RegularTurnLoopState;

test("熔断性质不回归：连续失败到 10 次后预算耗尽", () => {
  const s = state(0);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(hasStreamRecoveryBudget(s), true, `第 ${i} 次失败前应有预算`);
    beginStreamRecoveryAttempt(s);
  }
  assert.equal(hasStreamRecoveryBudget(s), false, "连续第 10 次后必须熔断");
});

test("成功即重置：长任务偶发抖动不累计（本次修复的核心命题）", () => {
  // 长任务形态：抖动→恢复→成功→（数十步正常）→再抖动……
  for (let round = 0; round < 50; round += 1) {
    const s = state(9); // 假设已累计 9 次（旧实现此处下一次抖动就死）
    beginStreamRecoveryAttempt(s);
    assert.equal(hasStreamRecoveryBudget(s), false);
    // 恢复后的模型步完整返回 → 归零
    resetStreamRecoveryBudgetOnSuccess(s);
    assert.equal(hasStreamRecoveryBudget(s), true, `round ${round}: 成功后预算必须重置`);
  }
});

test("重置不改变计数起点：归零后从 1 重新计数", () => {
  const s = state(7);
  resetStreamRecoveryBudgetOnSuccess(s);
  const attempt = beginStreamRecoveryAttempt(s);
  assert.equal(attempt.retryNumber, 1);
  assert.equal(attempt.maxRetries, 10);
});

// ── ① 错误分类学重试间隔（吸收 codex retry_delay 三分类） ──

test("① 终态错误：鉴权/模型不存在不重试（返回 null 且不再消耗恢复预算的判定面）", async () => {
  const { isTerminalStreamFailure, streamRecoveryRetryDelayMs } = await import(
    "../src/runtime/methods/streaming-recovery.js"
  );
  const authError = Object.assign(new Error("API key invalid: 401 unauthorized"), {
    code: "model_auth_failed",
    context: { status: 401 },
  });
  assert.equal(isTerminalStreamFailure(authError), true);
  assert.equal(streamRecoveryRetryDelayMs(authError, 1), null);
  const notFound = Object.assign(new Error("model not found: glm-x"), { code: "model_not_found" });
  assert.equal(isTerminalStreamFailure(notFound), true);
  // 普通网络错误不是终态
  const netError = Object.assign(new Error("socket hang up"), { code: "model_network_error" });
  assert.equal(isTerminalStreamFailure(netError), false);
});

test("① 服务器显式建议优先于指数退避", async () => {
  const { streamRecoveryRetryDelayMs } = await import(
    "../src/runtime/methods/streaming-recovery.js"
  );
  const err = Object.assign(new Error("rate limited"), {
    code: "model_rate_limited",
    context: { status: 429, retryAfterMs: 12_000 },
  });
  assert.equal(streamRecoveryRetryDelayMs(err, 5), 12_000);
});

test("① 本地指数退避+确定性抖动：限流基座 2s、网络基座 400ms，×2^(n-1) 封顶 8s", async () => {
  const { streamRecoveryRetryDelayMs } = await import(
    "../src/runtime/methods/streaming-recovery.js"
  );
  const net = Object.assign(new Error("timeout"), { code: "model_request_timeout" });
  const rate = Object.assign(new Error("rate"), {
    code: "model_rate_limited",
    context: { status: 429 },
  });
  // 网络 n=1：400×2^0×1.25=500；n=2：400×2×0.75=600；n=3：400×4×1.25=2000
  assert.equal(streamRecoveryRetryDelayMs(net, 1), 500);
  assert.equal(streamRecoveryRetryDelayMs(net, 2), 600);
  assert.equal(streamRecoveryRetryDelayMs(net, 3), 2000);
  // 限流 n=1：2000×1.25=2500；n=5：2000×16 封顶 8000×1.25=10000
  assert.equal(streamRecoveryRetryDelayMs(rate, 1), 2500);
  assert.equal(streamRecoveryRetryDelayMs(rate, 5), 10000);
  // 封顶验证：n=8 网络 400×128=51200 → cap 8000 ×0.75=6000
  assert.equal(streamRecoveryRetryDelayMs(net, 8), 6000);
});
