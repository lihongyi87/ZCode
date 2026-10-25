import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProactiveStorePort, SessionInfo } from "@zcode/contracts";
import { openProactiveStore } from "./helpers/proactive-store.js";
import { createNodeSessionMailboxAdapter } from "../src/mailbox/index.js";
import {
  createProactiveDispatcherDeps,
  defaultIsRemoteWorkspacePath,
  deriveWorkspaces,
  runProactiveDispatch,
} from "../src/proactive/host-wiring.js";
import { resolveProactiveOrchestrationPolicy } from "../src/proactive/policy.js";
import { writeSubscriptions } from "../src/proactive/orchestration-state.js";

/**
 * spec 154 接线层：把 dispatcher 接到宿主能力上。
 *
 * 这里钉住「谁能被唤醒」的边界——task root、未归档、非远程、已同意。
 * 任何一条退化都会让 subagent 或远程会话被误唤醒。
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

function session(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    projectID: "proj-1",
    taskType: "interactive",
    slug: "slug",
    directory: "/workspace/a",
    title: "title",
    version: "1",
    time: { created: 1, updated: 2 },
    ...overrides,
  } as SessionInfo;
}

describe("deriveWorkspaces", () => {
  it("按 directory 分组，只保留 task root", () => {
    const workspaces = deriveWorkspaces({
      sessions: [
        session({ id: "sess_a" as never, directory: "/workspace/a" }),
        session({ id: "sess_b" as never, directory: "/workspace/a" }),
        session({ id: "sess_c" as never, directory: "/workspace/b" }),
      ],
      isRemoteWorkspacePath: () => false,
    });

    expect(workspaces).toHaveLength(2);
    const a = workspaces.find((w) => w.workspaceKey === "/workspace/a");
    expect(a?.targetSessionIds).toEqual(["sess_a", "sess_b"]);
  });

  it("排除 subagent 会话（有 parentID）", () => {
    const workspaces = deriveWorkspaces({
      sessions: [
        session({ id: "sess_root" as never }),
        session({ id: "sess_child" as never, parentID: "sess_root" as never }),
      ],
      isRemoteWorkspacePath: () => false,
    });
    expect(workspaces[0]?.targetSessionIds).toEqual(["sess_root"]);
  });

  it("排除已删除/归档会话", () => {
    const workspaces = deriveWorkspaces({
      sessions: [
        session({ id: "sess_live" as never }),
        session({ id: "sess_gone" as never, time: { created: 1, updated: 2, deleted: 3 } }),
      ],
      isRemoteWorkspacePath: () => false,
    });
    expect(workspaces[0]?.targetSessionIds).toEqual(["sess_live"]);
  });

  it("排除远程工作区", () => {
    const workspaces = deriveWorkspaces({
      sessions: [
        session({ id: "sess_local" as never, directory: "/workspace/local" }),
        session({ id: "sess_remote" as never, directory: "\\\\server\\share" }),
      ],
    });
    expect(workspaces.map((w) => w.workspaceKey)).toEqual(["/workspace/local"]);
  });

  it("排除空目录会话", () => {
    const workspaces = deriveWorkspaces({
      sessions: [session({ id: "sess_empty" as never, directory: "  " })],
      isRemoteWorkspacePath: () => false,
    });
    expect(workspaces).toHaveLength(0);
  });
});

describe("defaultIsRemoteWorkspacePath", () => {
  it("UNC 与常见远程挂载点判为远程", () => {
    expect(defaultIsRemoteWorkspacePath("\\\\host\\share")).toBe(true);
    expect(defaultIsRemoteWorkspacePath("/mnt/c/workspace")).toBe(true);
    expect(defaultIsRemoteWorkspacePath("/Volumes/share")).toBe(true);
    expect(defaultIsRemoteWorkspacePath("")).toBe(true);
  });

  it("本地路径不算远程", () => {
    expect(defaultIsRemoteWorkspacePath("D:\\ZCode-src")).toBe(false);
    expect(defaultIsRemoteWorkspacePath("/home/user/project")).toBe(false);
  });
});

describe("runProactiveDispatch", () => {
  function wiring(overrides: {
    enabled: boolean;
    allowed?: readonly string[];
    sessions?: readonly SessionInfo[];
    peek?: () => Promise<never[]>;
  }) {
    const store = openStore();
    const sessionStore = {
      sessionEntries: vi.fn(async () => []),
      saveSessionEntry: vi.fn(async () => undefined),
    };
    const enqueueDeferredInput = vi.fn(async () => undefined);
    return {
      sessionStore,
      enqueueDeferredInput,
      wiring: {
        store,
        mailbox: {
          peekUnread: overrides.peek ?? (async () => []),
        } as never,
        listSessions: async () => overrides.sessions ?? [session({ id: "sess_a" as never })],
        sessionStore,
        enqueueDeferredInput,
        isRemoteWorkspacePath: () => false,
        policy: resolveProactiveOrchestrationPolicy({
          enabled: overrides.enabled,
          ...(overrides.allowed ? { allowedWorkspaceKeys: overrides.allowed } : {}),
        }),
      },
    };
  }

  it("总开关关闭时直接返回 null，不枚举会话", async () => {
    const listSessions = vi.fn(async () => []);
    const store = openStore();
    const result = await runProactiveDispatch({
      store,
      mailbox: { peekUnread: async () => [] } as never,
      listSessions,
      sessionStore: {
        sessionEntries: vi.fn(async () => []),
        saveSessionEntry: vi.fn(async () => undefined),
      },
      enqueueDeferredInput: vi.fn(async () => undefined),
      policy: resolveProactiveOrchestrationPolicy({ enabled: false }),
    });

    expect(result).toBeNull();
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("开启但工作区未列入名单时不派发", async () => {
    const h = wiring({ enabled: true, allowed: ["/other"] });
    h.sessionStore.sessionEntries.mockResolvedValue([
      {
        type: "orchestration state",
        data: {
          proactive: {
            status: "running",
            generation: 1,
            subscriptions: [
              { id: "s1", event: "mailbox_message", sourceId: "sess_src", prompt: "go" },
            ],
          },
        },
      },
    ]);

    const result = await runProactiveDispatch(h.wiring);

    expect(result?.publishedEvents).toBe(0);
    expect(h.enqueueDeferredInput).not.toHaveBeenCalled();
  });

  it("已同意工作区 + 有订阅 + 可唤醒消息 → 注入 prompt", async () => {
    const h = wiring({
      enabled: true,
      allowed: ["/workspace/a"],
      sessions: [session({ id: "sess_target" as never, directory: "/workspace/a" })],
      peek: async () =>
        [
          {
            messageId: "msg-1",
            fromSessionId: "sess_src",
            toSessionId: "sess_target",
            content: "done",
            createdAt: new Date(0).toISOString(),
            sourceType: "task",
            sourceCommandId: "cmd-1",
            depth: 0,
          },
        ] as never,
    });
    h.sessionStore.sessionEntries.mockResolvedValue([
      {
        type: "orchestration state",
        data: {
          proactive: {
            status: "running",
            generation: 1,
            subscriptions: [
              { id: "s1", event: "mailbox_message", sourceId: "sess_src", prompt: "继续" },
            ],
          },
        },
      },
    ]);

    const result = await runProactiveDispatch(h.wiring);

    expect(result?.delivered).toBe(1);
    expect(h.enqueueDeferredInput).toHaveBeenCalledWith("sess_target", "继续");
  });
});

describe("writeSubscriptions", () => {
  it("写入时 generation 递增，且读回内容一致", async () => {
    const store = new Map<string, unknown>();
    const reader = {
      sessionEntries: vi.fn(async (input: { sessionID: string }) => {
        const data = store.get(input.sessionID);
        return data === undefined
          ? []
          : [{ type: "orchestration state", data }];
      }),
      saveSessionEntry: vi.fn(async (input: { sessionID: string; data?: unknown }) => {
        store.set(input.sessionID, input.data);
      }),
    };

    const first = await writeSubscriptions(reader, {
      sessionId: "sess_a",
      subscriptions: [{ id: "s1", event: "mailbox_message", sourceId: "src", prompt: "go" }],
      now: 1,
    });
    const second = await writeSubscriptions(reader, {
      sessionId: "sess_a",
      subscriptions: [],
      now: 2,
    });

    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  it("端到端：writeSubscriptions 写入的状态可被 dispatcher 读取并派发（spec 154 P1 闭环）", async () => {
    const store = openStore();
    const sessionStoreState = new Map<string, unknown>();
    const sessionStore = {
      sessionEntries: vi.fn(async (input: { sessionID: string }) => {
        const data = sessionStoreState.get(input.sessionID);
        return data === undefined ? [] : [{ type: "orchestration state", data }];
      }),
      saveSessionEntry: vi.fn(async (input: { sessionID: string; data?: unknown }) => {
        sessionStoreState.set(input.sessionID, input.data);
      }),
    };

    // 1. 会话 B 声明订阅：A 的 mailbox_message 到来时用 prompt 唤醒我。
    await writeSubscriptions(sessionStore, {
      sessionId: "sess_target",
      subscriptions: [
        {
          id: "sub_e2e",
          event: "mailbox_message",
          sourceId: "sess_source",
          prompt: "上游已完成，继续集成",
        },
      ],
      now: 1,
    });

    // 2. A 给 B 发了一条可唤醒消息（sourceCommandId+depth 齐备）。
    const tmpRoot = await mkdtemp(join(tmpdir(), "zcode-e2e-proactive-"));
    const mailbox = createNodeSessionMailboxAdapter({ rootDir: tmpRoot });
    await mailbox.append({
      toSessionId: "sess_target" as never,
      fromSessionId: "sess_source" as never,
      content: "上游任务完成，产物在 /out",
      sourceType: "task",
      sourceCommandId: "cmd-upstream-1",
      depth: 0,
    });

    // 3. 调度器派发：peek 只读 → 发布事件 → 生成 trigger → 注入。
    const enqueueDeferredInput = vi.fn(async () => undefined);
    const result = await runProactiveDispatch({
      store,
      mailbox,
      listSessions: async () => [
        session({ id: "sess_target" as never, directory: "/workspace/e2e" }),
      ],
      sessionStore,
      enqueueDeferredInput,
      policy: resolveProactiveOrchestrationPolicy({
        enabled: true,
        allowedWorkspaceKeys: ["/workspace/e2e"],
      }),
      isRemoteWorkspacePath: () => false,
    });

    expect(result?.publishedEvents).toBe(1);
    expect(result?.delivered).toBe(1);
    expect(enqueueDeferredInput).toHaveBeenCalledWith(
      "sess_target",
      "上游已完成，继续集成",
    );

    // 4. 幂等：第二轮 tick 不重复注入。
    const second = await runProactiveDispatch({
      store,
      mailbox,
      listSessions: async () => [
        session({ id: "sess_target" as never, directory: "/workspace/e2e" }),
      ],
      sessionStore,
      enqueueDeferredInput,
      policy: resolveProactiveOrchestrationPolicy({
        enabled: true,
        allowedWorkspaceKeys: ["/workspace/e2e"],
      }),
      isRemoteWorkspacePath: () => false,
    });
    expect(second?.publishedEvents).toBe(0);
    expect(second?.delivered).toBe(0);
    expect(enqueueDeferredInput).toHaveBeenCalledTimes(1);
  });
});

describe("createProactiveDispatcherDeps", () => {
  it("peekMessages 只用 peekUnread（不消费消息）", async () => {
    const store = openStore();
    const peekUnread = vi.fn(async () => []);
    const drainUnread = vi.fn(async () => []);
    const deps = createProactiveDispatcherDeps({
      store,
      mailbox: { peekUnread, drainUnread } as never,
      listSessions: async () => [],
      sessionStore: {
        sessionEntries: vi.fn(async () => []),
        saveSessionEntry: vi.fn(async () => undefined),
      },
      enqueueDeferredInput: vi.fn(async () => undefined),
      policy: resolveProactiveOrchestrationPolicy({ enabled: true }),
    });

    await deps.peekMessages("sess_a");

    expect(peekUnread).toHaveBeenCalled();
    expect(drainUnread).not.toHaveBeenCalled();
  });
});
