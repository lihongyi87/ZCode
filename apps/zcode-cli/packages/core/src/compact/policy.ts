import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY as DEFAULT_BUDGET_STRATEGY } from "@zcode/shared";
import { modelMessageContentToText } from "@zcode/contracts";
import type { CompactModelMessage } from "./manual.js";
import { estimateMessageTokens, hasEnoughMessagesToCompact } from "./manual.js";
import type { LocalMicrocompactPolicyConfig } from "./microcompact.js";

export const DEFAULT_COMPACT_CONTEXT_WINDOW = 200_000;
// 正常请求默认输出已收敛到 32K，auto compact 必须预留同一目标；
// 否则请求预算和压缩窗口会继续按两套常量计算。
export const DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 32_000;
const PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT = 100;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
/**
 * body-after-prefix 口径的全量硬顶比例。对齐 codex 间距语义：cap = limit +
 * ~5% 全窗口（codex 90%/95% 于全窗口；本仓 threshold≈77.5% 全窗口，故
 * 0.98×effective≈limit+8K）。红队审查：0.95×effective 仅比 threshold 高
 * 4.6K（2.3% 窗口），大前缀的 body 余量会被硬顶钳到比设计意图薄一半以上。
 * 真溢出另有 preflight 输入预算（effective）与 reactive compact 两层安全网。
 */
export const AUTOCOMPACT_HARD_CAP_PERCENT = 0.98;

export interface AutoCompactPolicyConfig {
  enabled?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  modelContextBudgetStrategy?: "legacy" | "preflight-v1";
  summaryReserveTokens?: number;
  bufferTokens?: number;
  thresholdPercentOverride?: number;
  /**
   * ⑤ 触发计数口径（吸收 codex AutoCompactTokenLimitScope，默认 body-after-prefix）：
   * - total：上下文全量计数达到阈值即压缩（旧行为）；
   * - body-after-prefix：只数初始前缀（system+AGENTS.md+skills listing）之后的
   *   增量——大前缀不占压缩预算，防止「前缀就吃掉四分之一预算」导致压缩过频；
   *   95% 硬顶（全量口径）兜底防真溢出，溢出另有 reactive compact 安全网。
   */
  autoCompactScope?: "total" | "body-after-prefix";
  maxConsecutiveFailures?: number;
  microcompact?: LocalMicrocompactPolicyConfig;
  /**
   * P4 压缩域包：项目级压缩附加指令（compact.domainInstructions），随每次
   * compact 摘要注入——域工作流（如命理：知识锚点清单/已裁决口径/分析对象
   * 生辰四要素/已确认体用）跨压缩有结构化 slot 可依。运行时 customInstructions
   * （/compact 命令参数）与其叠加而非互斥。
   */
  domainInstructions?: string;
}

/** P4：项目级域包与运行时 /compact 参数合并（均非空时以空行分隔，域包在前）。 */
export function mergeCompactInstructions(
  domainInstructions: string | undefined,
  runtimeInstructions: string | undefined,
): string | undefined {
  const parts = [domainInstructions?.trim() ?? "", runtimeInstructions?.trim() ?? ""].filter(
    (part) => part.length > 0,
  );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export type AutoCompactTokenSource = "estimate" | "provider_usage";

export interface AutoCompactTokenOverride {
  baseTokenCount?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextUsageTokenCount?: number;
  incrementalTokenCount?: number;
  outputTokens?: number;
  source: Extract<AutoCompactTokenSource, "provider_usage">;
  tokenCount: number;
}

export interface AutoCompactDecision {
  shouldCompact: boolean;
  tokenCount: number;
  tokenSource: AutoCompactTokenSource;
  estimatedTokenCount: number;
  providerCacheReadTokens?: number;
  providerCacheWriteTokens?: number;
  providerBaseTokenCount?: number;
  providerContextUsageTokenCount?: number;
  providerIncrementalTokenCount?: number;
  providerOutputTokens?: number;
  threshold: number;
  contextWindow: number;
  effectiveContextWindow: number;
  maxOutputTokens?: number;
  modelContextBudgetStrategy: "legacy" | "preflight-v1";
  outputReserveTokens: number;
  thresholdPercent: number;
  /** ⑤ BodyAfterPrefix 口径：初始前缀 token 数（system+系统提醒前缀）。 */
  prefixTokens: number;
  /** ⑤ 前缀之后的增量 token（触发计数面）。 */
  bodyTokens: number;
  /** ⑤ 全量硬顶（95% 有效窗口）；达到即压缩，与口径无关。 */
  hardCapTokens: number;
  /** ⑤ 生效的计数口径。 */
  scope: "total" | "body-after-prefix";
  reason:
    | "disabled"
    | "not_enough_messages"
    | "circuit_breaker"
    | "below_threshold"
    | "above_threshold"
    | "hard_cap";
}

export function getEffectiveContextWindowSize(config: AutoCompactPolicyConfig = {}): number {
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  // provider 的 context window 是 input + output 共享窗口；自动压缩只能让出输入侧，
  // 因此阈值分母必须先扣掉当前模型允许的 output token，而不是继续吃完整 contextWindow。
  const reserve = Math.min(getAutoCompactOutputReserveTokens(config), contextWindow);
  return Math.max(0, contextWindow - reserve);
}

export function getAutoCompactOutputReserveTokens(config: AutoCompactPolicyConfig = {}): number {
  const maxOutputTokens = positiveInt(config.maxOutputTokens);
  // 旧 legacy 分支为完整模型输出预留窗口，既过早压缩又要求远端选择；现在统一保留至多 21K。
  return Math.min(
    maxOutputTokens ?? DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
    PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
  );
}

export function getAutoCompactThreshold(config: AutoCompactPolicyConfig = {}): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(config);
  const buffer = positiveInt(config.bufferTokens) ?? AUTOCOMPACT_BUFFER_TOKENS;
  return Math.max(0, effectiveContextWindow - buffer);
}

export function shouldAutoCompact(input: {
  messages: readonly CompactModelMessage[];
  config?: AutoCompactPolicyConfig;
  consecutiveFailures?: number;
  tokenOverride?: AutoCompactTokenOverride;
}): AutoCompactDecision {
  const config = input.config ?? {};
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  const effectiveContextWindow = getEffectiveContextWindowSize(config);
  const outputReserveTokens = Math.min(getAutoCompactOutputReserveTokens(config), contextWindow);
  const threshold = getAutoCompactThreshold(config);
  const thresholdPercent = DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT;
  const estimatedTokenCount = estimateMessageTokens(input.messages);
  const tokenCount = input.tokenOverride?.tokenCount ?? estimatedTokenCount;
  const tokenSource = input.tokenOverride?.source ?? "estimate";
  // ⑤ BodyAfterPrefix 口径：前缀 token（provider override 时按比例折算不可得，
  // 退回估算面）不占阈值预算；95% 全量硬顶兜底。
  const scope = config.autoCompactScope ?? "body-after-prefix";
  const prefixTokensEstimated = estimateMessageTokens(
    input.messages.filter(
      (m) =>
        m.role === "system" ||
        (m.role === "user" &&
          modelMessageContentToText(m.content).trimStart().startsWith("<system-reminder>")),
    ),
  );
  // provider usage 与本地 4B/token 估算是两个口径，直接相减会混算（对抗审查）：
  // provider 计数生效时，前缀按估算占比折算到 provider 口径再扣。
  const providerScaled =
    input.tokenOverride !== undefined &&
    tokenCount !== estimatedTokenCount &&
    estimatedTokenCount > 0;
  const prefixTokens = providerScaled
    ? Math.round((prefixTokensEstimated / estimatedTokenCount) * tokenCount)
    : prefixTokensEstimated;
  const bodyTokens = Math.max(0, tokenCount - prefixTokens);
  const hardCapTokens = Math.floor(effectiveContextWindow * AUTOCOMPACT_HARD_CAP_PERCENT);
  const common = {
    contextWindow,
    effectiveContextWindow,
    estimatedTokenCount,
    providerCacheReadTokens: input.tokenOverride?.cacheReadTokens,
    providerCacheWriteTokens: input.tokenOverride?.cacheWriteTokens,
    maxOutputTokens: positiveInt(config.maxOutputTokens),
    modelContextBudgetStrategy: DEFAULT_BUDGET_STRATEGY,
    outputReserveTokens,
    providerBaseTokenCount: input.tokenOverride?.baseTokenCount,
    providerContextUsageTokenCount: input.tokenOverride?.contextUsageTokenCount,
    providerIncrementalTokenCount: input.tokenOverride?.incrementalTokenCount,
    providerOutputTokens: input.tokenOverride?.outputTokens,
    threshold,
    thresholdPercent,
    tokenCount,
    tokenSource,
    bodyTokens,
    prefixTokens,
    hardCapTokens,
    scope,
  } satisfies Omit<AutoCompactDecision, "reason" | "shouldCompact">;

  if (config.enabled === false) {
    return { ...common, shouldCompact: false, reason: "disabled" };
  }

  if (!hasEnoughMessagesToCompact(input.messages)) {
    return {
      ...common,
      shouldCompact: false,
      reason: "not_enough_messages",
    };
  }

  const maxFailures =
    positiveInt(config.maxConsecutiveFailures) ?? MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;
  if ((input.consecutiveFailures ?? 0) >= maxFailures) {
    return {
      ...common,
      shouldCompact: false,
      reason: "circuit_breaker",
    };
  }

  const countedTokens = scope === "body-after-prefix" ? bodyTokens : tokenCount;
  if (countedTokens < threshold && tokenCount < hardCapTokens) {
    return {
      ...common,
      shouldCompact: false,
      reason: "below_threshold",
    };
  }

  return {
    ...common,
    shouldCompact: true,
    reason: tokenCount >= hardCapTokens ? "hard_cap" : "above_threshold",
  };
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
