import type { ProactiveStorePort, SessionInfo, SessionMailboxPort } from "@zcode/contracts";
import {
  isWakeableTaskMessage,
  MAX_PROACTIVE_CAUSAL_DEPTH as CONTRACT_MAX_DEPTH,
} from "@zcode/contracts";
import {
  runProactiveDispatcherTick,
  type ProactiveDispatcherDeps,
  type ProactiveDispatcherTickResult,
  type ProactiveDispatcherWorkspace,
  type ProactiveMailboxMessage,
} from "./dispatcher.js";
import { readOrchestrationState, type OrchestrationStateReader } from "./orchestration-state.js";
import type { ProactiveOrchestrationPolicy } from "./policy.js";

/**
 * spec 154：把 dispatcher 接到宿主能力上。
 *
 * 这一层只做「装配」，不承载业务判断——每一步都能在 dispatcher 里找到对应语义：
 *
 *   listSessions()  ──►  按 directory 分组 = 工作区
 *                         （parentID 为空 = task root；time.deleted 为空 = 未归档）
 *   sessionEntries() ──►  readOrchestrationState
 *   mailbox          ──►  peekUnread（只读，绝不消费）
 *   enqueueDeferredInput ──► deliverPrompt
 *
 * 远程工作区在这里被硬排除：SessionInfo.directory 为空或指向远程挂载点的会话不进候选。
 */

export interface ProactiveHostWiring {
  store: ProactiveStorePort;
  mailbox: SessionMailboxPort;
  /** 会话枚举（跨工作区）；接线层自己按 directory 分组并过滤。 */
  listSessions: (input?: { limit?: number }) => Promise<readonly SessionInfo[]>;
  /** 会话存储的 session_entry 读写，供编排状态使用。 */
  sessionStore: OrchestrationStateReader;
  /** 把 prompt 注入目标会话（运行时 enqueueDeferredInput 的宿主包装）。 */
  enqueueDeferredInput: (sessionId: string, prompt: string) => Promise<void>;
  policy: ProactiveOrchestrationPolicy;
  now?: () => number;
  logger?: ProactiveDispatcherDeps["logger"];
  /** 判定路径是否属于远程工作区（挂载/UNC/ssh）。缺省只排除空路径。 */
  isRemoteWorkspacePath?: (directory: string) => boolean;
}

/** 缺省远程判定：UNC 路径（`\\host\share`）与常见远程挂载前缀。 */
export function defaultIsRemoteWorkspacePath(directory: string): boolean {
  if (directory.trim().length === 0) return true;
  if (directory.startsWith("\\\\")) return true;
  return /^\/(mnt|media|Volumes)\//.test(directory);
}

/**
 * 由会话列表推导「工作区 → 可唤醒的 task root 会话」。
 *
 * 过滤条件（与 spec 的「目标匹配」一致）：
 * - `parentID` 为空：subagent 会话不是 task root，不能被订阅唤醒；
 * - `time.deleted` 为空：已归档/删除的会话不参与；
 * - 目录非空且非远程。
 */
export function deriveWorkspaces(input: {
  sessions: readonly SessionInfo[];
  isRemoteWorkspacePath?: (directory: string) => boolean;
}): ProactiveDispatcherWorkspace[] {
  const isRemote = input.isRemoteWorkspacePath ?? defaultIsRemoteWorkspacePath;
  const byWorkspace = new Map<string, string[]>();
  for (const session of input.sessions) {
    if (session.parentID !== undefined) continue;
    if (session.time.deleted !== undefined) continue;
    const directory = session.directory?.trim() ?? "";
    if (directory.length === 0) continue;
    if (isRemote(directory)) continue;
    const bucket = byWorkspace.get(directory);
    if (bucket) {
      bucket.push(session.id);
    } else {
      byWorkspace.set(directory, [session.id]);
    }
  }
  return [...byWorkspace.entries()].map(([workspaceKey, targetSessionIds]) => ({
    workspaceKey,
    targetSessionIds,
  }));
}

/** 装配 dispatcher deps。 */
export function createProactiveDispatcherDeps(wiring: ProactiveHostWiring): ProactiveDispatcherDeps {
  return {
    store: wiring.store,
    now: wiring.now,
    ...(wiring.logger ? { logger: wiring.logger } : {}),
    listWorkspaces: async () => {
      const sessions = await wiring.listSessions({ limit: 500 });
      return deriveWorkspaces({
        sessions,
        ...(wiring.isRemoteWorkspacePath
          ? { isRemoteWorkspacePath: wiring.isRemoteWorkspacePath }
          : {}),
      });
    },
    readOrchestrationState: (sessionId) =>
      readOrchestrationState(wiring.sessionStore, sessionId),
    peekMessages: async (sessionId) => {
      // 只读窥视：不能用 drainUnread——dispatcher 还没发布事件就消费消息会丢唤醒。
      const envelopes = await wiring.mailbox.peekUnread({
        sessionId: sessionId as Parameters<SessionMailboxPort["peekUnread"]>[0]["sessionId"],
        limit: 20,
        filter: (envelope) => isWakeableTaskMessage(envelope, CONTRACT_MAX_DEPTH),
      });
      return envelopes.map(
        (envelope): ProactiveMailboxMessage => ({
          messageId: envelope.messageId,
          fromSessionId: envelope.fromSessionId,
          content: envelope.content,
          ...(envelope.sourceCommandId !== undefined
            ? { sourceCommandId: envelope.sourceCommandId }
            : {}),
          ...(envelope.depth !== undefined ? { depth: envelope.depth } : {}),
        }),
      );
    },
    deliverPrompt: async (input) => {
      await wiring.enqueueDeferredInput(input.targetSessionId, input.prompt);
    },
    isProactiveWorkAllowed: (workspaceKey) => wiring.policy.isWorkspaceAllowed(workspaceKey),
  };
}

/**
 * 单次派发（供宿主定时器调用）。
 *
 * 总开关关闭时直接返回零结果，不触达数据库与会话枚举——关闭状态下不该有任何开销。
 */
export async function runProactiveDispatch(
  wiring: ProactiveHostWiring,
): Promise<ProactiveDispatcherTickResult | null> {
  if (!wiring.policy.enabled) return null;
  return runProactiveDispatcherTick(createProactiveDispatcherDeps(wiring));
}
