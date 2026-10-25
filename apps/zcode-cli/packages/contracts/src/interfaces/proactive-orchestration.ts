import type { SessionId } from "./shared.js";

/**
 * spec 154：订阅式主动编排（proactive orchestration）。
 *
 * 语义：会话在 `session_entry(type = orchestration state)` 里声明订阅
 * 「当 sourceId 发生 event 时，用 prompt 唤醒我」。事件发布后按订阅生成 trigger，
 * dispatcher 认领并把 prompt 注入目标会话的输入队列——人工只发第一条命令，
 * 之后的协调链自动接力。
 *
 * 本文件只定义数据形状与判定规则；持久化在 proactivity 仓储（migration 0027）。
 */

/** 可触发唤醒的事件类别。P1 只落地 mailbox_message；其余为 P2 预留。 */
export type ProactiveEventType =
  | "mailbox_message"
  | "automation_due"
  | "task_completed"
  | "task_failed";

/** 会话的编排状态：`session_entry` 里 type=`orchestration state` 的那一条。 */
export interface ProactiveOrchestrationState {
  proactive?: {
    status: "running" | "paused";
    subscriptions: readonly ProactiveSubscription[];
    /** 订阅变更即递增；旧 generation 生成的 trigger 必须丢弃（防并发重放）。 */
    generation: number;
  };
}

/** 一条订阅：源会话发生 event 时，用 prompt 唤醒持有者。 */
export interface ProactiveSubscription {
  id: string;
  event: ProactiveEventType;
  /** 源会话 id（谁的事实会唤醒我）。 */
  sourceId: SessionId;
  /** 唤醒时注入的提示词。 */
  prompt: string;
}

/** 已发布事件的幂等记录。 */
export interface ProactiveEventRecord {
  eventId: string;
  workspaceKey: string;
  sourceSessionId: SessionId;
  eventType: ProactiveEventType;
  /** 信任锚：触发本次事件的命令锚点；缺失=来源不明，不得自动唤醒。 */
  sourceCommandId?: string;
  /** 因果链深度。 */
  depth: number;
  payload?: unknown;
  createdAt: number;
}

/** trigger 生命周期：pending → dispatching → delivered/rejected。 */
export type ProactiveTriggerState = "pending" | "dispatching" | "delivered" | "rejected";

export interface ProactiveTriggerRecord {
  id: string;
  eventId: string;
  targetSessionId: SessionId;
  subscriptionId: string;
  generation: number;
  /** 派发时使用的命令锚点（`task-app:<source>:proactive:<triggerId>`）。 */
  commandId: string;
  prompt: string;
  state: ProactiveTriggerState;
  attempts: number;
  retryAt?: number;
  ownerId?: string;
  leaseUntil?: number;
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
}

/** 因果深度上限：超过即丢弃，防止唤醒风暴。 */
export const MAX_PROACTIVE_CAUSAL_DEPTH = 8;
/** trigger 尝试上限：超过转 rejected 终止退避。 */
export const MAX_PROACTIVE_TRIGGER_ATTEMPTS = 8;
/** 派发租约：认领后该时长内其他 worker 不可抢占；过期即可被接管（崩溃自愈）。 */
export const PROACTIVE_TRIGGER_LEASE_MS = 30_000;

/**
 * 判定一条事件能否唤醒目标：来源锚点必须齐全、深度未超限。
 * 缺 sourceCommandId 的旧消息「可读但不得自动唤醒」。
 */
export function canProactivelyWake(input: {
  sourceCommandId?: string;
  depth: number;
  maxDepth?: number;
}): boolean {
  if (input.sourceCommandId === undefined || input.sourceCommandId.length === 0) return false;
  if (!Number.isInteger(input.depth) || input.depth < 0) return false;
  return input.depth <= (input.maxDepth ?? MAX_PROACTIVE_CAUSAL_DEPTH);
}

/**
 * trigger 幂等键：同一事件 + 目标 + 订阅 + generation 只能生成一条 trigger。
 * generation 参与哈希，订阅变更后的旧 trigger 自然失效。
 */
export function proactiveTriggerId(input: {
  eventId: string;
  targetSessionId: string;
  subscriptionId: string;
  generation: number;
}): string {
  return [
    "ptr",
    input.eventId,
    input.targetSessionId,
    input.subscriptionId,
    String(input.generation),
  ].join(":");
}

/** 派发命令锚点：把 trigger 溯源写入 commandId，供深度链回溯。 */
export function proactiveTriggerCommandId(input: {
  sourceSessionId: string;
  triggerId: string;
}): string {
  return `task-app:${input.sourceSessionId}:proactive:${input.triggerId}`;
}
