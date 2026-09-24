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

test("工具结果收尾判定（role:tool 独立消息）", () => {
  const toolResultMessage = { role: "tool", content: [{ type: "text", text: "排盘输出" }] };
  assert.equal(requestEndsWithToolResult([toolResultMessage]), true);
  assert.equal(
    requestEndsWithToolResult([toolResultMessage, { role: "system", content: "x" }]),
    true,
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

test("乱序 values 防御：降档按等级表而非数组顺序（red-team 回归）", () => {
  // 第三方自建 provider 若乱序声明，绝不可把降档变成升档。
  assert.equal(
    resolveAdaptiveReasoningLevel({
      enabled: true,
      currentLevel: "high",
      supportedLevels: ["max", "high", "low", "medium"],
      endsWithToolResult: true,
    }),
    "medium",
  );
  // 全是未知名：放弃降档。
  assert.equal(
    resolveAdaptiveReasoningLevel({
      enabled: true,
      currentLevel: "turbo",
      supportedLevels: ["turbo", "eco"],
      endsWithToolResult: true,
    }),
    undefined,
  );
  // none/disabled 档为 0 级：不降。
  assert.equal(
    resolveAdaptiveReasoningLevel({
      enabled: true,
      currentLevel: "low",
      supportedLevels: ["none", "low", "high"],
      endsWithToolResult: true,
    }),
    "none",
  );
});

test("red-team 回归：真实 wire 形状——工具结果消息是独立 role:tool（不是 user+toolResult 块）", () => {
  // v1 的判定只查 user+toolResult 块，而投影后的续跑请求里最后一条是
  // role:"tool" 消息（见 message-history 的 tool result entry）——降档从未触发。
  const toolResultMessage: { role?: string; content?: unknown } = {
    role: "tool",
    content: [{ type: "text", text: "四柱：丁卯 甲辰 辛亥 癸巳" }],
  };
  assert.equal(
    resolveAdaptiveReasoningLevel({
      enabled: true,
      currentLevel: "high",
      supportedLevels: LEVELS,
      endsWithToolResult: requestEndsWithToolResult([toolResultMessage]),
    }),
    "medium",
  );
  // assistant 收尾仍然不算续跑。
  assert.equal(
    resolveAdaptiveReasoningLevel({
      enabled: true,
      currentLevel: "high",
      supportedLevels: LEVELS,
      endsWithToolResult: requestEndsWithToolResult([
        toolResultMessage,
        { role: "assistant", content: "好的" },
      ]),
    }),
    undefined,
  );
});

test("环境开关", () => {
  assert.equal(isAdaptiveReasoningEnabled({}), false);
  assert.equal(isAdaptiveReasoningEnabled({ ZCODE_ADAPTIVE_REASONING: "0" }), false);
  assert.equal(isAdaptiveReasoningEnabled({ ZCODE_ADAPTIVE_REASONING: "1" }), true);
  assert.equal(isAdaptiveReasoningEnabled({ ZCODE_ADAPTIVE_REASONING: "true" }), true);
});
