import type { ProactiveStorePort, SessionInfo, SessionMailboxPort } from "@zcode/contracts";
import { createNodeSessionMailboxAdapter } from "../mailbox/index.js";
import { resolvePath } from "../config/index.js";
import {
  runProactiveDispatch,
  type ProactiveHostWiring,
} from "./host-wiring.js";
import {
  DEFAULT_PROACTIVE_POLL_INTERVAL_MS,
  resolveProactiveConfigFromEnv,
  resolveProactiveOrchestrationPolicy,
} from "./policy.js";
import type { OrchestrationStateReader } from "./orchestration-state.js";

/**
 * spec 154 P1：主动编排调度器（宿主生命周期内唯一的派发触发者）。
 *
 * 位置：挂在 app 生命周期上而不是单会话 runtime——dispatcher 跨会话工作，
 * 单会话 runtime 只知道自己。
 *
 * 设计约束：
 * - **缺省不启动**：`enabled` 为 false 时 start() 直接 no-op，没有任何定时器与开销。
 * - **串行**：上一轮未完成时跳过本轮（不排队）——派发是幂等的，堆积只会放大延迟。
 * - **失败不自杀**：单轮异常记 warn 后继续下一轮；调度器停摆会让用户以为功能坏了。
 * - **dispose 幂等**：close 时清掉定时器，不留悬挂句柄防止进程无法退出。
 */

export interface ProactiveSchedulerOptions {
  store: ProactiveStorePort;
  mailbox: SessionMailboxPort | undefined;
  listSessions: (input?: { limit?: number }) => Promise<readonly SessionInfo[]>;
  sessionStore: OrchestrationStateReader;
  enqueueDeferredInput: (sessionId: string, prompt: string) => Promise<void>;
  config:
    | { enabled?: boolean; allowedWorkspaceKeys?: readonly string[]; pollIntervalMs?: number }
    | undefined;
  isRemoteWorkspacePath?: (directory: string) => boolean;
  now?: () => number;
  logger?: {
    info: (message: string, fields?: Record<string, unknown>) => void;
    warn: (message: string, fields?: Record<string, unknown>) => void;
  };
}

export interface ProactiveScheduler {
  /** 启动周期派发；未启用或缺少 mailbox 时为 no-op。 */
  start(): void;
  /** 立即跑一轮（测试与手动触发）；未启用时返回 null。 */
  runOnce(): Promise<Awaited<ReturnType<typeof runProactiveDispatch>>>;
  dispose(): void;
}

export function createProactiveScheduler(options: ProactiveSchedulerOptions): ProactiveScheduler {
  const policy = resolveProactiveOrchestrationPolicy(options.config);
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let disposed = false;

  const wiring: ProactiveHostWiring | null =
    options.mailbox === undefined
      ? null
      : {
          store: options.store,
          mailbox: options.mailbox,
          listSessions: options.listSessions,
          sessionStore: options.sessionStore,
          enqueueDeferredInput: options.enqueueDeferredInput,
          policy,
          ...(options.isRemoteWorkspacePath
            ? { isRemoteWorkspacePath: options.isRemoteWorkspacePath }
            : {}),
          ...(options.now ? { now: options.now } : {}),
          ...(options.logger ? { logger: options.logger } : {}),
        };

  async function tick(): Promise<Awaited<ReturnType<typeof runProactiveDispatch>>> {
    if (!wiring || !policy.enabled || disposed) return null;
    // 串行：上一轮没跑完就跳过。派发幂等，跳过一轮只会晚 5s，不会丢 trigger。
    if (running) return null;
    running = true;
    try {
      const result = await runProactiveDispatch(wiring);
      if (result && (result.delivered > 0 || result.rejected > 0)) {
        options.logger?.info("proactive dispatch tick", {
          event: "proactive.dispatch.tick",
          module: "bootstrap.proactive",
          ...result,
        });
      }
      return result;
    } catch (error) {
      // 单轮失败不终止循环：调度器停摆会被用户误判为功能失效。
      options.logger?.warn("proactive dispatch tick failed", {
        event: "proactive.dispatch.tick_failed",
        module: "bootstrap.proactive",
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      running = false;
    }
  }

  return {
    start(): void {
      if (disposed || timer !== undefined) return;
      if (!wiring || !policy.enabled) return;
      const interval = policy.pollIntervalMs || DEFAULT_PROACTIVE_POLL_INTERVAL_MS;
      timer = setInterval(() => {
        void tick();
      }, interval);
      // 不阻止进程退出：派发是可选增强，不能成为退出屏障。
      timer.unref?.();
      options.logger?.info("proactive scheduler started", {
        event: "proactive.scheduler.started",
        module: "bootstrap.proactive",
        intervalMs: interval,
      });
    },
    runOnce: tick,
    dispose(): void {
      disposed = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

/**
 * 从环境变量构造调度器（server/宿主的唯一入口）。
 *
 * mailbox 与会话 app 的信箱同 root（`ZCODE_MAILBOX_ROOT ?? ~/.zcode/mailbox`），
 * 且只在消息面开启（`ZCODE_MESSAGE_ENABLED`，与 bootstrap app-config-options 的
 * isMessageEnabled 同语义）时存在——没有消息面就没有 mailbox_message 事件源，
 * 调度器无从工作，直接不启动。返回的调度器仍需调用方显式 start()。
 */
export function createProactiveSchedulerFromEnv(
  options: Omit<ProactiveSchedulerOptions, "mailbox" | "config"> & {
    env: NodeJS.ProcessEnv;
  },
): ProactiveScheduler {
  const { env, ...rest } = options;
  const messageEnabled =
    env.ZCODE_MESSAGE_ENABLED === "1" || env.ZCODE_MESSAGE_ENABLED === "true";
  return createProactiveScheduler({
    ...rest,
    // 信箱根与会话 mailbox 完全同源；这里自建实例只做读（peek），不产生写入方冲突。
    // 消息面关闭时显式传 undefined：调度器因缺少事件源不启动。
    // spec 154 P3:设置面同意状态由宿主(services/node.ts)翻译成
    // ZCODE_PROACTIVE_ORCHESTRATION / ZCODE_PROACTIVE_WORKSPACES 注入本进程 env
    // (telemetryEnabled 同款注入先例)——env 是唯一配置通道,不设双链。
    mailbox: messageEnabled ? createSchedulerMailbox(env) : undefined,
    config: resolveProactiveConfigFromEnv(env),
  });
}

function createSchedulerMailbox(env: NodeJS.ProcessEnv): SessionMailboxPort {
  // 信箱根与会话 mailbox 完全同源；这里自建实例只做读（peek），不产生写入方冲突。
  return createNodeSessionMailboxAdapter({
    rootDir: resolvePath(env.ZCODE_MAILBOX_ROOT ?? "~/.zcode/mailbox"),
  });
}
