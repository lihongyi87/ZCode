import assert from "node:assert/strict";
import test from "node:test";

import { getContextRemainingHandler } from "../src/tool/handlers/get-context-remaining.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

/**
 * ④ get_context_remaining（吸收 codex）：模型可见的上下文余量仪表。
 * 数据源 contextPressure + model.properties.contextWindow；缺失诚实降级 null。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/get-context-remaining.test.ts
 */

const ctx = (over: Partial<ToolExecutionContext>) =>
  ({ toolCallId: "t1", abortSignal: new AbortController().signal, ...over }) as ToolExecutionContext;

test("pressure+window 齐备：输出窗口、占用百分比、剩余 token", async () => {
  const out = (await getContextRemainingHandler(
    {},
    ctx({
      contextPressure: 0.72,
      model: { properties: { contextWindow: 1_000_000 } } as never,
    }),
  )) as { contextWindow: number; usedPercent: number; tokensLeft: number };
  assert.equal(out.contextWindow, 1_000_000);
  assert.equal(out.usedPercent, 72);
  assert.equal(out.tokensLeft, 280_000);
});

test("缺 pressure（尚无请求）：三字段中占用/剩余为 null，窗口仍在", async () => {
  const out = (await getContextRemainingHandler(
    {},
    ctx({ model: { properties: { contextWindow: 200_000 } } as never }),
  )) as { contextWindow: number | null; usedPercent: number | null; tokensLeft: number | null };
  assert.equal(out.contextWindow, 200_000);
  assert.equal(out.usedPercent, null);
  assert.equal(out.tokensLeft, null);
});

test("缺 window：剩余为 null，不编数", async () => {
  const out = (await getContextRemainingHandler({}, ctx({ contextPressure: 0.5 }))) as {
    contextWindow: number | null;
    tokensLeft: number | null;
  };
  assert.equal(out.contextWindow, null);
  assert.equal(out.tokensLeft, null);
});

test("pressure 封顶：>1 时 usedPercent=100、tokensLeft=0 不为负", async () => {
  const out = (await getContextRemainingHandler(
    {},
    ctx({ contextPressure: 1.2, model: { properties: { contextWindow: 100_000 } } as never }),
  )) as { usedPercent: number; tokensLeft: number };
  assert.equal(out.usedPercent, 100);
  assert.equal(out.tokensLeft, 0);
});
