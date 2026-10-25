import type {
  ProactiveEventRecord,
  ProactiveEventType,
  ProactiveSubscription,
  ProactiveTriggerRecord,
  ProactiveTriggerState,
} from "./proactive-orchestration.js";

/**
 * spec 154：主动编排持久面端口。
 *
 * 为什么单独建 port 而不是把方法塞进 `SessionStorePort`：proactive 是可选能力，
 * 宿主关闭时完全不该触达；独立 port 让「不支持」可被显式表达（undefined 即不支持），
 * 也避免给 SessionStorePort 这个巨型接口再加七个方法。
 *
 * 实现方：adapters 的 SqliteSessionStore（migration 0027 的两张表）。
 */
export interface ProactiveStorePort {
  /** 发布事件并按匹配订阅生成 trigger（eventId 幂等）。 */
  publishProactiveEvent(input: {
    eventId: string;
    workspaceKey: string;
    sourceSessionId: string;
    eventType: ProactiveEventType;
    sourceCommandId?: string;
    depth: number;
    payload?: unknown;
    now: number;
    targets: readonly {
      sessionId: string;
      subscriptions: readonly ProactiveSubscription[];
      generation: number;
    }[];
  }): { event: ProactiveEventRecord; triggerIds: readonly string[] };

  /** 认领待派发 trigger（owner 租约单消费者）。 */
  claimProactiveTriggers(input: {
    ownerId: string;
    leaseMs: number;
    now: number;
    limit?: number;
    workspaceKey?: string;
  }): ProactiveTriggerRecord[];

  /** 结算 trigger（delivered/rejected 终态；failed 退避重试）。 */
  settleProactiveTrigger(input: {
    triggerId: string;
    outcome: "delivered" | "failed" | "rejected";
    now: number;
    failureReason?: string;
    backoffMs?: number;
  }): ProactiveTriggerRecord | undefined;

  /** 因果深度：沿 sourceCommandId 回溯已接力层数。 */
  proactiveDepthForSource(sourceCommandId: string | undefined): number;

  /** 订阅 generation 变更后拒绝旧 trigger。 */
  rejectStaleGenerationTriggers(input: {
    targetSessionId: string;
    currentGeneration: number;
    now: number;
  }): number;

  /** 目标会话不可用时清理其待派发 trigger。 */
  cancelProactiveTriggersForSession(input: { targetSessionId: string; now: number }): number;

  /** 读取某会话的 trigger（诊断/UI）。 */
  proactiveTriggersForSession(input: {
    targetSessionId: string;
    state?: ProactiveTriggerState;
  }): ProactiveTriggerRecord[];

  /**
   * P2 事件物化：为已存在的事件按「当前」订阅补生成 trigger。
   * 发布者（runtime/cron）不知道订阅者，dispatcher 轮询时枚举订阅并物化；
   * 幂等由 (event,target,subscription) 唯一索引承担。
   */
  materializeProactiveTriggers(input: {
    eventId: string;
    now: number;
    targets: readonly {
      sessionId: string;
      subscriptions: readonly ProactiveSubscription[];
      generation: number;
    }[];
  }): readonly string[];

  /** 近窗内无任何 trigger 的事件（物化候选）。 */
  unmatchedProactiveEvents(input: {
    workspaceKey?: string;
    sinceMs: number;
    now: number;
    limit?: number;
  }): ProactiveEventRecord[];
}
