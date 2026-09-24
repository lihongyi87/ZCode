import {
  MicrocompactStrategy,
  MicrocompactTrigger,
  modelMessageContentToText,
  type MicrocompactBoundaryPayload,
  type ModelMessageContent,
  type ToolCallId,
} from "@zcode/contracts";
import type { CompactModelMessage } from "./manual.js";
import { estimateMessageTokens } from "./manual.js";

export const MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX = "[Old tool result content cleared]";
export const MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE = "[Old tool result content cleared]";
/** v2 锚点存根前缀：带工具名+定位线索+输出首行，被清内容可精确重取（见 buildClearedToolResultContent）。 */
export const MICROCOMPACT_CLEARED_TOOL_RESULT_ANCHORED_PREFIX = "[Old tool result cleared ·";
/** 摘录型存根的默认工具集：重跑也不保证同样结果的输出（命令执行），清除时保留
 * 首尾摘录——排盘/计算类数据丢了就真丢了，与「可重取」的 Read 类分级对待。 */
export const DEFAULT_PRESERVED_EXCERPT_TOOL_NAMES = ["Bash"] as const;
/** 锚点存根长度上界（生成侧拼接各段后不超过此值；判定侧用它防回声 spoof）。 */
export const MICROCOMPACT_CLEARED_STUB_MAX_CHARS = 1_200;
export const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 5;
const DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES = 60;
export const DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS = 256;
export const DEFAULT_MICROCOMPACT_THRESHOLD_RATIO = 0.9;
export const DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS = 2_000;
export const DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS = [
  "Read",
  "Bash",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "Edit",
  "Write",
  "ApplyPatch",
] as const;

export interface LocalMicrocompactPolicyConfig {
  enabled?: boolean;
  thresholdTokens?: number;
  idleThresholdMinutes?: number;
  keepRecentToolResults?: number;
  compactableToolNames?: readonly string[];
  /** 摘录型存根工具集（默认 Bash）：清除时保留首尾摘录。 */
  preservedExcerptToolNames?: readonly string[];
  clearErrorResults?: boolean;
  minTokenSavings?: number;
}

export interface LocalMicrocompactMessage extends CompactModelMessage {
  isError?: boolean;
  toolCalls?: Array<{ id: string; input: unknown; name: string }>;
  toolCallId?: string;
  toolName?: string;
}

export type LocalMicrocompactBoundaryPayload = Omit<
  MicrocompactBoundaryPayload,
  "traceId" | "turnId"
>;

export interface LocalMicrocompactDecision {
  estimatedTokenCount: number;
  reason:
    | "disabled"
    | "not_triggered"
    | "no_candidates"
    | "nothing_to_clear"
    | "below_min_savings"
    | "applied";
  thresholdTokens?: number;
  trigger?: MicrocompactTrigger;
}

export interface LocalMicrocompactResult<T extends LocalMicrocompactMessage> {
  decision: LocalMicrocompactDecision;
  messages: T[];
  payload?: LocalMicrocompactBoundaryPayload;
}

interface ToolResultCandidate {
  index: number;
  toolCallId: string;
}

export function buildDefaultMicrocompactThreshold(autoCompactThreshold: number): number {
  const ratioThreshold = Math.floor(autoCompactThreshold * DEFAULT_MICROCOMPACT_THRESHOLD_RATIO);
  const bufferThreshold = autoCompactThreshold - DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS;
  return Math.max(0, Math.min(ratioThreshold, bufferThreshold));
}

export function maybeLocalMicrocompactMessages<T extends LocalMicrocompactMessage>(input: {
  config?: LocalMicrocompactPolicyConfig;
  lastAssistantCompletedAtMs?: number;
  messages: readonly T[];
  nowMs?: number;
}): LocalMicrocompactResult<T> {
  const config = input.config ?? {};
  const messages = input.messages.map(cloneLocalMicrocompactMessage);
  const estimatedTokenCount = estimateMessageTokens(messages);
  const thresholdTokens = positiveInt(config.thresholdTokens);

  if (config.enabled === false) {
    return {
      decision: { estimatedTokenCount, reason: "disabled", thresholdTokens },
      messages,
    };
  }

  const trigger = resolveMicrocompactTrigger({
    config,
    estimatedTokenCount,
    lastAssistantCompletedAtMs: input.lastAssistantCompletedAtMs,
    nowMs: input.nowMs,
    thresholdTokens,
  });
  if (!trigger) {
    return {
      decision: { estimatedTokenCount, reason: "not_triggered", thresholdTokens },
      messages,
    };
  }

  const candidateGroups = collectCompactableToolResultGroups(messages, config);
  const preservedExcerptTools = new Set(
    config.preservedExcerptToolNames ?? DEFAULT_PRESERVED_EXCERPT_TOOL_NAMES,
  );
  if (candidateGroups.length === 0) {
    return {
      decision: { estimatedTokenCount, reason: "no_candidates", thresholdTokens, trigger },
      messages,
    };
  }

  const keepCount =
    positiveInt(config.keepRecentToolResults) ?? DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS;
  const boundedKeepCount = Math.max(1, keepCount);
  const clearGroupCount = Math.max(0, candidateGroups.length - boundedKeepCount);
  if (clearGroupCount === 0) {
    return {
      decision: { estimatedTokenCount, reason: "nothing_to_clear", thresholdTokens, trigger },
      messages,
    };
  }

  const toClear = candidateGroups.slice(0, clearGroupCount).flat();
  const toKeep = candidateGroups.slice(clearGroupCount).flat();
  for (const candidate of toClear) {
    const message = messages[candidate.index];
    if (!message) continue;
    messages[candidate.index] = {
      ...message,
      content: buildClearedToolResultContent(
        messages,
        candidate.index,
        candidate.toolCallId,
        preservedExcerptTools,
      ),
    };
  }

  const postTokenCount = estimateMessageTokens(messages);
  const tokensSaved = Math.max(0, estimatedTokenCount - postTokenCount);
  const minSavings = positiveInt(config.minTokenSavings) ?? DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS;
  if (tokensSaved < minSavings) {
    return {
      decision: { estimatedTokenCount, reason: "below_min_savings", thresholdTokens, trigger },
      messages: input.messages.map(cloneLocalMicrocompactMessage),
    };
  }

  return {
    decision: { estimatedTokenCount, reason: "applied", thresholdTokens, trigger },
    messages,
    payload: {
      clearedMessageCount: toClear.length,
      clearedToolCallIds: toClear.map((candidate) => candidate.toolCallId as ToolCallId),
      keptToolCallIds: toKeep.map((candidate) => candidate.toolCallId as ToolCallId),
      postMicrocompactTokenCount: postTokenCount,
      preMicrocompactTokenCount: estimatedTokenCount,
      strategy: MicrocompactStrategy.LocalToolResultClear,
      tokensSaved,
      trigger,
    },
  };
}

function resolveMicrocompactTrigger(input: {
  config: LocalMicrocompactPolicyConfig;
  estimatedTokenCount: number;
  lastAssistantCompletedAtMs?: number;
  nowMs?: number;
  thresholdTokens?: number;
}): MicrocompactTrigger | undefined {
  const idleThresholdMinutes =
    positiveInt(input.config.idleThresholdMinutes) ?? DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES;
  if (
    input.lastAssistantCompletedAtMs !== undefined &&
    Number.isFinite(input.lastAssistantCompletedAtMs)
  ) {
    const elapsedMs = (input.nowMs ?? Date.now()) - input.lastAssistantCompletedAtMs;
    if (elapsedMs > idleThresholdMinutes * 60_000) {
      return MicrocompactTrigger.TimeBased;
    }
  }

  if (input.thresholdTokens !== undefined && input.estimatedTokenCount >= input.thresholdTokens) {
    return MicrocompactTrigger.TokenPressure;
  }

  return undefined;
}

function collectCompactableToolResultGroups<T extends LocalMicrocompactMessage>(
  messages: readonly T[],
  config: LocalMicrocompactPolicyConfig,
): ToolResultCandidate[][] {
  const compactableTools = new Set(
    config.compactableToolNames ?? DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS,
  );
  const clearErrorResults = config.clearErrorResults === true;
  const groups: ToolResultCandidate[][] = [];
  let currentGroup: ToolResultCandidate[] | undefined;

  const flushCurrentGroup = (): void => {
    if (currentGroup && currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    currentGroup = undefined;
  };

  messages.forEach((message, index) => {
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      flushCurrentGroup();
      currentGroup = [];
      return;
    }

    if (message.role !== "tool") return;
    if (!message.toolCallId || !message.toolName) return;
    if (!compactableTools.has(message.toolName)) return;
    if (message.isError && !clearErrorResults) return;
    if (isMicrocompactClearedToolResultContent(message.content)) return;
    if (hasMediaToolResultContent(message.content)) return;

    if (!currentGroup) {
      groups.push([{ index, toolCallId: message.toolCallId }]);
      return;
    }

    currentGroup.push({ index, toolCallId: message.toolCallId });
  });

  flushCurrentGroup();
  return groups;
}

/**
 * 锚点存根（v2）：不再留无信息的空壳，而是确定性生成「工具名 + 定位线索 +
 * 输出首行」的路条——模型据此知道被清的是什么、需要时用同名工具精确重取。
 * 纯函数零成本：所有线索都来自历史里已有的字段，不调模型。
 *
 * 线索来源：工具入参里的 file_path / path / url / command / query / pattern
 * （第一个命中的字符串字段），以及被清输出自身的前 120 字符。
 */
function buildClearedToolResultContent(
  messages: readonly LocalMicrocompactMessage[],
  clearedIndex: number,
  toolCallId: string,
  preservedExcerptTools: ReadonlySet<string>,
): ModelMessageContent {
  const toolName = messages[clearedIndex]?.toolName ?? "";
  const toolInput = findToolCallInput(messages, clearedIndex, toolCallId);
  const hint = pickInputHint(toolInput);

  // 分级：摘录类工具（Bash 等，重跑不保证同样结果）保留首尾摘录——排盘/计算
  // 类数据丢了就真丢了；可重取类（Read 等）沿用极简锚点，反正能精确重取。
  if (preservedExcerptTools.has(toolName)) {
    const excerpt = headTailExcerpt(modelMessageContentToText(messages[clearedIndex]?.content));
    const segments = ["[Old tool result cleared"];
    if (toolName) segments.push(` · ${toolName}`);
    if (hint) segments.push(` ${hint}`);
    if (excerpt) segments.push(` · excerpt: ${excerpt}`);
    segments.push(" · key data preserved above; re-run the same command for the full output]");
    return segments.join("");
  }

  const firstLine = firstContentLine(messages[clearedIndex]?.content);
  const segments = ["[Old tool result cleared"];
  if (toolName) segments.push(` · ${toolName}`);
  if (hint) segments.push(` ${hint}`);
  if (firstLine) segments.push(` · output began: "${firstLine}"`);
  segments.push(" · re-invoke the same tool to retrieve]");
  return segments.join("");
}

/** 首尾摘录：头 400 + 省略标记 + 尾 400 字符（保留输出两端的_key 数据）。 */
function headTailExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (flat.length <= 820) return flat;
  return `${flat.slice(0, 400)} […middle omitted…] ${flat.slice(-400)}`;
}

function findToolCallInput(
  messages: readonly LocalMicrocompactMessage[],
  clearedIndex: number,
  toolCallId: string,
): unknown {
  const scanFrom = Math.max(0, clearedIndex - 10);
  for (let index = clearedIndex; index >= scanFrom; index -= 1) {
    const message = messages[index];
    const calls = message?.toolCalls;
    if (!calls) continue;
    const hit = calls.find((call) => call.id === toolCallId);
    if (hit) return hit.input;
  }
  return undefined;
}

function pickInputHint(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  for (const key of ["file_path", "url", "command", "query", "pattern", "path", "file"]) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) {
      return collapseWhitespace(value).slice(0, 96);
    }
  }
  return "";
}

function firstContentLine(content: ModelMessageContent | undefined): string {
  if (!content) return "";
  const text = modelMessageContentToText(content).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 120) : "";
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isMicrocompactClearedToolResultContent(content: ModelMessageContent): boolean {
  const text = modelMessageContentToText(content);
  if (text === MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE) return true;
  // 锚点格式须同时满足前缀 + 长度上界：裸前缀匹配可被「输出恰好以锚点开头」
  // 的内容 spoof（比如模型读到一个内嵌该字面串的文件），后果是这条输出永不清除、
  // 上下文无界增长。真存根由本模块生成，长度有界（~280 字符）。
  return (
    text.startsWith(MICROCOMPACT_CLEARED_TOOL_RESULT_ANCHORED_PREFIX) &&
    text.length <= MICROCOMPACT_CLEARED_STUB_MAX_CHARS
  );
}

function hasMediaToolResultContent(content: ModelMessageContent): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object" || !("type" in block)) return false;
    // video 与 image/file 同为受保护媒体：Read 视频结果漏判会被 microcompact 清掉。
    return block.type === "image" || block.type === "video" || block.type === "file";
  });
}

function cloneLocalMicrocompactMessage<T extends LocalMicrocompactMessage>(message: T): T {
  return {
    ...message,
    content: cloneContent(message.content),
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
  };
}

function cloneContent(content: ModelMessageContent): ModelMessageContent {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if ("source" in block && block.source) {
      return { ...block, source: { ...block.source } };
    }
    if ("providerOptions" in block && block.providerOptions) {
      return { ...block, providerOptions: { ...block.providerOptions } };
    }
    return { ...block };
  }) as ModelMessageContent;
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
