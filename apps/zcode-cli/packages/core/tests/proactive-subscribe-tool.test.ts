import { describe, expect, it, vi } from "vitest";
import type { SessionEntryInfo, SessionStorePort } from "@zcode/contracts";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { proactiveSubscribeToolEntry } from "../src/tool/handlers/proactive-subscribe.js";

/**
 * spec 154：订阅工具是自动接力的唯一声明入口。
 *
 * 钉住的语义：
 * - subscriptions 整体替换 + generation 递增（旧 trigger 失效的唯一依据）；
 * - status 单独切换时保留订阅集合；
 * - 损坏的既有状态不阻断写入（按缺失处理，generation 从 1 重启）；
 * - 无 sessionStore 时明确报 ConfigurationError。
 */

interface StoredState {
  proactive?: {
    status?: string;
    subscriptions?: { id: string; event: string; sourceId: string; prompt: string }[];
    generation?: number;
  };
}

function makeContext(overrides: { entries?: SessionEntryInfo[] } = {}): {
  context: ToolExecutionContext;
  saved: SessionEntryInfo[];
} {
  const saved: SessionEntryInfo[] = [];
  const sessionStore: Pick<SessionStorePort, "saveSessionEntry" | "sessionEntries"> = {
    saveSessionEntry: vi.fn(async (entry: SessionEntryInfo) => {
      saved.push(entry);
    }),
    sessionEntries: vi.fn(
      async () =>
        (overrides.entries ?? []) as Awaited<
          ReturnType<SessionStorePort["sessionEntries"]>
        >,
    ),
  };
  const context = {
    toolCallId: "tool_sub_1",
    sessionId: "sess_self",
    turnId: "turn_1",
    abortSignal: new AbortController().signal,
    sessionStore,
  } as unknown as ToolExecutionContext;
  return { context, saved };
}

function priorEntry(state: StoredState): SessionEntryInfo {
  return {
    id: "orchestration:sess_self",
    sessionID: "sess_self",
    type: "orchestration state",
    data: state,
    time: { created: 1, updated: 2 },
  } as unknown as SessionEntryInfo;
}

describe("ProactiveSubscribe handler", () => {
  it("写入订阅集合，status 缺省 running，generation 从 1 起", async () => {
    const { context, saved } = makeContext();
    const output = (await proactiveSubscribeToolEntry.handler(
      {
        subscriptions: [
          { event: "mailbox_message", sourceId: "sess_source", prompt: "继续集成" },
        ],
      },
      context,
    )) as { status: string; generation: number; subscriptionCount: number };

    expect(output.status).toBe("success");
    expect(output.generation).toBe(1);
    expect(output.subscriptionCount).toBe(1);

    const state = saved[0]?.data as StoredState;
    expect(state.proactive?.status).toBe("running");
    expect(state.proactive?.subscriptions?.[0]?.sourceId).toBe("sess_source");
    expect(state.proactive?.subscriptions?.[0]?.prompt).toBe("继续集成");
    // 订阅 id 由工具分配（稳定可追溯），不信任调用方。
    expect(state.proactive?.subscriptions?.[0]?.id).toContain("tool_sub_1");
  });

  it("再次声明时 generation 递增，subscriptions 整体替换", async () => {
    const { context, saved } = makeContext({
      entries: [
        priorEntry(
          {
            proactive: {
              status: "running",
              generation: 3,
              subscriptions: [
                { id: "old", event: "mailbox_message", sourceId: "sess_a", prompt: "p" },
              ],
            },
          },
        ),
      ],
    });
    const output = (await proactiveSubscribeToolEntry.handler(
      { subscriptions: [{ event: "task_completed", sourceId: "sess_b", prompt: "收尾" }] },
      context,
    )) as { generation: number; subscriptionCount: number };

    expect(output.generation).toBe(4);
    expect(output.subscriptionCount).toBe(1);
    const state = saved[0]?.data as StoredState;
    expect(state.proactive?.subscriptions?.[0]?.sourceId).toBe("sess_b");
  });

  it("空数组清除订阅", async () => {
    const { context, saved } = makeContext({
      entries: [
        priorEntry(
          {
            proactive: {
              status: "running",
              generation: 2,
              subscriptions: [
                { id: "old", event: "mailbox_message", sourceId: "sess_a", prompt: "p" },
              ],
            },
          },
        ),
      ],
    });
    const output = (await proactiveSubscribeToolEntry.handler(
      { subscriptions: [] },
      context,
    )) as { subscriptionCount: number; generation: number };

    expect(output.subscriptionCount).toBe(0);
    expect(output.generation).toBe(3);
    const state = saved[0]?.data as StoredState;
    expect(state.proactive?.subscriptions).toHaveLength(0);
    // 清空后仍是 running：状态本身不是「没有订阅」的证据。
    expect(state.proactive?.status).toBe("running");
  });

  it("仅切换 status 时保留既有订阅集合", async () => {
    const { context, saved } = makeContext({
      entries: [
        priorEntry(
          {
            proactive: {
              status: "running",
              generation: 1,
              subscriptions: [
                { id: "keep", event: "mailbox_message", sourceId: "sess_a", prompt: "p" },
              ],
            },
          },
        ),
      ],
    });
    const output = (await proactiveSubscribeToolEntry.handler(
      { status: "paused" },
      context,
    )) as { subscriptionCount: number; message?: string };

    expect(output.subscriptionCount).toBe(1);
    expect(output.message).toContain("paused");
    const state = saved[0]?.data as StoredState;
    expect(state.proactive?.status).toBe("paused");
    expect(state.proactive?.subscriptions).toHaveLength(1);
  });

  it("既有状态损坏时按缺失处理，generation 重启", async () => {
    const { context, saved } = makeContext({
      entries: [
        {
          id: "orchestration:sess_self",
          sessionID: "sess_self",
          type: "orchestration state",
          data: { proactive: "garbage" },
          time: { created: 1, updated: 2 },
        } as unknown as SessionEntryInfo,
      ],
    });
    const output = (await proactiveSubscribeToolEntry.handler(
      { subscriptions: [{ event: "task_failed", sourceId: "sess_x", prompt: "善后" }] },
      context,
    )) as { generation: number };

    expect(output.generation).toBe(1);
    expect(saved).toHaveLength(1);
  });

  it("无 sessionStore 报 ConfigurationError", async () => {
    const context = { toolCallId: "t", sessionId: "s" } as unknown as ToolExecutionContext;
    await expect(
      proactiveSubscribeToolEntry.handler(
        { subscriptions: [{ event: "mailbox_message", sourceId: "a", prompt: "p" }] },
        context,
      ),
    ).rejects.toThrow("Session store is not configured");
  });
});
