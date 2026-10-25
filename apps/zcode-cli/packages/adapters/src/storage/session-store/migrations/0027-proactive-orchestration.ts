// spec 154 P1：订阅式主动编排的持久面。
//
// 两张表各自承担单一职责：
// - proactive_event 是「已发布事件」的幂等记录（eventId 主键 + insert or ignore），
//   同时保存溯源事实（source_command_id / depth），让重启后仍可判定因果深度。
// - proactive_trigger 是「待派发唤醒」的工作队列：claim 用 owner_id/lease_until 单消费者
//   认领，settle 落终态，attempts/retry_at 承担退避。generation 随订阅变更递增，用于
//   丢弃订阅变更前生成的旧 trigger（防并发重放）。
//
// 索引即查询形状：
//   - proactive_event_workspace_idx：派发循环按工作区取新事件。
//   - proactive_trigger_pending_idx：claim 取「该工作区最早的可重试 pending 行」。
//   - proactive_trigger_target_idx：订阅变更/会话归档时按目标会话清理。
export const PROACTIVE_ORCHESTRATION_MIGRATION_SQL = `
  create table if not exists proactive_event (
    id text primary key,
    workspace_key text not null,
    source_session_id text not null,
    event_type text not null,
    source_command_id text,
    depth integer not null default 0,
    payload_json text,
    time_created integer not null
  );

  create index if not exists proactive_event_workspace_idx
    on proactive_event(workspace_key, time_created);

  create table if not exists proactive_trigger (
    id text primary key,
    event_id text not null references proactive_event(id) on delete cascade,
    target_session_id text not null,
    subscription_id text not null,
    generation integer not null,
    command_id text not null,
    prompt text not null,
    state text not null check(state in (
      'pending',
      'dispatching',
      'delivered',
      'rejected'
    )),
    attempts integer not null default 0,
    retry_at integer,
    owner_id text,
    lease_until integer,
    failure_reason text,
    time_created integer not null,
    time_updated integer not null
  );

  create unique index if not exists proactive_trigger_event_target_sub_idx
    on proactive_trigger(event_id, target_session_id, subscription_id);

  create index if not exists proactive_trigger_pending_idx
    on proactive_trigger(state, retry_at, time_created);

  create index if not exists proactive_trigger_target_idx
    on proactive_trigger(target_session_id, state);
`;
