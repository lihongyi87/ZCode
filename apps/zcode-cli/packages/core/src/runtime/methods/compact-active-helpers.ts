import {
  COMPACT_PROMPT_TOO_LONG_USER_MESSAGE,
  CoreErrorType,
  createCoreError,
  formatCompactSummary,
} from "../deps.js";
import type { CompactTimelinePayload, SessionEvent, SessionEventType, TraceContext } from "../deps.js";
import {
  buildProviderRequestMessages,
  createModelContextExceededFinishError,
  isContextExceededFinishReason,
  readRawFinishReason,
} from "../helpers/index.js";
import type { RuntimeModelTextResult, RunModelTextRequestOptions } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

export const COMPACT_TOOL_USE_DENIAL_MESSAGE = "Tool use is not allowed during compaction";
export const COMPACT_TOOL_USE_DENIAL_REASON =
  "compaction agent should only produce text summary";

/**
 * 收缩校验判定（吸收 DSH region.ts:417-421）：摘要必须比被遮蔽区更小。
 * 迷你会话（< minShadowedTokens，通常是手动 /compact）没有统计意义，跳过校验。
 */
export function compactSummaryShrinkViolation(
  shadowedTokens: number,
  summaryTokens: number,
  options: { minShadowedTokens?: number } = {},
): boolean {
  if (shadowedTokens < (options.minShadowedTokens ?? 1024)) return false;
  return summaryTokens >= shadowedTokens;
}

/** 摘要被输出上限截断的统一文案（吸收 pi：length 同样拒绝落盘）。 */
export const COMPACT_SUMMARY_TRUNCATED_MESSAGE =
  "Compact summary hit the output token limit and was truncated; discarded instead of persisted";

export function createCompactPromptTooLongError(options: {
  attempt: number;
  cause?: unknown;
  preCompactTokenCount: number;
}): Error {
  return createCoreError(
    CoreErrorType.ModelContextExceeded,
    COMPACT_PROMPT_TOO_LONG_USER_MESSAGE,
    {
      cause: options.cause instanceof Error ? options.cause : undefined,
      context: {
        compactPromptTooLongAttempts: options.attempt,
        preCompactTokenCount: options.preCompactTokenCount,
      },
      recoverable: true,
      // 修复原因：compact 内部已经完成最多 3 次旧轮次截断重试；
      // 最终仍超窗时不能再被 auto compact 外层重试放大成 3x3。
      retryable: false,
    },
  );
}

export function createCompactContextExceededFinishError(
  result: RuntimeModelTextResult,
): Error | undefined {
  const rawFinishReason = readRawFinishReason(result.providerMetadata);
  if (
    !isContextExceededFinishReason(result.finishReason, rawFinishReason) &&
    !isCompactEmptyLengthFinish(result)
  ) {
    return undefined;
  }

  return createModelContextExceededFinishError({
    finishReason: result.finishReason,
    rawFinishReason,
  });
}

function isCompactEmptyLengthFinish(result: RuntimeModelTextResult): boolean {
  // GLM/Z.AI compact 可能以 length + 空文本完成，真实含义是没有可保存的 summary；
  // 仅在 compact 路径把它归类为超窗压力，复用已有 prompt-too-long 降输入重试。
  return result.finishReason.trim().toLowerCase() === "length" && result.text.trim().length === 0;
}

export async function persistCompactTimelineEvent(
  runtime: AgentRuntimeInternal,
  type: SessionEventType,
  payload: CompactTimelinePayload,
  traceContext: TraceContext,
  events: SessionEvent[],
): Promise<void> {
  await runtime.persistCompactTimeline(payload, traceContext);
  const event = runtime.createEvent(type, payload, traceContext);
  await runtime.appendEvent(event, traceContext);
  events.push(event);
}

export function buildCompactSummaryRequestMessages(
  entriesForSummary: readonly RuntimeMessageEntry[],
  compactPrompt: string,
  options: {
    useMidConversationSystem?: boolean;
    foldRemindersIntoToolResults?: boolean;
    loadedToolCallIds?: ReadonlySet<string>;
  } = {},
): RunModelTextRequestOptions["messages"] {
  const projected = buildProviderRequestMessages({
    entries: [
      ...entriesForSummary,
      { message: { role: "user" as const, content: compactPrompt } },
    ],
    applyCacheControl: true,
    skipCacheWrite: true,
    useMidConversationSystem: options.useMidConversationSystem,
    foldRemindersIntoToolResults: options.foldRemindersIntoToolResults,
    loadedToolCallIds: options.loadedToolCallIds,
  }).messages;
  // 148②（吸收 pi 1.2.0）：摘要请求剥离历史 reasoning 块。thinking 签名只对产生它的
  // 模型有效，对摘要模型是无效负载；重放的推理也不在真实上下文里，原样携带只会把
  // 摘要请求撑大（极端时比被摘要的历史还大）。live 请求与跨模型卫生（148①）不受影响：
  // 预算估算（estimateRuntimeEntryTokens）与 post-compact 保留轮仍按 live 口径。
  return projected.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
    const withoutReasoning = message.content.filter((block) => block.type !== "reasoning");
    if (withoutReasoning.length === message.content.length) return message;
    return { ...message, content: withoutReasoning };
  });
}

export function formatCompactSummaryOrThrow(
  runtime: AgentRuntimeInternal,
  result: RuntimeModelTextResult,
): string {
  // 截断保护（吸收 pi compaction.ts:618-638 的摘要失败判据）：finishReason=length
  // 意味着摘要本身被 max_tokens 截断——落盘半份摘要比不压缩更危险（静默丢失尾部上下文）。
  // retryable 让 auto compact 的既有重试链（最多 3 次）先尝试自然恢复。
  if (result.finishReason === "length") {
    throw createCoreError(CoreErrorType.ModelError, COMPACT_SUMMARY_TRUNCATED_MESSAGE, {
      recoverable: true,
      retryable: true,
    });
  }
  const compactToolCalls = runtime.extractToolCallsFromResult(result);
  if (compactToolCalls.length > 0) {
    throw createCoreError(CoreErrorType.ModelError, COMPACT_TOOL_USE_DENIAL_MESSAGE, {
      context: {
        behavior: "deny",
        decisionReason: {
          reason: COMPACT_TOOL_USE_DENIAL_REASON,
          type: "other",
        },
        toolNames: compactToolCalls.map((toolCall) => toolCall.name),
      },
      recoverable: true,
      retryable: false,
    });
  }

  const summary = formatCompactSummary(result.text);
  if (!summary) {
    throw createCoreError(CoreErrorType.ModelError, "Failed to generate compact summary", {
      recoverable: true,
      retryable: true,
    });
  }
  return summary;
}
