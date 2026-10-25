import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  DELIVERY_PROFILES,
  conversationDeltaSchema,
  filterConversationDeltasForProfile,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

const preview = {
  text: "latest",
  fullText: "earlier\nlatest",
  totalBytes: 40960,
  totalLines: 500,
  linesEstimated: true,
};
function harness() {
  const projection = new ProductProjection("bash-progress", "epoch");
  let seq = 0;
  const apply = (type: SessionEvent["type"], payload: unknown, source?: unknown) =>
    projection.applyEvent({
      id: `event-${++seq}`,
      sessionId: "bash-progress",
      turnId: "turn-1",
      traceId: "trace",
      timestamp: new Date(1700000000000 + seq),
      sequenceNumber: seq,
      type,
      payload,
      ...(source ? { source } : {}),
    } as SessionEvent);
  apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200000 });
  apply(SessionEventType.TurnStarted, { turnNumber: 1, input: "run", messageId: "user-1" });
  apply(SessionEventType.ToolCallScheduled, {
    toolCallId: "bash-1",
    toolName: "Bash",
    input: { command: "build" },
    schedule: { parallelGroups: [["bash-1"]], executionOrder: ["bash-1"] },
  });
  apply(SessionEventType.ToolCallStarted, { toolCallId: "bash-1", toolName: "Bash" });
  const row = () =>
    projection.getSnapshot().rows.window.find((r) => r.kind === "toolCall") as ToolCallRow;
  const progress = () =>
    apply(SessionEventType.ToolCallProgress, {
      toolCallId: "bash-1",
      toolName: "Bash",
      outputPreview: preview,
    });
  return { projection, apply, row, progress };
}
describe("Bash progress product projection", () => {
  it("publishes a bounded preview in whole rows for both delivery profiles", () => {
    const h = harness();
    const deltas = h.progress();
    expect(h.row().outputPreview).toEqual(preview);
    expect(
      deltas.some((delta) => delta.op === "row.upserted" && delta.row.kind === "toolCall"),
    ).toBe(true);
    for (const delta of deltas) expect(conversationDeltaSchema.parse(delta)).toEqual(delta);
    for (const profile of Object.values(DELIVERY_PROFILES)) {
      expect(filterConversationDeltasForProfile(deltas, profile)).toEqual(deltas);
    }
    expect(h.row().progress).toBeUndefined();
  });
  it.each([
    SessionEventType.ToolCallResult,
    SessionEventType.ToolCallError,
    SessionEventType.TurnComplete,
  ])("clears preview on %s and rejects late progress", (type) => {
    const h = harness();
    h.progress();
    h.apply(
      type,
      type === SessionEventType.ToolCallResult
        ? { toolCallId: "bash-1", result: { success: true, content: "done" }, duration: 1 }
        : {
            toolCallId: "bash-1",
            error: { type: "tool_cancelled", message: "stopped" },
            reason: "user",
            resultType: "cancelled",
          },
    );
    expect(h.row().outputPreview).toBeUndefined();
    expect(h.progress()).toEqual([]);
    expect(h.row().outputPreview).toBeUndefined();
  });
  it("clears the launch preview while the committed background work stays running", () => {
    const h = harness();
    h.progress();
    h.apply(SessionEventType.BackgroundTaskStarted, {
      taskId: "background-1",
      toolCallId: "bash-1",
      taskKind: "bash",
      toolName: "Bash",
      status: "running",
      cancellable: true,
    });
    h.apply(SessionEventType.ToolCallResult, {
      toolCallId: "bash-1",
      result: { success: true, content: "Command running in background. Output file: /output.log" },
      duration: 1,
    });
    expect(h.row().outputPreview).toBeUndefined();
    expect(h.progress()).toEqual([]);
    expect(h.projection.getSnapshot().backgroundWorks).toContainEqual(
      expect.objectContaining({ workId: "background-1", status: "running" }),
    );
  });
  it("ignores child tool mirrors in the parent", () => {
    const parent = harness();
    expect(
      parent.apply(SessionEventType.ToolCallProgress, {
        toolCallId: "bash-1",
        source: "subagent",
        outputPreview: preview,
      }),
    ).toEqual([]);
    expect(parent.row().outputPreview).toBeUndefined();
  });
  it("does not create a row for unknown or invalid previews", () => {
    const h = harness();
    expect(
      h.apply(SessionEventType.ToolCallProgress, { toolCallId: "missing", outputPreview: preview }),
    ).toEqual([]);
    expect(
      h.apply(SessionEventType.ToolCallProgress, {
        toolCallId: "bash-1",
        outputPreview: { ...preview, fullText: "x".repeat(4097) },
      }),
    ).toEqual([]);
    expect(h.row().outputPreview).toBeUndefined();
  });
});

describe("Bash result display projection", () => {
  it("preserves structured output in both profiles and the final snapshot", () => {
    const h = harness();
    const display = {
      kind: "bash_output",
      output: "head",
      truncated: true,
      outputPath: "/tmp/full.output",
    };
    const deltas = h.apply(SessionEventType.ToolCallResult, {
      toolCallId: "bash-1",
      result: { success: true, content: "model preview", display },
      duration: 1,
    });
    expect(h.row().output?.display).toEqual(display);
    for (const profile of Object.values(DELIVERY_PROFILES)) {
      const filtered = filterConversationDeltasForProfile(deltas, profile);
      for (const delta of filtered) expect(conversationDeltaSchema.parse(delta)).toEqual(delta);
    }
  });
});

describe("ToolOutput waiting heartbeat projection (TaskOutput 阻塞等待)", () => {
  function heartbeatHarness() {
    const projection = new ProductProjection("wait-heartbeat", "epoch");
    let seq = 0;
    const apply = (type: SessionEvent["type"], payload: unknown) =>
      projection.applyEvent({
        id: `event-${++seq}`,
        sessionId: "wait-heartbeat",
        turnId: "turn-1",
        traceId: "trace",
        timestamp: new Date(1700000000000 + seq),
        sequenceNumber: seq,
        type,
        payload,
      } as SessionEvent);
    apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200000 });
    apply(SessionEventType.TurnStarted, { turnNumber: 1, input: "wait", messageId: "user-1" });
    apply(SessionEventType.ToolCallScheduled, {
      toolCallId: "task-output-1",
      toolName: "TaskOutput",
      input: { task_id: "task-1", block: true, timeout: 60000 },
      schedule: { parallelGroups: [["task-output-1"]], executionOrder: ["task-output-1"] },
    });
    apply(SessionEventType.ToolCallStarted, { toolCallId: "task-output-1", toolName: "TaskOutput" });
    const row = () =>
      projection.getSnapshot().rows.window.find((r) => r.kind === "toolCall") as ToolCallRow;
    const heartbeat = (elapsedMs: number) =>
      apply(SessionEventType.ToolCallProgress, {
        toolCallId: "task-output-1",
        toolName: "TaskOutput",
        elapsedMs,
      });
    return { apply, row, heartbeat };
  }

  it("projects elapsedMs-only heartbeats to row.progress（否则 UI 只剩转圈）", () => {
    const h = heartbeatHarness();
    // 回归：只有 elapsedMs 的心跳曾被整条丢弃（fraction/total/message 全缺）。
    const deltas = h.heartbeat(15_000);
    expect(h.row().progress?.elapsedMs).toBe(15_000);
    expect(h.row().progress?.fraction).toBeUndefined();
    expect(
      deltas.some((delta) => delta.op === "row.upserted" && delta.row.kind === "toolCall"),
    ).toBe(true);
    for (const delta of deltas) expect(conversationDeltaSchema.parse(delta)).toEqual(delta);

    // 后续心跳更新到更晚的等待时长。
    h.heartbeat(30_000);
    expect(h.row().progress?.elapsedMs).toBe(30_000);
  });

  it("still ignores heartbeats with no usable field", () => {
    const h = heartbeatHarness();
    const deltas = h.apply(SessionEventType.ToolCallProgress, {
      toolCallId: "task-output-1",
      toolName: "TaskOutput",
    });
    expect(deltas).toEqual([]);
    expect(h.row().progress).toBeUndefined();
  });

  it("projects zero-output Bash progress to row.progress（静默命令不能只剩转圈）", () => {
    // 回归（用户实测 sleep 240s 像卡死）：静默命令没有 stdout/stderr → 没有
    // outputPreview。旧实现要求 preview 解析成功才放行，把「零输出」这唯一需要
    // 字节可见性的场景整条丢弃，UI 只剩转圈。
    const h = harness();
    const deltas = h.apply(SessionEventType.ToolCallProgress, {
      toolCallId: "bash-1",
      toolName: "Bash",
      outputBytes: 0,
      elapsedMs: 12_000,
    });
    expect(h.row().progress?.bytes).toBe(0);
    expect(h.row().outputPreview).toBeUndefined();
    expect(
      deltas.some((delta) => delta.op === "row.upserted" && delta.row.kind === "toolCall"),
    ).toBe(true);
    for (const delta of deltas) expect(conversationDeltaSchema.parse(delta)).toEqual(delta);
  });
});
