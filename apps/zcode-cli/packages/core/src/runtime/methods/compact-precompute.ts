/**
 * Compaction precompute——后台预热式自动压缩(spec 166,吸收 OpenCode
 * session/compaction.ts 的 precompute 语义)。
 *
 * 上下文越过预热线(默认 85% 有效窗口,AUTOCOMPACT_PRECOMPUTE_PERCENT)时后台
 * 预生成压缩摘要;到 compact 阈值时校验快照一致性,一致则直接换入成品摘要
 * (跳过同步摘要生成,消除压缩卡顿),不一致则丢弃回退现有同步路径。
 * 预热是纯优化:任何失败静默丢弃,正确性由同步路径兜底。
 *
 * 单槽位:runtime 同时最多一个在途/就绪预热,新预热覆盖旧预热。
 * 跨 turn 存活(不挂 turn abortSignal);runtime 无显式清理,进程级生命周期跟随。
 */

import { sessionLogHash } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { Model, SessionEvent, TraceContext } from "../deps.js";
import type { RuntimeModelTextResult } from "../types.js";

export interface PrecomputedCompact {
  /** 已通过 formatCompactSummaryOrThrow 校验的模型摘要结果(换入时直接传给 applyCompactSummaryResult)。 */
  result: RuntimeModelTextResult;
  /** 预热时的被摘要窗(用于快照指纹)。 */
  entriesForSummary: readonly RuntimeMessageEntry[];
  /** 被摘要窗的链式内容指纹 + 条数(换入校验:当前窗前 count 条 hash 相同才可换入)。 */
  snapshotChainHash: number;
  snapshotEntryCount: number;
  createdAt: number;
}

export interface CompactPrecomputeSlot {
  precomputed?: PrecomputedCompact;
  inFlight?: Promise<void>;
}

const slots = new WeakMap<AgentRuntimeInternal, CompactPrecomputeSlot>();

/** 测试与观测用。 */
export function peekCompactPrecomputeSlot(runtime: AgentRuntimeInternal): CompactPrecomputeSlot | undefined {
  return slots.get(runtime);
}

function slotFor(runtime: AgentRuntimeInternal): CompactPrecomputeSlot {
  let slot = slots.get(runtime);
  if (!slot) {
    slot = {};
    slots.set(runtime, slot);
  }
  return slot;
}

/** RuntimeMessageEntry 的链式内容指纹(seed 与逐条混入,前缀一致性判定专用)。 */
export function compactEntriesChainHash(entries: readonly RuntimeMessageEntry[]): number {
  let chain = 5381;
  for (const entry of entries) {
    if (entry.kind === "attachment") {
      chain = sessionLogHash(`${chain}:attachment:${entry.content.slice(0, 256)}`);
      continue;
    }
    const message = entry.message;
    const contentText =
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => block.type).join(",");
    chain = sessionLogHash(`${chain}:${message.role}:${contentText.slice(0, 256)}`);
  }
  return chain | 0;
}

export interface StartPrecomputeInput {
  /** 与 autoCompact 相同来源的当前候选 entries(turnRequestState.entries)。 */
  activeEntries: readonly RuntimeMessageEntry[];
  /** 摘要模型(与 autoCompact 的 compactModel 同源)。 */
  model: Model;
  /** 是否中置 system(与 autoCompact 投影同源)。 */
  useMidConversationSystem: boolean;
  /** preserveRecent 预算(已按模型解析)。 */
  preserveRecentTokenBudget: number;
  /** selectCompactEntries 所需 trigger(auto)。 */
  trigger: "auto";
}

/**
 * 启动后台预热:已有槽位或预热在途时直接返回(单槽位语义);后台失败静默丢弃。
 * 由 autoCompactIfNeeded 在 shouldPrecomputeCompact 命中时 fire-and-forget 调用。
 */
export function startCompactPrecompute(
  runtime: AgentRuntimeInternal,
  input: StartPrecomputeInput,
): void {
  const slot = slotFor(runtime);
  if (slot.precomputed || slot.inFlight) return;

  const inFlight = (async () => {
    try {
      const prepared = await runtime.preparePrecomputeCompactSummary(input);
      if (!prepared) return;
      slot.precomputed = {
        result: prepared.result,
        entriesForSummary: prepared.entriesForSummary,
        snapshotChainHash: compactEntriesChainHash(prepared.entriesForSummary),
        snapshotEntryCount: prepared.entriesForSummary.length,
        createdAt: Date.now(),
      };
      runtime.logger?.debug("Compact precompute ready", {
        event: "compact.precompute.ready",
        module: "core.runtime",
        entryCount: prepared.entriesForSummary.length,
      });
    } catch (error) {
      // 预热是纯优化:失败静默丢弃(debug 可见),同步路径兜底正确性。
      runtime.logger?.debug("Compact precompute failed; sync path remains the fallback", {
        event: "compact.precompute.failed",
        module: "core.runtime",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      slot.inFlight = undefined;
    }
  })();
  slot.inFlight = inFlight;
}

/** 换入校验:被摘要窗前缀一致性(快照 hash+count 与当前窗前缀重算比对)。 */
export function takeValidPrecomputedCompact(
  runtime: AgentRuntimeInternal,
  currentEntriesForSummary: readonly RuntimeMessageEntry[],
): PrecomputedCompact | undefined {
  const slot = slots.get(runtime);
  const precomputed = slot?.precomputed;
  if (!slot || !precomputed) return undefined;
  const valid =
    currentEntriesForSummary.length >= precomputed.snapshotEntryCount &&
    compactEntriesChainHash(currentEntriesForSummary.slice(0, precomputed.snapshotEntryCount)) ===
      precomputed.snapshotChainHash;
  // 无论命中与否都消费掉:stale 槽位留着只会浪费下次判定。
  slot.precomputed = undefined;
  if (!valid) {
    runtime.logger?.debug("Compact precompute stale; falling back to sync compaction", {
      event: "compact.precompute.miss",
      module: "core.runtime",
      reason: "snapshot_mismatch",
    });
    return undefined;
  }
  runtime.logger?.info("Compact precompute hit; swapping in prepared summary", {
    event: "compact.precompute.hit",
    module: "core.runtime",
    entryCount: precomputed.snapshotEntryCount,
  });
  return precomputed;
}

// ============================================================
// 预热摘要生成(runtime method;复用与 autoCompact 完全同源的投影/选择/请求管线)
// ============================================================

import { buildCompactPrompt } from "../../compact/prompt.js";
import { mergeCompactInstructions } from "../../compact/policy.js";
import {
  hasEnoughRuntimeEntriesToCompact,
  projectMessagesForModelMediaPolicy,
} from "../helpers/index.js";
import {
  resolveCompactPreserveRecentTokenBudget,
  selectCompactEntries,
} from "../helpers/compact-selection.js";
import {
  buildCompactSummaryRequestMessages,
  formatCompactSummaryOrThrow,
} from "./compact-active-helpers.js";
import {
  capCompactSummaryMaxOutputTokens,
  extractPreviousCompactSummaryText,
} from "./compact-active.js";
import { runCompactSummaryModelRequest } from "./compact-summary-model-request.js";
import { traceContextToLogContext } from "@zcode/contracts";

/**
 * 预热摘要生成:与 autoCompact 摘要请求同源构造(选择/提示词/媒体投影/截断保护),
 * 但轻量化的运行时周边——不落 ModelRequest/ModelComplete 轨迹事件(预热对用户
 * 不可见)、不带 compactTools(摘要无工具用途)、不挂 turn abortSignal(跨 turn 存活)。
 * 校验(length 截断/工具拒绝)与同步路径一致,失败抛给上层静默丢弃。
 */
export async function preparePrecomputeCompactSummary(
  this: AgentRuntimeInternal,
  input: StartPrecomputeInput,
): Promise<{ result: RuntimeModelTextResult; entriesForSummary: readonly RuntimeMessageEntry[] } | undefined> {
  const compactModel = input.model;
  const preserveRecentTokenBudget = resolveCompactPreserveRecentTokenBudget({
    config: this.config.compact,
    modelId: compactModel.modelId,
  });
  const selection = selectCompactEntries({
    entries: input.activeEntries,
    trigger: "auto",
    preserveRecentTokenBudget,
  });
  const entriesForSummary = selection.entriesForSummary;
  if (!hasEnoughRuntimeEntriesToCompact(entriesForSummary)) return undefined;

  const useMidConversationSystem =
    this.config.midConversationSystem?.mode === "force" ||
    compactModel.properties.supportsMidConversationSystem;
  const previousSummaryText = extractPreviousCompactSummaryText(
    getRuntimeEntriesToSummarize(entriesForSummary),
  );
  const compactPrompt = buildCompactPrompt(
    mergeCompactInstructions(this.config.compact?.domainInstructions, undefined),
    { previousSummary: previousSummaryText },
  );
  const requestMessages = buildCompactSummaryRequestMessages(entriesForSummary, compactPrompt, {
    useMidConversationSystem,
  });
  const mediaProjection = projectMessagesForModelMediaPolicy(
    requestMessages,
    compactModel.properties.inputFormat,
  );

  // 预热不落轨迹事件:statusSink 的状态事件写入本地数组后丢弃。
  const discardedEvents: never[] = [];
  const result = await runCompactSummaryModelRequest({
    logger: this.logger,
    model: compactModel,
    request: {
      maxOutputTokens: capCompactSummaryMaxOutputTokens(compactModel),
      messages: mediaProjection.messages,
      metadata: traceContextToLogContext(this.rootTraceContext),
      modelCall: {
        operation: "context_compaction" as const,
        operationId: `cmp_pre_${crypto.randomUUID()}`,
      },
      statusSink: this.createModelStatusSink(this.rootTraceContext, discardedEvents),
      traceContext: this.rootTraceContext,
      tools: [],
    },
  });
  // 校验与同步路径一致:截断摘要/工具调用拒绝在此抛出 → 上层 catch 静默丢弃。
  formatCompactSummaryOrThrow(this, result);
  return { result, entriesForSummary };
}

// ============================================================
// 换入消费(spec 166 第 4 步):快照一致 → applyCompactSummaryResult 秒换入
// ============================================================

import { createMessageId, createPartId } from "@zcode/contracts";
import { CompactPhase, CompactReason, CompactTrigger } from "@zcode/contracts";
import { createChildTraceContext } from "../deps.js";
import { getRuntimeEntriesToSummarize } from "../helpers/compact.js";
import { applyCompactSummaryResult } from "./compact-active.js";

export interface ConsumePrecomputedInput {
  decision: {
    threshold: number;
    tokenCount: number;
    contextWindow: number;
    tokenSource: "estimate" | "provider_usage";
  };
  activeEntries: readonly RuntimeMessageEntry[];
  model: Model;
  turnTraceContext: TraceContext;
  events: SessionEvent[];
  abortSignal: AbortSignal | undefined;
  agentListingTools: unknown;
}

/**
 * 到点换入:重新按当前 entries 选择(与 autoCompact 同源),取预热槽位做快照
 * 一致性校验(被摘要窗前缀指纹匹配),一致则直接走 applyCompactSummaryResult
 * 换入预热摘要;无槽位或不一致返回 undefined(调用方回退同步路径)。
 * 换入构造新的 compactTimeline(独立 operationId,replace 语义与正常压缩一致)。
 */
export async function consumePrecomputedCompact(
  this: AgentRuntimeInternal,
  input: ConsumePrecomputedInput,
): Promise<{ entries: readonly RuntimeMessageEntry[] } | undefined> {
  const compactModel = input.model;
  if (!compactModel) return undefined;
  const preserveRecentTokenBudget = resolveCompactPreserveRecentTokenBudget({
    config: this.config.compact,
    modelId: compactModel.modelId,
  });
  const selection = selectCompactEntries({
    entries: input.activeEntries,
    trigger: "auto",
    preserveRecentTokenBudget,
  });
  const entriesForSummary = selection.entriesForSummary;
  const precomputed = takeValidPrecomputedCompact(this, entriesForSummary);
  if (!precomputed) return undefined;

  const useMidConversationSystem =
    this.config.midConversationSystem?.mode === "force" ||
    compactModel.properties.supportsMidConversationSystem;
  const compactTimeline = {
    operationId: `cmp_${crypto.randomUUID()}`,
    messageId: createMessageId(),
    partId: createPartId(),
    trigger: CompactTrigger.Auto,
    phase: CompactPhase.MidTurn,
    compactReason: CompactReason.ContextLimit,
    startedAt: precomputed.createdAt,
    preCompactTokenCount: input.decision.tokenCount,
  };
  const modelTraceContext = createChildTraceContext(input.turnTraceContext, {
    attributes: {
      model: `${compactModel.providerId}/${compactModel.modelId}`,
      querySource: "compact",
    },
  });
  const result = await applyCompactSummaryResult.call(this, {
    result: precomputed.result,
    entriesForSummary,
    entriesToSummarize: getRuntimeEntriesToSummarize(entriesForSummary),
    currentSelection: selection,
    preservedEntries: selection.preservedEntries,
    activeEntries: input.activeEntries,
    useMidConversationSystem,
    compactModel,
    customInstructions: undefined,
    compactTimeline,
    attempt: 1,
    maxAttempts: 1,
    trigger: CompactTrigger.Auto,
    phase: CompactPhase.MidTurn,
    compactReason: CompactReason.ContextLimit,
    preCompactTokenCount: input.decision.tokenCount,
    lastSummarizedMessageId: this.latestConversationMessageId,
    turnTraceContext: input.turnTraceContext,
    events: input.events,
    modelTraceContext,
    options: {
      abortSignal: input.abortSignal,
      autoCompactThreshold: input.decision.threshold,
      activeEntries: input.activeEntries,
    },
  });
  return { entries: result.entries };
}
