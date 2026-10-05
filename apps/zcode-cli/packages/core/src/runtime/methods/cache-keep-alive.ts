import type { AgentRuntimeInternal } from "../internal.js";
import { getModelUsageContextTokens, type ModelInputMessage } from "../deps.js";
import { buildProviderRequestMessages } from "../helpers/provider-request-messages.js";

/**
 * 缓存保活器（④）：会话空闲超过阈值时发一次同前缀迷你请求，刷新 provider
 * 侧 prompt cache。
 *
 * TTL 实测（2026-10-02，bench/cache-ttl-probe.mjs v2，openai 门 glm-5.2 95K 深度）：
 * 隐式前缀缓存 15 分钟表内全程存活（1/3/5/7/9/11/13/15min 全命中），未观测到过期；
 * 同深度 TTFT 冷 4.6s vs 热 1.0s（省 77%）。阈值取 12 分钟=保守落在实测存活窗内，
 * 保证刷新请求本身走 cache-read 价而非过期后全量重预填充。
 * （旧注释「10-20 分钟空档过期」来自生产相关性观测，探针实测推翻下限：t=7min
 * 出现 cached=95K 仍 10.6s 的尖峰，说明部分「长空档 TTFT 跳升」是排队而非过期。）
 *
 * 成本模型：保活请求的输入全部走 cache-read 价（约 0.1×），输出 16 token 上限；
 * 相比下次真实请求的全量重预填充（1× 输入 + 漫长等待），量级可忽略。
 *
 * 安全边界：
 * - 默认开启（显式 false 可关）；
 * - turn 运行中绝不触发（turn 启动先清定时器 + fire 时查活动 turn 双保险）；
 * - 触发失败静默降级——保活是优化，不是功能依赖；
 * - 刷新用的消息是投影副本 + 一条最小 ping user 消息，不写历史、不落会话。
 */

const DEFAULT_IDLE_THRESHOLD_MS = 12 * 60_000;
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
  // 默认开启（TTL 实测见文件头：12 分钟阈值落在实测存活窗内，刷新必走 cache-read 价）。
  if (config?.enabled === false) return;
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
  // turn 启动只清定时器，拦不住已出发的回调：请求在途时用户开新 turn 就并发了。
  // 保活是优化，让路——有活动 turn 时直接放弃本次刷新（下个 turn 结束会重排）。
  if (runtime.activeTurn) return;
  try {
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
  } catch (error) {
    // 保活失败静默降级（优化不是功能依赖），但必须捕获——定时器回调里
    // `void runtime.sendCacheKeepAliveRequest()` 的拒绝无人接会变 unhandled rejection。
    runtime.logger?.debug(`${CACHE_KEEP_ALIVE_TAG} refresh failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // 续排：单次 ping 只把缓存续活一个 TTL 窗（实测 ≥15min）。定时器只 fire 一次，
    // 不续排的话空闲超过约两个窗口缓存照样过期——保活形同虚设。空闲期间持续
    // 链式续排；turn 进行中不排（turn 结束会重排），成本每 12 分钟一次 cache-read 价。
    if (!runtime.activeTurn) scheduleCacheKeepAlive(runtime);
  }
}
