import {
  MAX_PROACTIVE_CAUSAL_DEPTH,
  PROACTIVE_TRIGGER_LEASE_MS,
  canProactivelyWake,
  type ProactiveEventType,
  type ProactiveStorePort,
  type ProactiveSubscription,
} from "@zcode/contracts";

/**
 * spec 154 P1 dispatcher：把「已发布事件」变成「实际注入的唤醒」。
 *
 * 循环（每工作区约 5s 一次）：
 *   1) 对每个有订阅的会话，peek mailbox unread；
 *   2) 对可唤醒信封发布 proactive_event（幂等），并为匹配订阅生成 trigger；
 *   3) claim 本工作区的 trigger，逐个尝试注入目标会话；
 *   4) settle：成功 delivered，失败按退避重排（上限后 rejected）。
 *
 * 关键护栏（与 spec 一致）：
 * - 远程工作区硬排除（`allowWorkspace` 谓词由调用方注入）；
 * - `proactiveWorkAllowed` 默认关，未同意的工作区不发布事件；
 * - 缺 sourceCommandId 的旧消息可读但不得唤醒（canProactivelyWake）；
 * - 错误隔离：单个目标失败不影响其他 trigger。
 */

export interface ProactiveDispatcherDeps {
  /** 持久面端口（SqliteSessionStore 实现）；bootstrap/server 层经端口访问，不直接持 db。 */
  store: ProactiveStorePort;
  /** 枚举当前活跃工作区及其候选目标会话（同工作区 + 非 archived + task root）。 */
  listWorkspaces: () =>
    | Promise<readonly ProactiveDispatcherWorkspace[]>
    | readonly ProactiveDispatcherWorkspace[];
  /** 读取目标会话的编排状态（session_entry: orchestration state）。 */
  readOrchestrationState: (sessionId: string) =>
    | Promise<{
        subscriptions: readonly ProactiveSubscription[];
        generation: number;
        status: "running" | "paused";
      } | null>
    | {
        subscriptions: readonly ProactiveSubscription[];
        generation: number;
        status: "running" | "paused";
      }
    | null;
  /** 读取会话未读信箱（只读窥视，绝不移动文件）。 */
  peekMessages: (sessionId: string) =>
    | Promise<readonly ProactiveMailboxMessage[]>
    | readonly ProactiveMailboxMessage[];
  /** 把 prompt 注入目标会话输入队列。 */
  deliverPrompt: (input: {
    targetSessionId: string;
    prompt: string;
    commandId: string;
    sourceSessionId: string;
  }) => Promise<void>;
  /** 该工作区是否已被用户同意启用主动编排（缺省未同意）。 */
  isProactiveWorkAllowed: (workspaceKey: string) => boolean;
  now?: () => number;
  logger?: {
    info: (message: string, fields?: Record<string, unknown>) => void;
    warn: (message: string, fields?: Record<string, unknown>) => void;
  };
}

export interface ProactiveDispatcherWorkspace {
  workspaceKey: string;
  /** task root 会话（可被唤醒的候选）。 */
  targetSessionIds: readonly string[];
}

export interface ProactiveMailboxMessage {
  messageId: string;
  fromSessionId: string;
  content: string;
  sourceCommandId?: string;
  depth?: number;
}

export interface ProactiveDispatcherTickResult {
  publishedEvents: number;
  claimedTriggers: number;
  delivered: number;
  rejected: number;
  retried: number;
}

/**
 * 执行一次派发循环。幂等：同一批消息重复 tick 不会重复生成 trigger（eventId 幂等）。
 */
export async function runProactiveDispatcherTick(
  deps: ProactiveDispatcherDeps,
): Promise<ProactiveDispatcherTickResult> {
  const now = deps.now?.() ?? Date.now();
  const result: ProactiveDispatcherTickResult = {
    publishedEvents: 0,
    claimedTriggers: 0,
    delivered: 0,
    rejected: 0,
    retried: 0,
  };

  const workspaces = await deps.listWorkspaces();

  for (const workspace of workspaces) {
    // 护栏：逐工作区同意。未同意的工作区连事件都不发布，避免留下待派发 trigger。
    if (!deps.isProactiveWorkAllowed(workspace.workspaceKey)) continue;

    for (const targetSessionId of workspace.targetSessionIds) {
      const state = await deps.readOrchestrationState(targetSessionId);
      if (!state || state.status !== "running" || state.subscriptions.length === 0) continue;

      const messages = await deps.peekMessages(targetSessionId);
      for (const message of messages) {
        // 深度护栏：缺锚点或超深的旧消息只留在 unread，等人驱动交付。
        if (
          !canProactivelyWake({
            ...(message.sourceCommandId !== undefined
              ? { sourceCommandId: message.sourceCommandId }
              : {}),
            depth: message.depth ?? 0,
            maxDepth: MAX_PROACTIVE_CAUSAL_DEPTH,
          })
        ) {
          continue;
        }

        const { triggerIds } = deps.store.publishProactiveEvent({
          eventId: proactiveEventIdForMessage(message.messageId, targetSessionId),
          workspaceKey: workspace.workspaceKey,
          sourceSessionId: message.fromSessionId,
          eventType: "mailbox_message" satisfies ProactiveEventType,
          ...(message.sourceCommandId !== undefined
            ? { sourceCommandId: message.sourceCommandId }
            : {}),
          depth: message.depth ?? 0,
          payload: { messageId: message.messageId },
          now,
          targets: [
            {
              sessionId: targetSessionId,
              subscriptions: state.subscriptions,
              generation: state.generation,
            },
          ],
        });
        if (triggerIds.length > 0) result.publishedEvents += 1;
      }
    }

    // 认领并派发该工作区的 trigger。
    const triggers = deps.store.claimProactiveTriggers({
      ownerId: `dispatcher:${workspace.workspaceKey}`,
      leaseMs: PROACTIVE_TRIGGER_LEASE_MS,
      now,
      limit: 10,
      workspaceKey: workspace.workspaceKey,
    });
    result.claimedTriggers += triggers.length;

    for (const trigger of triggers) {
      try {
        await deps.deliverPrompt({
          targetSessionId: trigger.targetSessionId,
          prompt: trigger.prompt,
          commandId: trigger.commandId,
          sourceSessionId: sourceSessionIdFromCommandId(trigger.commandId),
        });
        deps.store.settleProactiveTrigger({
          triggerId: trigger.id,
          outcome: "delivered",
          now,
        });
        result.delivered += 1;
      } catch (error) {
        const settled = deps.store.settleProactiveTrigger({
          triggerId: trigger.id,
          outcome: "failed",
          now,
          failureReason: error instanceof Error ? error.message : String(error),
        });
        if (settled?.state === "rejected") {
          result.rejected += 1;
        } else {
          result.retried += 1;
        }
        deps.logger?.warn("proactive trigger delivery failed", {
          event: "proactive.trigger.delivery_failed",
          module: "adapters.proactive",
          triggerId: trigger.id,
          targetSessionId: trigger.targetSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return result;
}

/** 一条信箱消息对一个目标会话对应一个稳定 eventId：同一(消息,目标)只发布一次。 */
export function proactiveEventIdForMessage(messageId: string, targetSessionId: string): string {
  return `mailbox:${targetSessionId}:${messageId}`;
}

/** 从 `task-app:<source>:proactive:<triggerId>` 反解源会话。 */
function sourceSessionIdFromCommandId(commandId: string): string {
  const parts = commandId.split(":");
  // ["task-app", "<source>", "proactive", "<triggerId>"]
  return parts.length >= 2 ? (parts[1] ?? "") : "";
}
