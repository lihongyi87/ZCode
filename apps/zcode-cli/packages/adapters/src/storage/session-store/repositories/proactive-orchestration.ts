import type { DatabaseSync } from "node:sqlite";
import {
  MAX_PROACTIVE_TRIGGER_ATTEMPTS,
  proactiveTriggerCommandId,
  proactiveTriggerId,
  type ProactiveEventRecord,
  type ProactiveEventType,
  type ProactiveSubscription,
  type ProactiveTriggerRecord,
  type ProactiveTriggerState,
} from "@zcode/contracts";

/**
 * spec 154 P1 仓储：事件发布 / trigger 生成 / 认领 / 结算 / 因果深度。
 *
 * 设计约束（对应 spec 里的护栏）：
 * - 幂等三重：事件 eventId 主键（insert or ignore）、trigger (event,target,subscription)
 *   唯一索引、triggerId 由 sha256 等价键生成。重复发布会返回既有行而不是报错。
 * - 单消费者：claim 用 owner_id + lease_until，过期租约可被抢占（进程崩溃后自愈）。
 * - generation 防重放：订阅变更递增 generation，旧 generation 的 pending trigger 直接判 rejected。
 * - depth 沿 commandId 回溯，不靠调用方传值猜测。
 */

interface ProactiveEventRow {
  id: string;
  workspace_key: string;
  source_session_id: string;
  event_type: string;
  source_command_id: string | null;
  depth: number;
  payload_json: string | null;
  time_created: number;
}

interface ProactiveTriggerRow {
  id: string;
  event_id: string;
  target_session_id: string;
  subscription_id: string;
  generation: number;
  command_id: string;
  prompt: string;
  state: string;
  attempts: number;
  retry_at: number | null;
  owner_id: string | null;
  lease_until: number | null;
  failure_reason: string | null;
  time_created: number;
  time_updated: number;
}

function decodeEventRow(row: ProactiveEventRow): ProactiveEventRecord {
  return {
    eventId: row.id,
    workspaceKey: row.workspace_key,
    sourceSessionId: row.source_session_id as ProactiveEventRecord["sourceSessionId"],
    eventType: row.event_type as ProactiveEventType,
    ...(row.source_command_id !== null ? { sourceCommandId: row.source_command_id } : {}),
    depth: row.depth,
    ...(row.payload_json !== null ? { payload: JSON.parse(row.payload_json) as unknown } : {}),
    createdAt: row.time_created,
  };
}

function decodeTriggerRow(row: ProactiveTriggerRow): ProactiveTriggerRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    targetSessionId: row.target_session_id as ProactiveTriggerRecord["targetSessionId"],
    subscriptionId: row.subscription_id,
    generation: row.generation,
    commandId: row.command_id,
    prompt: row.prompt,
    state: row.state as ProactiveTriggerState,
    attempts: row.attempts,
    ...(row.retry_at !== null ? { retryAt: row.retry_at } : {}),
    ...(row.owner_id !== null ? { ownerId: row.owner_id } : {}),
    ...(row.lease_until !== null ? { leaseUntil: row.lease_until } : {}),
    ...(row.failure_reason !== null ? { failureReason: row.failure_reason } : {}),
    createdAt: row.time_created,
    updatedAt: row.time_updated,
  };
}

/**
 * 发布事件并为匹配的订阅生成 trigger。
 *
 * @returns 新建的事件行；eventId 已存在时返回既有行（幂等，不重复生成 trigger）。
 */
export function publishProactiveEvent(
  db: DatabaseSync,
  input: {
    eventId: string;
    workspaceKey: string;
    sourceSessionId: string;
    eventType: ProactiveEventType;
    sourceCommandId?: string;
    depth: number;
    payload?: unknown;
    now: number;
    /** 目标候选：由调用方按「同工作区 + 非 archived + task root」筛好，这里只按订阅匹配。 */
    targets: readonly {
      sessionId: string;
      subscriptions: readonly ProactiveSubscription[];
      generation: number;
    }[];
  },
): { event: ProactiveEventRecord; triggerIds: readonly string[] } {
  const insertEvent = db
    .prepare(
      `
      insert or ignore into proactive_event
        (id, workspace_key, source_session_id, event_type, source_command_id, depth, payload_json, time_created)
      values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      input.eventId,
      input.workspaceKey,
      input.sourceSessionId,
      input.eventType,
      input.sourceCommandId ?? null,
      input.depth,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.now,
    );

  const existing = db
    .prepare("select * from proactive_event where id = ?")
    .get(input.eventId) as unknown as ProactiveEventRow;
  const event = decodeEventRow(existing);

  // 幂等：事件已存在说明此前已生成过 trigger，直接返回，不重复派发。
  if (insertEvent.changes === 0) {
    return { event, triggerIds: [] };
  }

  const triggerIds: string[] = [];
  const insertTrigger = db.prepare(
    `
    insert or ignore into proactive_trigger
      (id, event_id, target_session_id, subscription_id, generation, command_id, prompt,
       state, attempts, retry_at, owner_id, lease_until, failure_reason, time_created, time_updated)
    values (?, ?, ?, ?, ?, ?, ?, 'pending', 0, null, null, null, null, ?, ?)
    `,
  );

  for (const target of input.targets) {
    for (const subscription of target.subscriptions) {
      // 订阅必须同时匹配事件类型与源会话——只按 event 匹配会让「任何会话发生该事件」
      // 都唤醒订阅者，与 spec「sourceId 是订阅的一部分」冲突。
      if (subscription.event !== input.eventType) continue;
      if (subscription.sourceId !== input.sourceSessionId) continue;
      const triggerId = proactiveTriggerId({
        eventId: input.eventId,
        targetSessionId: target.sessionId,
        subscriptionId: subscription.id,
        generation: target.generation,
      });
      const result = insertTrigger.run(
        triggerId,
        input.eventId,
        target.sessionId,
        subscription.id,
        target.generation,
        proactiveTriggerCommandId({
          sourceSessionId: input.sourceSessionId,
          triggerId,
        }),
        subscription.prompt,
        input.now,
        input.now,
      );
      if (result.changes > 0) triggerIds.push(triggerId);
    }
  }

  return { event, triggerIds };
}

/**
 * 为已存在的事件按「当前」订阅补生成 trigger（P2 事件物化）。
 *
 * task_completed/task_failed/automation_due 由 runtime/cron 在事实发生点发布，
 * 发布者不知道谁订阅了自己——dispatcher 轮询时枚举当前订阅并物化。
 * 幂等由 (event,target,subscription) 唯一索引承担，重复物化零副作用。
 */
export function materializeProactiveTriggers(
  db: DatabaseSync,
  input: {
    eventId: string;
    now: number;
    targets: readonly {
      sessionId: string;
      subscriptions: readonly ProactiveSubscription[];
      generation: number;
    }[];
  },
): readonly string[] {
  const event = db
    .prepare("select * from proactive_event where id = ?")
    .get(input.eventId) as unknown as ProactiveEventRow | undefined;
  if (!event) return [];

  const triggerIds: string[] = [];
  const insertTrigger = db.prepare(
    `
    insert or ignore into proactive_trigger
      (id, event_id, target_session_id, subscription_id, generation, command_id, prompt,
       state, attempts, retry_at, owner_id, lease_until, failure_reason, time_created, time_updated)
    values (?, ?, ?, ?, ?, ?, ?, 'pending', 0, null, null, null, null, ?, ?)
    `,
  );
  for (const target of input.targets) {
    for (const subscription of target.subscriptions) {
      if (subscription.event !== event.event_type) continue;
      if (subscription.sourceId !== event.source_session_id) continue;
      const triggerId = proactiveTriggerId({
        eventId: input.eventId,
        targetSessionId: target.sessionId,
        subscriptionId: subscription.id,
        generation: target.generation,
      });
      const result = insertTrigger.run(
        triggerId,
        input.eventId,
        target.sessionId,
        subscription.id,
        target.generation,
        proactiveTriggerCommandId({
          sourceSessionId: event.source_session_id,
          triggerId,
        }),
        subscription.prompt,
        input.now,
        input.now,
      );
      if (result.changes > 0) triggerIds.push(triggerId);
    }
  }
  return triggerIds;
}

/**
 * 近窗内「没有任何 trigger」的事件（物化候选）。
 *
 * 有 trigger（含 rejected/delivered）即视为已处理——物化只发生在「发布时订阅者
 * 还没声明」的窗口；此后新声明的订阅不追溯旧事件（订阅是向前看的契约）。
 */
export function unmatchedProactiveEvents(
  db: DatabaseSync,
  input: { workspaceKey?: string; sinceMs: number; now: number; limit?: number },
): ProactiveEventRecord[] {
  // 参数顺序与 SQL 中 ? 的出现顺序一致：since、now、[workspace]、limit。
  const workspaceFilter = input.workspaceKey === undefined ? "" : " and e.workspace_key = ?";
  const params: (string | number)[] = [input.sinceMs, input.now];
  if (input.workspaceKey !== undefined) params.push(input.workspaceKey);
  params.push(input.limit ?? 50);
  const rows = db
    .prepare(
      `
      select e.* from proactive_event e
      where e.time_created >= ? and e.time_created <= ?
        and not exists (select 1 from proactive_trigger t where t.event_id = e.id)
        ${workspaceFilter}
      order by e.time_created, e.rowid
      limit ?
      `,
    )
    .all(...params) as unknown as ProactiveEventRow[];
  return rows.map(decodeEventRow);
}

/**
 * 认领一批待派发 trigger（单消费者）。
 *
 * 租约过期或 retry_at 已到期的 pending 行都可以被认领——进程崩溃留下的 dispatching 行
 * 靠租约过期自愈，不需要额外的恢复扫描。
 */
export function claimProactiveTriggers(
  db: DatabaseSync,
  input: {
    ownerId: string;
    leaseMs: number;
    now: number;
    limit?: number;
    workspaceKey?: string;
  },
): ProactiveTriggerRecord[] {
  const limit = input.limit ?? 10;
  // 工作区过滤走 join：trigger 自身没有 workspace 列（它的归属由事件决定），
  // 按事件的工作区圈定本次认领范围——不 join 会让一个工作区的 dispatcher 认领
  // 到别的工作区的 trigger，跨区投递。
  const workspaceFilter = input.workspaceKey === undefined ? "" : " and e.workspace_key = ?";
  const params: (string | number)[] = [input.now, input.now];
  if (input.workspaceKey !== undefined) params.push(input.workspaceKey);
  params.push(limit);

  const rows = db
    .prepare(
      `
      select t.* from proactive_trigger t
      join proactive_event e on e.id = t.event_id
      where ((t.state = 'pending' and (t.retry_at is null or t.retry_at <= ?))
          or (t.state = 'dispatching' and t.lease_until is not null and t.lease_until <= ?))
        ${workspaceFilter}
      order by t.time_created, t.rowid
      limit ?
      `,
    )
    .all(...params) as unknown as ProactiveTriggerRow[];

  if (rows.length === 0) return [];

  const claim = db.prepare(
    `
    update proactive_trigger
    set state = 'dispatching', owner_id = ?, lease_until = ?, time_updated = ?
    where id = ?
    `,
  );
  for (const row of rows) {
    claim.run(input.ownerId, input.now + input.leaseMs, input.now, row.id);
  }

  return rows.map((row) =>
    decodeTriggerRow({
      ...row,
      state: "dispatching",
      owner_id: input.ownerId,
      lease_until: input.now + input.leaseMs,
      time_updated: input.now,
    }),
  );
}

/**
 * 结算 trigger。
 *
 * - delivered / rejected 是终态。
 * - failed 时按 attempts 递增并退避；超过上限转 rejected 终止。
 */
export function settleProactiveTrigger(
  db: DatabaseSync,
  input: {
    triggerId: string;
    outcome: "delivered" | "failed" | "rejected";
    now: number;
    failureReason?: string;
    backoffMs?: number;
  },
): ProactiveTriggerRecord | undefined {
  const row = db
    .prepare("select * from proactive_trigger where id = ?")
    .get(input.triggerId) as unknown as ProactiveTriggerRow | undefined;
  if (!row) return undefined;

  if (input.outcome === "delivered" || input.outcome === "rejected") {
    db.prepare(
      `
      update proactive_trigger
      set state = ?, owner_id = null, lease_until = null, failure_reason = ?, time_updated = ?
      where id = ?
      `,
    ).run(input.outcome, input.failureReason ?? null, input.now, input.triggerId);
  } else {
    const attempts = row.attempts + 1;
    const exhausted = attempts >= MAX_PROACTIVE_TRIGGER_ATTEMPTS;
    db.prepare(
      `
      update proactive_trigger
      set state = ?, attempts = ?, retry_at = ?, owner_id = null, lease_until = null,
          failure_reason = ?, time_updated = ?
      where id = ?
      `,
    ).run(
      exhausted ? "rejected" : "pending",
      attempts,
      exhausted ? null : input.now + (input.backoffMs ?? 5_000),
      input.failureReason ?? null,
      input.now,
      input.triggerId,
    );
  }

  const updated = db
    .prepare("select * from proactive_trigger where id = ?")
    .get(input.triggerId) as unknown as ProactiveTriggerRow;
  return decodeTriggerRow(updated);
}

/**
 * 因果深度：沿 sourceCommandId 回溯该命令已接力了多少层。
 *
 * 缺失或无法解析时返回 0（人驱动起点）。不做「猜 depth」——来源不明一律按 0 处理，
 * 由 `canProactivelyWake` 的 sourceCommandId 检查拒绝自动唤醒。
 */
export function proactiveDepthForSource(db: DatabaseSync, sourceCommandId: string | undefined): number {
  if (sourceCommandId === undefined || sourceCommandId.length === 0) return 0;
  const row = db
    .prepare("select depth from proactive_event where source_command_id = ? order by depth desc limit 1")
    .get(sourceCommandId) as { depth: number } | undefined;
  return row?.depth ?? 0;
}

/** 订阅变更（generation 递增）后，把旧 generation 的待派发 trigger 判为 rejected。 */
export function rejectStaleGenerationTriggers(
  db: DatabaseSync,
  input: { targetSessionId: string; currentGeneration: number; now: number },
): number {
  const result = db
    .prepare(
      `
      update proactive_trigger
      set state = 'rejected', failure_reason = 'subscription-generation-changed', time_updated = ?
      where target_session_id = ? and generation < ? and state in ('pending', 'dispatching')
      `,
    )
    .run(input.now, input.targetSessionId, input.currentGeneration);
  return Number(result.changes);
}

/** 会话归档/删除时清理其待派发 trigger。 */
export function cancelProactiveTriggersForSession(
  db: DatabaseSync,
  input: { targetSessionId: string; now: number },
): number {
  const result = db
    .prepare(
      `
      update proactive_trigger
      set state = 'rejected', failure_reason = 'target-session-unavailable', time_updated = ?
      where target_session_id = ? and state in ('pending', 'dispatching')
      `,
    )
    .run(input.now, input.targetSessionId);
  return Number(result.changes);
}

/** 读取某会话的待派发 trigger（诊断/UI 用）。 */
export function proactiveTriggersForSession(
  db: DatabaseSync,
  input: { targetSessionId: string; state?: ProactiveTriggerState },
): ProactiveTriggerRecord[] {
  const rows = input.state
    ? (db
        .prepare("select * from proactive_trigger where target_session_id = ? and state = ? order by time_created")
        .all(input.targetSessionId, input.state) as unknown as ProactiveTriggerRow[])
    : (db
        .prepare("select * from proactive_trigger where target_session_id = ? order by time_created")
        .all(input.targetSessionId) as unknown as ProactiveTriggerRow[]);
  return rows.map(decodeTriggerRow);
}
