/**
 * spec 154：把 runtime config 的 proactiveOrchestration 解析成 dispatcher 可用的策略。
 *
 * 单一所有者是这里的解析函数——dispatcher 与将来任何调用方都从这里取，
 * 避免「某处默认开、另一处默认关」的分叉。缺省语义：**关闭**。
 */

export interface ProactiveOrchestrationPolicy {
  /** 总开关；false 时 dispatcher 不启动。 */
  enabled: boolean;
  /** 逐工作区同意：未列入的工作区连事件都不发布。 */
  isWorkspaceAllowed: (workspaceKey: string) => boolean;
  /** 派发循环间隔。 */
  pollIntervalMs: number;
}

export const DEFAULT_PROACTIVE_POLL_INTERVAL_MS = 5_000;

export function resolveProactiveOrchestrationPolicy(
  config:
    | {
        enabled?: boolean;
        allowedWorkspaceKeys?: readonly string[];
        pollIntervalMs?: number;
      }
    | undefined,
): ProactiveOrchestrationPolicy {
  const allowed = new Set(config?.allowedWorkspaceKeys ?? []);
  return {
    enabled: config?.enabled === true,
    // 双重闸门：总开关关闭时任何工作区都不算允许。名单为空同样全部拒绝——
    // 开启总开关但没有列任何工作区，等于没同意任何地方。
    isWorkspaceAllowed: (workspaceKey) =>
      config?.enabled === true && allowed.has(workspaceKey),
    pollIntervalMs:
      typeof config?.pollIntervalMs === "number" && config.pollIntervalMs > 0
        ? config.pollIntervalMs
        : DEFAULT_PROACTIVE_POLL_INTERVAL_MS,
  };
}

/**
 * 从环境变量解析主动编排配置（P1 的宿主开关面）：
 * - `ZCODE_PROACTIVE_ORCHESTRATION=1|true` 开总开关（缺省关）；
 * - `ZCODE_PROACTIVE_WORKSPACES` 逗号/分号分隔的同意工作区（绝对路径）名单。
 *
 * 放在 policy 层而不是 server 内联：env 语义与闸门语义同源，避免两处默认值分叉。
 */
export function resolveProactiveConfigFromEnv(env: NodeJS.ProcessEnv): {
  enabled: boolean;
  allowedWorkspaceKeys: string[];
  pollIntervalMs?: number;
} {
  const flag = (env.ZCODE_PROACTIVE_ORCHESTRATION ?? "").trim().toLowerCase();
  const enabled = flag === "1" || flag === "true" || flag === "yes";
  const allowedWorkspaceKeys = (env.ZCODE_PROACTIVE_WORKSPACES ?? "")
    .split(/[,;]/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const pollRaw = Number((env.ZCODE_PROACTIVE_POLL_INTERVAL_MS ?? "").trim());
  return {
    enabled,
    allowedWorkspaceKeys,
    ...(Number.isFinite(pollRaw) && pollRaw > 0 ? { pollIntervalMs: pollRaw } : {}),
  };
}
