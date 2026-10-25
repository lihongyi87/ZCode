import {
  applySqliteSchemaMigration,
  ensureSqliteSchemaMigrationTable,
} from "@zcode/shared/sqlite-migrations";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_PROACTIVE_TRIGGER_ATTEMPTS, canProactivelyWake } from "@zcode/contracts";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";
import {
  cancelProactiveTriggersForSession,
  claimProactiveTriggers,
  materializeProactiveTriggers,
  unmatchedProactiveEvents,
  proactiveDepthForSource,
  proactiveTriggersForSession,
  publishProactiveEvent,
  rejectStaleGenerationTriggers,
  settleProactiveTrigger,
} from "../src/storage/session-store/repositories/proactive-orchestration.js";

/**
 * spec 154 P1：订阅式主动编排的持久面。
 * 关注的不是「表能写」，而是三重幂等、单消费者认领、generation 防重放、深度溯源
 * ——这四条是防唤醒风暴的护栏，退化即线上事故。
 */

const openDbs: DatabaseSync[] = [];

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  openDbs.push(db);
  db.exec("BEGIN IMMEDIATE");
  ensureSqliteSchemaMigrationTable(db);
  for (const migration of SQLITE_MIGRATIONS) applySqliteSchemaMigration(db, migration);
  db.exec("COMMIT");
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

const NOW = 1_700_000_000_000;

function targets(generation = 1) {
  return [
    {
      sessionId: "sess_target",
      generation,
      subscriptions: [
        {
          id: "sub-1",
          event: "mailbox_message" as const,
          sourceId: "sess_source",
          prompt: "继续处理上游结果",
        },
      ],
    },
  ];
}

describe("publishProactiveEvent", () => {
  it("为匹配订阅生成 pending trigger", () => {
    const db = openDb();
    const { event, triggerIds } = publishProactiveEvent(db, {
      eventId: "evt-1",
      workspaceKey: "ws-1",
      sourceSessionId: "sess_source",
      eventType: "mailbox_message",
      sourceCommandId: "cmd-1",
      depth: 0,
      now: NOW,
      targets: targets(),
    });

    expect(event.eventId).toBe("evt-1");
    expect(event.depth).toBe(0);
    expect(triggerIds).toHaveLength(1);

    const triggers = proactiveTriggersForSession(db, { targetSessionId: "sess_target" });
    expect(triggers).toHaveLength(1);
    expect(triggers[0].state).toBe("pending");
    expect(triggers[0].prompt).toBe("继续处理上游结果");
    // 信任锚:commandId 必须可回溯到源会话。
    expect(triggers[0].commandId).toContain("task-app:sess_source:proactive:");
  });

  it("重复发布同一 eventId 幂等，不重复生成 trigger", () => {
    const db = openDb();
    const input = {
      eventId: "evt-dup",
      workspaceKey: "ws-1",
      sourceSessionId: "sess_source",
      eventType: "mailbox_message" as const,
      sourceCommandId: "cmd-1",
      depth: 0,
      now: NOW,
      targets: targets(),
    };
    publishProactiveEvent(db, input);
    const second = publishProactiveEvent(db, input);

    expect(second.triggerIds).toHaveLength(0);
    expect(proactiveTriggersForSession(db, { targetSessionId: "sess_target" })).toHaveLength(1);
  });

  it("订阅的 sourceId 不匹配时不生成 trigger", () => {
    const db = openDb();
    const { triggerIds } = publishProactiveEvent(db, {
      eventId: "evt-other-source",
      workspaceKey: "ws-1",
      sourceSessionId: "sess_other",
      eventType: "mailbox_message",
      sourceCommandId: "cmd-1",
      depth: 0,
      now: NOW,
      targets: targets(),
    });
    expect(triggerIds).toHaveLength(0);
  });

  it("订阅的 event 类型不匹配时不生成 trigger", () => {
    const db = openDb();
    const { triggerIds } = publishProactiveEvent(db, {
      eventId: "evt-other-event",
      workspaceKey: "ws-1",
      sourceSessionId: "sess_source",
      eventType: "task_completed",
      sourceCommandId: "cmd-1",
      depth: 0,
      now: NOW,
      targets: targets(),
    });
    expect(triggerIds).toHaveLength(0);
  });
});

describe("claim / settle", () => {
  function seedOneTrigger(db: DatabaseSync) {
    publishProactiveEvent(db, {
      eventId: "evt-claim",
      workspaceKey: "ws-1",
      sourceSessionId: "sess_source",
      eventType: "mailbox_message",
      sourceCommandId: "cmd-1",
      depth: 0,
      now: NOW,
      targets: targets(),
    });
    return proactiveTriggersForSession(db, { targetSessionId: "sess_target" })[0];
  }

  it("认领后进入 dispatching，owner 与租约写入", () => {
    const db = openDb();
    const trigger = seedOneTrigger(db);

    const claimed = claimProactiveTriggers(db, {
      ownerId: "worker-a",
      leaseMs: 30_000,
      now: NOW,
      limit: 10,
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(trigger.id);
    expect(claimed[0].state).toBe("dispatching");
    expect(claimed[0].ownerId).toBe("worker-a");
    expect(claimed[0].leaseUntil).toBe(NOW + 30_000);
  });

  it("租约未过期时其他 worker 认领不到", () => {
    const db = openDb();
    seedOneTrigger(db);
    claimProactiveTriggers(db, { ownerId: "worker-a", leaseMs: 30_000, now: NOW });

    const second = claimProactiveTriggers(db, {
      ownerId: "worker-b",
      leaseMs: 30_000,
      now: NOW + 1_000,
    });
    expect(second).toHaveLength(0);
  });

  it("租约过期后可被抢占（进程崩溃自愈）", () => {
    const db = openDb();
    seedOneTrigger(db);
    claimProactiveTriggers(db, { ownerId: "worker-a", leaseMs: 30_000, now: NOW });

    const reclaimed = claimProactiveTriggers(db, {
      ownerId: "worker-b",
      leaseMs: 30_000,
      now: NOW + 31_000,
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].ownerId).toBe("worker-b");
  });

  it("delivered 是终态，不再被认领", () => {
    const db = openDb();
    const trigger = seedOneTrigger(db);
    claimProactiveTriggers(db, { ownerId: "worker-a", leaseMs: 30_000, now: NOW });
    settleProactiveTrigger(db, { triggerId: trigger.id, outcome: "delivered", now: NOW + 100 });

    const again = claimProactiveTriggers(db, {
      ownerId: "worker-b",
      leaseMs: 30_000,
      now: NOW + 60_000,
    });
    expect(again).toHaveLength(0);
    expect(proactiveTriggersForSession(db, { targetSessionId: "sess_target" })[0].state).toBe(
      "delivered",
    );
  });

  it("失败按退避重排，到达上限转 rejected", () => {
    const db = openDb();
    const trigger = seedOneTrigger(db);

    let settled;
    for (let attempt = 1; attempt <= MAX_PROACTIVE_TRIGGER_ATTEMPTS; attempt += 1) {
      const at = NOW + attempt * 1_000;
      claimProactiveTriggers(db, { ownerId: "worker-a", leaseMs: 1, now: at });
      settled = settleProactiveTrigger(db, {
        triggerId: trigger.id,
        outcome: "failed",
        now: at,
        failureReason: "delivery-io-error",
        backoffMs: 1_000,
      });
      expect(settled?.attempts).toBe(attempt);
      // 只有累计尝试达到上限那一次才转 rejected，之前保持 pending 等退避重试。
      expect(settled?.state).toBe(attempt >= MAX_PROACTIVE_TRIGGER_ATTEMPTS ? "rejected" : "pending");
    }
    expect(settled?.state).toBe("rejected");
  });
});

describe("订阅变更与深度", () => {
  it("generation 递增后旧待派发 trigger 被拒", () => {
    const db = openDb();
    publishProactiveEvent(db, {
      eventId: "evt-gen",
      workspaceKey: "ws-1",
      sourceSessionId: "sess_source",
      eventType: "mailbox_message",
      sourceCommandId: "cmd-1",
      depth: 0,
      now: NOW,
      targets: targets(1),
    });

    const rejected = rejectStaleGenerationTriggers(db, {
      targetSessionId: "sess_target",
      currentGeneration: 2,
      now: NOW + 100,
    });

    expect(rejected).toBe(1);
    expect(proactiveTriggersForSession(db, { targetSessionId: "sess_target" })[0].state).toBe(
      "rejected",
    );
  });

  it("会话不可用时清理待派发 trigger", () => {
    const db = openDb();
    publishProactiveEvent(db, {
      eventId: "evt-cancel",
      workspaceKey: "ws-1",
      sourceSessionId: "sess_source",
      eventType: "mailbox_message",
      sourceCommandId: "cmd-1",
      depth: 0,
      now: NOW,
      targets: targets(),
    });

    expect(cancelProactiveTriggersForSession(db, { targetSessionId: "sess_target", now: NOW })).toBe(1);
  });

  it("深度沿 sourceCommandId 回溯", () => {
    const db = openDb();
    publishProactiveEvent(db, {
      eventId: "evt-depth",
      workspaceKey: "ws-1",
      sourceSessionId: "sess_source",
      eventType: "mailbox_message",
      sourceCommandId: "cmd-chain",
      depth: 3,
      now: NOW,
      targets: [],
    });

    expect(proactiveDepthForSource(db, "cmd-chain")).toBe(3);
    expect(proactiveDepthForSource(db, "cmd-unknown")).toBe(0);
    expect(proactiveDepthForSource(db, undefined)).toBe(0);
  });
});

describe("canProactivelyWake", () => {
  it("来源锚点齐全且深度未超限才允许唤醒", () => {
    expect(canProactivelyWake({ sourceCommandId: "cmd-1", depth: 0 })).toBe(true);
    expect(canProactivelyWake({ sourceCommandId: "cmd-1", depth: 8 })).toBe(true);
  });

  it("缺失来源锚点一律不得自动唤醒（旧消息可读不可唤醒）", () => {
    expect(canProactivelyWake({ depth: 0 })).toBe(false);
    expect(canProactivelyWake({ sourceCommandId: "", depth: 0 })).toBe(false);
  });

  it("超深与非法深度被拒", () => {
    expect(canProactivelyWake({ sourceCommandId: "cmd-1", depth: 9 })).toBe(false);
    expect(canProactivelyWake({ sourceCommandId: "cmd-1", depth: -1 })).toBe(false);
  });
});


describe("P2 事件物化（materialize/unmatched）", () => {
  it("targets 空发布的事件可被后声明的订阅物化", () => {
    const db = openDb();
    // runtime 发布 task_completed：事实记录，无订阅者。
    publishProactiveEvent(db, {
      eventId: "task:sess_src:turn_1:task_completed",
      workspaceKey: "ws-1",
      sourceSessionId: "sess_source",
      eventType: "task_completed",
      sourceCommandId: "turn:sess_src:turn_1",
      depth: 0,
      now: NOW,
      targets: [],
    });
    const unmatched = unmatchedProactiveEvents(db, { sinceMs: NOW - 1000, now: NOW + 10, limit: 10 });
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].eventType).toBe("task_completed");

    // 此后会话声明了订阅 → dispatcher 物化。
    const triggerIds = materializeProactiveTriggers(db, {
      eventId: "task:sess_src:turn_1:task_completed",
      now: NOW + 20,
      targets: [
        {
          sessionId: "sess_target",
          generation: 1,
          subscriptions: [
            { id: "sub-t", event: "task_completed", sourceId: "sess_source", prompt: "收尾" },
          ],
        },
      ],
    });
    expect(triggerIds).toHaveLength(1);
    // 物化后不再出现在 unmatched。
    expect(
      unmatchedProactiveEvents(db, { sinceMs: NOW - 1000, now: NOW + 30, limit: 10 }),
    ).toHaveLength(0);
  });

  it("物化幂等：重复调用零新增", () => {
    const db = openDb();
    publishProactiveEvent(db, {
      eventId: "task:sess_src:turn_2:task_failed",
      workspaceKey: "ws-1",
      sourceSessionId: "sess_source",
      eventType: "task_failed",
      sourceCommandId: "turn:sess_src:turn_2",
      depth: 0,
      now: NOW,
      targets: [],
    });
    const targets = [
      {
        sessionId: "sess_target",
        generation: 1,
        subscriptions: [
          { id: "sub-f", event: "task_failed", sourceId: "sess_source", prompt: "善后" },
        ],
      },
    ];
    expect(materializeProactiveTriggers(db, { eventId: "task:sess_src:turn_2:task_failed", now: NOW + 1, targets })).toHaveLength(1);
    expect(materializeProactiveTriggers(db, { eventId: "task:sess_src:turn_2:task_failed", now: NOW + 2, targets })).toHaveLength(0);
  });

  it("订阅的 sourceId 不匹配事件源时不物化", () => {
    const db = openDb();
    publishProactiveEvent(db, {
      eventId: "task:sess_other:turn_3:task_completed",
      workspaceKey: "ws-1",
      sourceSessionId: "sess_other",
      eventType: "task_completed",
      sourceCommandId: "turn:sess_other:turn_3",
      depth: 0,
      now: NOW,
      targets: [],
    });
    const triggerIds = materializeProactiveTriggers(db, {
      eventId: "task:sess_other:turn_3:task_completed",
      now: NOW + 1,
      targets: [
        {
          sessionId: "sess_target",
          generation: 1,
          subscriptions: [
            { id: "sub-x", event: "task_completed", sourceId: "sess_source", prompt: "p" },
          ],
        },
      ],
    });
    expect(triggerIds).toHaveLength(0);
  });

  it("回看窗口外的事件不再物化", () => {
    const db = openDb();
    publishProactiveEvent(db, {
      eventId: "task:sess_src:turn_old:task_completed",
      workspaceKey: "ws-1",
      sourceSessionId: "sess_source",
      eventType: "task_completed",
      sourceCommandId: "turn:sess_src:turn_old",
      depth: 0,
      now: NOW - 2 * 60 * 60 * 1000,
      targets: [],
    });
    expect(
      unmatchedProactiveEvents(db, { sinceMs: NOW - 60 * 60 * 1000, now: NOW, limit: 10 }),
    ).toHaveLength(0);
  });
});
