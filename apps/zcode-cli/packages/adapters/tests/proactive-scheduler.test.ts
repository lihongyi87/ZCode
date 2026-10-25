import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProactiveStorePort, SessionInfo } from "@zcode/contracts";
import { openProactiveStore } from "./helpers/proactive-store.js";
import { createProactiveScheduler } from "../src/proactive/scheduler.js";

/**
 * spec 154 调度器：宿主生命周期内的唯一派发触发者。
 *
 * 关注点是「不该有的行为」而不是 happy path：
 * - 关闭时不起定时器、不枚举会话；
 * - 缺 mailbox 时不启动（没有信箱就没有事件源）；
 * - 单轮失败不终止循环；
 * - dispose 后不再触发。
 */

const openDbs: { close(): void }[] = [];

function openStore(): ProactiveStorePort {
  const opened = openProactiveStore();
  openDbs.push(opened);
  return opened.store;
}

afterEach(() => {
  for (const opened of openDbs.splice(0)) opened.close();
  vi.useRealTimers();
});

function session(id: string): SessionInfo {
  return {
    id,
    projectID: "proj",
    taskType: "interactive",
    slug: "slug",
    directory: "/workspace/a",
    title: "t",
    version: "1",
    time: { created: 1, updated: 2 },
  } as SessionInfo;
}

function makeScheduler(overrides: Record<string, unknown> = {}) {
  const store = openStore();
  const listSessions = vi.fn(async () => [session("sess_a")]);
  const enqueueDeferredInput = vi.fn(async () => undefined);
  const scheduler = createProactiveScheduler({
    store,
    mailbox: { peekUnread: vi.fn(async () => []) } as never,
    listSessions,
    sessionStore: {
      sessionEntries: vi.fn(async () => []),
      saveSessionEntry: vi.fn(async () => undefined),
    },
    enqueueDeferredInput,
    config: { enabled: false },
    isRemoteWorkspacePath: () => false,
    ...overrides,
  });
  return { scheduler, listSessions, enqueueDeferredInput };
}

describe("createProactiveScheduler", () => {
  it("关闭时 start 不起定时器、runOnce 返回 null 且不枚举会话", async () => {
    vi.useFakeTimers();
    const { scheduler, listSessions } = makeScheduler();

    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await scheduler.runOnce();

    expect(result).toBeNull();
    expect(listSessions).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("缺 mailbox 时即使 enabled 也不启动", async () => {
    vi.useFakeTimers();
    const { scheduler, listSessions } = makeScheduler({
      mailbox: undefined,
      config: { enabled: true, allowedWorkspaceKeys: ["/workspace/a"] },
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(listSessions).not.toHaveBeenCalled();
    expect(await scheduler.runOnce()).toBeNull();
    scheduler.dispose();
  });

  it("启用后按间隔派发", async () => {
    vi.useFakeTimers();
    const { scheduler, listSessions } = makeScheduler({
      config: { enabled: true, allowedWorkspaceKeys: ["/workspace/a"], pollIntervalMs: 1_000 },
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(listSessions).toHaveBeenCalled();

    scheduler.dispose();
  });

  it("单轮异常不终止循环", async () => {
    vi.useFakeTimers();
    const listSessions = vi
      .fn<() => Promise<readonly SessionInfo[]>>()
      .mockRejectedValueOnce(new Error("db locked"))
      .mockResolvedValue([session("sess_a")]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const { scheduler } = makeScheduler({
      listSessions,
      logger,
      config: { enabled: true, allowedWorkspaceKeys: ["/workspace/a"], pollIntervalMs: 1_000 },
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(logger.warn).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(listSessions.mock.calls.length).toBeGreaterThanOrEqual(2);

    scheduler.dispose();
  });

  it("dispose 后不再触发", async () => {
    vi.useFakeTimers();
    const { scheduler, listSessions } = makeScheduler({
      config: { enabled: true, allowedWorkspaceKeys: ["/workspace/a"], pollIntervalMs: 1_000 },
    });

    scheduler.start();
    scheduler.dispose();
    const callsAfterDispose = listSessions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(listSessions.mock.calls.length).toBe(callsAfterDispose);
  });

  it("重复 start 只起一个定时器", async () => {
    vi.useFakeTimers();
    const { scheduler, listSessions } = makeScheduler({
      config: { enabled: true, allowedWorkspaceKeys: ["/workspace/a"], pollIntervalMs: 1_000 },
    });

    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_100);

    expect(listSessions).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });
});
