import type { AgentRuntimeInternal } from "../internal.js";
import { getModelUsageContextTokens, type ModelInputMessage } from "../deps.js";
import { buildProviderRequestMessages } from "../helpers/provider-request-messages.js";

/**
 * 缓存保活器（④）：会话空闲超过阈值时发一次同前缀迷你请求，刷新 provider
 * 侧 prompt cache——生产数据（3964 条 >200K 请求）显示 30 分钟以上空档后的
 * 下一请求 TTFT 平均跳升 11.5 秒（缓存过期重算），保活可消除该跳升。
 *
 * 成本模型：保活请求的输入全部走 cache-read 价（约 0.1×），输出 16 token 上限；
 * 相比下次真实请求的全量重预填充（1× 输入 + 漫长等待），量级可忽略。
 *
 * 安全边界：
 * - 默认关闭（config.cacheKeepAlive.enabled），按会话显式开启；
 * - turn 运行中绝不触发（先查活动 turn）；
 * - 触发失败静默降级——保活是优化，不是功能依赖；
 * - 刷新用的消息是投影副本 + 一条最小 ping user 消息，不写历史、不落会话。
 */

const DEFAULT_IDLE_THRESHOLD_MS = 25 * 60_000;
const KEEP_ALIVE_MAX_OUTPUT_TOKENS = 16;

export const CACHE_KEEP_ALIVE_TAG = "[cache-keep-alive]";

export function resolveKeepAliveIdleThresholdMs(config?: {
  idleThresholdMs?: number;
}): number | undefined {
  const value = config?.idleThresholdMs;
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_IDLE_THRESHOLD_MS;
  }
  return value;
}

export function buildKeepAlivePingMessage(): ModelInputMessage {
  return {
    role: "user",
    content: [{ type: "text", text: "(keep-alive ping — reply with the single character: 1)" }],
  };
}

/** 调度/清理保活定时器；由 runtime 持有句柄。 */
export function scheduleCacheKeepAlive(runtime: AgentRuntimeInternal): void {
  cancelCacheKeepAlive(runtime);
  const config = runtime.config.cacheKeepAlive;
  if (config?.enabled !== true) return;
  const threshold = resolveKeepAliveIdleThresholdMs(config);
  const timer = setTimeout(() => {
    void runtime.sendCacheKeepAliveRequest();
  }, threshold);
  timer.unref?.();
  runtime.cacheKeepAliveTimer = timer;
}

export function cancelCacheKeepAlive(runtime: AgentRuntimeInternal): void {
  if (runtime.cacheKeepAliveTimer !== undefined) {
    clearTimeout(runtime.cacheKeepAliveTimer);
    runtime.cacheKeepAliveTimer = undefined;
  }
}

/** 保活请求本体：投影当前历史 + ping user 消息，maxOutputTokens=16。
 * 不写历史、不发会话事件；usage 仅用于日志（cache_read 应接近全量）。 */
export async function sendCacheKeepAliveRequestImpl(runtime: AgentRuntimeInternal): Promise<void> {
  const selection = runtime.getSessionModelSelection();
  if (!selection) return;
  const { createTurnModel } = await import("./turn-model.js");
  const model = createTurnModel(runtime, { selection });
  const projected = buildProviderRequestMessages({
    entries: runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
    applyCacheControl: true,
  }).messages;
  if (projected.length === 0) return;
  const messages = [...projected, buildKeepAlivePingMessage()];
  const result = await model.generateText({
    messages,
    options: { maxOutputTokens: KEEP_ALIVE_MAX_OUTPUT_TOKENS },
  });
  const contextTokens = getModelUsageContextTokens(result.usage);
  runtime.logger?.info(`${CACHE_KEEP_ALIVE_TAG} cache refreshed`, {
    contextTokens: contextTokens ?? null,
    cacheReadTokens: result.usage?.cacheReadTokens ?? null,
  });
}
