import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProactiveStorePort, ProactiveSubscription } from "@zcode/contracts";
import { openProactiveStore } from "./helpers/proactive-store.js";
import {
  runProactiveDispatcherTick,
  type ProactiveDispatcherDeps,
  type ProactiveMailboxMessage,
} from "../src/proactive/dispatcher.js";

/**
 * spec 154 P1 dispatcher：事件 → trigger → 注入。
 *
 * 这里钉住的都是护栏而不是 happy path 本身：
 * - 未同意的工作区连事件都不发布（不留下垃圾 trigger）；
 * - 缺 sourceCommandId 的旧消息不得唤醒；
 * - 一条消息只发布一次事件（重复 tick 幂等）；
 * - 单个目标投递失败不影响其他目标，并进入退避。
 */

const openDbs: { close(): void }[] = [];

function openStore(): ProactiveStorePort {
  const opened = openProactiveStore();
  openDbs.push(opened);
  return opened.store;
}

afterEach(() => {
  for (const opened of openDbs.splice(0)) opened.close();
});

const NOW = 1_700_000_000_000;

function subscription(overrides: Partial<ProactiveSubscription> = {}): ProactiveSubscription {
  return {
    id: "sub-1",
    event: "mailbox_message",
    sourceId: "sess_source",
    prompt: "继续处理上游结果",
    ...overrides,
  };
}

function message(overrides: Partial<ProactiveMailboxMessage> = {}): ProactiveMailboxMessage {
  return {
    messageId: "msg-1",
    fromSessionId: "sess_source",
    content: "上游完成",
    sourceCommandId: "cmd-1",
    depth: 0,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ProactiveDispatcherDeps> = {}): ProactiveDispatcherDeps {
  const store = openStore();
  return {
    store,
    now: () => NOW,
    listWorkspaces: () => [{ workspaceKey: "ws-1", targetSessionIds: ["sess_target"] }],
    readOrchestrationState: () => ({
      subscriptions: [subscription()],
      generation: 1,
      status: "running" as const,
    }),
    peekMessages: () => [message()],
    deliverPrompt: vi.fn(async () => undefined),
    isProactiveWorkAllowed: () => true,
    ...overrides,
  };
}

describe("runProactiveDispatcherTick", () => {
  it("发布事件并投递 prompt", async () => {
    const deps = makeDeps();
    const result = await runProactiveDispatcherTick(deps);

    expect(result.publishedEvents).toBe(1);
    expect(result.delivered).toBe(1);
    expect(deps.deliverPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionId: "sess_target",
        prompt: "继续处理上游结果",
      }),
    );
  });

  it("未同意的工作区不发布事件也不派发", async () => {
    const deps = makeDeps({ isProactiveWorkAllowed: () => false });
    const result = await runProactiveDispatcherTick(deps);

    expect(result.publishedEvents).toBe(0);
    expect(result.delivered).toBe(0);
    expect(deps.deliverPrompt).not.toHaveBeenCalled();
  });

  it("缺 sourceCommandId 的旧消息不得唤醒（可读不可唤醒）", async () => {
    const deps = makeDeps({
      peekMessages: () => [message({ sourceCommandId: undefined })],
    });
    const result = await runProactiveDispatcherTick(deps);

    expect(result.publishedEvents).toBe(0);
    expect(result.delivered).toBe(0);
  });

  it("深度超限的消息不得唤醒", async () => {
    const deps = makeDeps({ peekMessages: () => [message({ depth: 9 })] });
    const result = await runProactiveDispatcherTick(deps);

    expect(result.publishedEvents).toBe(0);
    expect(result.delivered).toBe(0);
  });

  it("重复 tick 幂等：同一消息不重复发布与派发", async () => {
    const deps = makeDeps();
    await runProactiveDispatcherTick(deps);
    const second = await runProactiveDispatcherTick(deps);

    expect(second.publishedEvents).toBe(0);
    expect(second.delivered).toBe(0);
    expect(deps.deliverPrompt).toHaveBeenCalledTimes(1);
  });

  it("paused 状态不派发", async () => {
    const deps = makeDeps({
      readOrchestrationState: () => ({
        subscriptions: [subscription()],
        generation: 1,
        status: "paused" as const,
      }),
    });
    const result = await runProactiveDispatcherTick(deps);

    expect(result.publishedEvents).toBe(0);
    expect(result.delivered).toBe(0);
  });

  it("无匹配订阅不生成 trigger", async () => {
    const deps = makeDeps({
      readOrchestrationState: () => ({
        subscriptions: [subscription({ sourceId: "sess_other" })],
        generation: 1,
        status: "running" as const,
      }),
    });
    const result = await runProactiveDispatcherTick(deps);

    expect(result.publishedEvents).toBe(0);
    expect(result.delivered).toBe(0);
  });

  it("投递失败进入退避，不抛出到调用方", async () => {
    const deps = makeDeps({
      deliverPrompt: vi.fn(async () => {
        throw new Error("target busy");
      }),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const result = await runProactiveDispatcherTick(deps);

    expect(result.retried).toBe(1);
    expect(result.delivered).toBe(0);
    expect(deps.logger?.warn).toHaveBeenCalled();

    const triggers = deps.store.proactiveTriggersForSession({ targetSessionId: "sess_target" });
    expect(triggers[0].state).toBe("pending");
    expect(triggers[0].attempts).toBe(1);
    expect(triggers[0].retryAt).toBeGreaterThan(NOW);
  });

  it("多个目标互不影响：一个失败另一个仍投递", async () => {
    const deliverPrompt = vi.fn(async (input: { targetSessionId: string }) => {
      if (input.targetSessionId === "sess_a") throw new Error("busy");
    });
    const deps = makeDeps({
      listWorkspaces: () => [
        { workspaceKey: "ws-1", targetSessionIds: ["sess_a", "sess_b"] },
      ],
      peekMessages: () => [message()],
      readOrchestrationState: () => ({
        subscriptions: [subscription()],
        generation: 1,
        status: "running" as const,
      }),
      deliverPrompt,
    });
    const result = await runProactiveDispatcherTick(deps);

    expect(deliverPrompt).toHaveBeenCalledTimes(2);
    expect(result.retried).toBe(1);
    // 两个目标各一条 trigger；sess_b 已 delivered。
    expect(
      deps.store.proactiveTriggersForSession({ targetSessionId: "sess_b" })[0].state,
    ).toBe("delivered");
  });
});


describe("runProactiveDispatcherTick P2 事件物化", () => {
  it("task_completed 事件被当前订阅物化并注入", async () => {
    const store = openStore();
    // runtime 已发布 task_completed（targets 空）。
    store.publishProactiveEvent({
      eventId: "task:sess_source:turn_9:task_completed",
      workspaceKey: "ws-1",
      sourceSessionId: "sess_source",
      eventType: "task_completed",
      sourceCommandId: "turn:sess_source:turn_9",
      depth: 0,
      now: NOW,
      targets: [],
    });

    const deliverPrompt = vi.fn(async () => undefined);
    const deps = {
      store,
      now: () => NOW + 5_000,
      listWorkspaces: () => [{ workspaceKey: "ws-1", targetSessionIds: ["sess_target"] }],
      readOrchestrationState: () => ({
        subscriptions: [
          { id: "sub-t", event: "task_completed", sourceId: "sess_source", prompt: "上游完成了，收尾" },
        ],
        generation: 1,
        status: "running" as const,
      }),
      peekMessages: async () => [],
      deliverPrompt,
      isProactiveWorkAllowed: () => true,
    };
    const result = await runProactiveDispatcherTick(deps);

    expect(result.materializedEvents).toBe(1);
    expect(result.delivered).toBe(1);
    expect(deliverPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "上游完成了，收尾" }),
    );
    // 下一轮：事件已有 trigger，不再物化。
    const second = await runProactiveDispatcherTick(deps);
    expect(second.materializedEvents).toBe(0);
  });

  it("缺 sourceCommandId 的事件不物化（来源不明不唤醒）", async () => {
    const store = openStore();
    store.publishProactiveEvent({
      eventId: "task:sess_source:turn_bad:task_failed",
      workspaceKey: "ws-1",
      sourceSessionId: "sess_source",
      eventType: "task_failed",
      depth: 0,
      now: NOW,
      targets: [],
    });
    const deliverPrompt = vi.fn(async () => undefined);
    const deps = {
      store,
      now: () => NOW + 5_000,
      listWorkspaces: () => [{ workspaceKey: "ws-1", targetSessionIds: ["sess_target"] }],
      readOrchestrationState: () => ({
        subscriptions: [
          { id: "sub-f", event: "task_failed", sourceId: "sess_source", prompt: "善后" },
        ],
        generation: 1,
        status: "running" as const,
      }),
      peekMessages: async () => [],
      deliverPrompt,
      isProactiveWorkAllowed: () => true,
    };
    const result = await runProactiveDispatcherTick(deps);
    expect(result.materializedEvents).toBe(0);
    expect(deliverPrompt).not.toHaveBeenCalled();
  });
});
