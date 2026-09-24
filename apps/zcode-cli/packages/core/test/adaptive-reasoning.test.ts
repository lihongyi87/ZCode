import assert from "node:assert/strict";
import test from "node:test";
import {
  isAdaptiveReasoningEnabled,
  requestEndsWithToolResult,
  resolveAdaptiveReasoningLevel,
} from "../src/model/adaptive-reasoning.js";

/**
 * 自适应思考档路由测试：默认关闭；续跑步降一档；首步/低档/单档/未配置不降；
 * 工具结果判定覆盖 user 角色的 toolResult 块形态。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/adaptive-reasoning.test.ts
 */

const LEVELS = ["low", "medium", "high"] as const;

test("默认关闭：任何场景都不覆盖", () => {
  assert.equal(
    resolveAdaptiveReasoningLevel({
      enabled: false,
      currentLevel: "high",
      supportedLevels: LEVELS,
      endsWithToolResult: true,
    }),
    undefined,
  );
});

test("续跑步：降一档", () => {
  assert.equal(
    resolveAdaptiveReasoningLevel({
      enabled: true,
      currentLevel: "high",
      supportedLevels: LEVELS,
      endsWithToolResult: true,
    }),
    "medium",
  );
  assert.equal(
    resolveAdaptiveReasoningLevel({
      enabled: true,
      currentLevel: "medium",
      supportedLevels: LEVELS,
      endsWithToolResult: true,
    }),
    "low",
  );
});

test("首步（非工具结果收尾）：保持配置档", () => {
  assert.equal(
    resolveAdaptiveReasoningLevel({
      enabled: true,
      currentLevel: "high",
      supportedLevels: LEVELS,
      endsWithToolResult: false,
    }),
    undefined,
  );
});

test("已是最低档/单档/未配置档位：不降", () => {
  assert.equal(
    resolveAdaptiveReasoningLevel({
      enabled: true,
      currentLevel: "low",
      supportedLevels: LEVELS,
      endsWithToolResult: true,
    }),
    undefined,
  );
  assert.equal(
    resolveAdaptiveReasoningLevel({
      enabled: true,
      currentLevel: "x",
      supportedLevels: ["x"],
      endsWithToolResult: true,
    }),
    undefined,
  );
  assert.equal(
    resolveAdaptiveReasoningLevel({
      enabled: true,
      supportedLevels: LEVELS,
      endsWithToolResult: true,
    }),
    undefined,
  );
});

test("工具结果收尾判定", () => {
  const toolResultMsg = {
    role: "user",
    content: [{ type: "toolResult", toolCallId: "t1", output: "ok" }],
  };
  assert.equal(requestEndsWithToolResult([toolResultMsg]), true);
  // system 垫在尾部时仍看最后一条非 system。
  assert.equal(requestEndsWithToolResult([toolResultMsg, { role: "system", content: "x" }]), true);
  // 纯文本 user 消息（首步）不算。
  assert.equal(
    requestEndsWithToolResult([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
    false,
  );
  // assistant 收尾（流式恢复后重放）不算。
  assert.equal(
    requestEndsWithToolResult([{ role: "assistant", content: [{ type: "text", text: "x" }] }]),
    false,
  );
});

test("环境开关", () => {
  assert.equal(isAdaptiveReasoningEnabled({}), false);
  assert.equal(isAdaptiveReasoningEnabled({ ZCODE_ADAPTIVE_REASONING: "0" }), false);
  assert.equal(isAdaptiveReasoningEnabled({ ZCODE_ADAPTIVE_REASONING: "1" }), true);
  assert.equal(isAdaptiveReasoningEnabled({ ZCODE_ADAPTIVE_REASONING: "true" }), true);
});
