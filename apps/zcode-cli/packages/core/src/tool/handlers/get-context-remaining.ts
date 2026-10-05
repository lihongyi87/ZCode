import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";
import {
  GetContextRemainingInputJsonSchema,
  GetContextRemainingInputSchema,
  GetContextRemainingOutputJsonSchema,
  GetContextRemainingOutputSchema,
  type GetContextRemainingInput,
  type GetContextRemainingOutput,
} from "@zcode/contracts";

/**
 * 模型可见的上下文余量仪表（吸收自 codex get_context_remaining）。
 *
 * 数据源是执行器已逐调用注入的 `context.contextPressure`（最近模型请求的
 * 上下文占用 0-1，与压力感知输出预算同源）+ `context.model` 声明的窗口。
 * 任一缺失返回 null 字段（诚实降级），不估算、不编数。
 */
export const GET_CONTEXT_REMAINING_TOOL_NAME = "GetContextRemaining";

export const getContextRemainingHandler: ToolHandler = async (_input, context) => {
  const contextWindow = context.model?.properties.contextWindow;
  const windowTokens =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.floor(contextWindow)
      : null;
  const pressure =
    typeof context.contextPressure === "number" &&
    Number.isFinite(context.contextPressure) &&
    context.contextPressure >= 0
      ? context.contextPressure
      : null;
  const usedPercent = pressure === null ? null : Math.min(100, Math.round(pressure * 100));
  const tokensLeft =
    windowTokens !== null && pressure !== null
      ? Math.max(0, Math.round(windowTokens * (1 - pressure)))
      : null;

  const output: GetContextRemainingOutput = GetContextRemainingOutputSchema.parse({
    contextWindow: windowTokens,
    usedPercent,
    tokensLeft,
  });
  return output as unknown;
};

export const getContextRemainingToolEntry: ToolEntry = {
  capability: "Report remaining context window budget for the current session",
  metadata: {
    name: GET_CONTEXT_REMAINING_TOOL_NAME,
    description:
      "Get the remaining token budget in the current context window (contextWindow, usedPercent, tokensLeft; null when unavailable). " +
      "Use it before planning very long outputs or large reads in a long session: when tokensLeft is low, deliver results incrementally, prefer targeted reads over whole-file reads, and suggest the user compact or start a new session instead of silently truncating work.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 5_000,
    maxOutputBytes: 2_048,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: getContextRemainingHandler,
  inputSchema: GetContextRemainingInputJsonSchema,
  outputSchema: GetContextRemainingOutputJsonSchema,
  runtimeInputSchema: GetContextRemainingInputSchema,
  runtimeOutputSchema: GetContextRemainingOutputSchema,
  permission: {
    permission: "getContextRemaining",
    reason: "GetContextRemaining only reports the session context budget",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 2_048,
    maxModelBytes: 2_048,
    strategy: "truncate" as const,
    preview: {
      maxBytes: 2_048,
      direction: "head" as const,
    },
  },
  timeout: {
    defaultMs: 5_000,
    maxMs: 5_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "GetContextRemaining was cancelled before the context budget was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
