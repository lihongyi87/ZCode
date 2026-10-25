import { describe, expect, it, vi } from "vitest";
import type { ProactiveStorePort } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { recordTurnUsageFact } from "../src/runtime/methods/usage-observability.js";

/**
 * spec 154 P2：turn 终态发布 task_completed/task_failed。
 *
 * 钉住的语义：
 * - completed → task_completed、error → task_failed、cancelled → 不发布（用户中止
 *   既非完成也非失败，不该触发「失败→善后」类订阅）；
 * - 发布失败不影响 turn 收尾主链路（吞错记 warn）；
 * - 无 proactiveStore（旧宿主）时零开销。
 */

function makeRuntime(overrides: { proactiveStore?: ProactiveStorePort } = {}) {
  const runtime = {
    sessionId: "sess_src",
    workspaceRoot: "/workspace/a",
    sessionStore: {
      getSession: vi.fn(async () => ({ directory: "/workspace/a" })),
      // usageStoreFor 的能力检测四件套：缺席会让 recordTurnUsageFact 在第一行短路。
      recordModelUsage: vi.fn(async () => undefined),
      upsertTurnUsage: vi.fn(async () => undefined),
      upsertToolUsage: vi.fn(async () => undefined),
      pruneUsage: vi.fn(async () => undefined),
    },
    logger: { warn: vi.fn(), info: vi.fn() },
    ...(overrides.proactiveStore ? { proactiveStore: overrides.proactiveStore } : {}),
  } as unknown as AgentRuntimeInternal;
  return runtime;
}

function makeStore(): { store: ProactiveStorePort; publish: ReturnType<typeof vi.fn> } {
  const publish = vi.fn(() => ({ event: {}, triggerIds: [] }));
  const store = { publishProactiveEvent: publish } as unknown as ProactiveStorePort;
  return { store, publish };
}

const turnInput = (status: string) =>
({
  completedAt: 1_700_000_000_000,
  events: [],
  startedAt: 1,
  status,
  traceContext: { traceId: "t", turnId: "turn_1" },
  turnId: "turn_1",
}) as never;

describe("recordTurnUsageFact 的 proactive 发布", () => {
  it("completed 发布 task_completed，事件幂等键含 turnId", async () => {
    const { store, publish } = makeStore();
    await recordTurnUsageFact(makeRuntime({ proactiveStore: store }), turnInput("completed"));
    expect(publish).toHaveBeenCalledTimes(1);
    const input = publish.mock.calls[0][0];
    expect(input.eventType).toBe("task_completed");
    expect(input.eventId).toBe("task:sess_src:turn_1:task_completed");
    expect(input.workspaceKey).toBe("/workspace/a");
    expect(input.targets).toEqual([]);
  });

  it("error 发布 task_failed", async () => {
    const { store, publish } = makeStore();
    await recordTurnUsageFact(makeRuntime({ proactiveStore: store }), turnInput("error"));
    expect(publish.mock.calls[0][0].eventType).toBe("task_failed");
  });

  it("cancelled 不发布", async () => {
    const { store, publish } = makeStore();
    await recordTurnUsageFact(makeRuntime({ proactiveStore: store }), turnInput("cancelled"));
    expect(publish).not.toHaveBeenCalled();
  });

  it("无 proactiveStore 时零调用", async () => {
    const runtime = makeRuntime();
    await recordTurnUsageFact(runtime, turnInput("completed"));
    // 不抛错即通过——无 store 路径在函数首行短路。
  });

  it("发布抛错不影响 turn 收尾（记 warn 不上抛）", async () => {
    const publish = vi.fn(() => {
      throw new Error("db locked");
    });
    const store = { publishProactiveEvent: publish } as unknown as ProactiveStorePort;
    const runtime = makeRuntime({ proactiveStore: store });
    await expect(recordTurnUsageFact(runtime, turnInput("completed"))).resolves.toBeUndefined();
    expect(runtime.logger?.warn).toHaveBeenCalled();
  });
});
