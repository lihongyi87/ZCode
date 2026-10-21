import { describe, expect, it } from "vitest";
import type { SubagentSendMessageRequest } from "@zcode/contracts";
import {
  createExploreSubagentPort,
  type ExploreSubagentPortOptions,
} from "../src/subagent/runner.js";

function buildSendMessageRequest(to: string): SubagentSendMessageRequest {
  return {
    sessionId: "sess_a",
    parentToolCallId: "tool-1",
    to,
    summary: "handoff",
    message: "hello from A",
    workingDirectory: ".",
    workspaceRoot: ".",
    trace: { traceId: "trace-1" },
  } as unknown as SubagentSendMessageRequest;
}

function createPort(
  sendTaskMessage?: ExploreSubagentPortOptions["sendTaskMessage"],
) {
  return createExploreSubagentPort({
    createAgentId: () => "agent_test",
    emitParentEvent: async () => {},
    runExploreAgent: async () => {
      throw new Error("not used in task message routing test");
    },
    ...(sendTaskMessage ? { sendTaskMessage } : {}),
  });
}

describe("sendMessage task message routing (spec 149)", () => {
  it("routes sess_* targets to the task message bridge instead of failing", async () => {
    const calls: Array<{ toSessionId: string; content: string; sourceCommandId?: string }> = [];
    const port = createPort(async (input) => {
      calls.push(input);
      return {
        status: "success",
        messageId: "m-1",
        delivery: "queued",
        taskId: input.toSessionId,
      };
    });

    const result = await port.sendMessage!(buildSendMessageRequest("sess_b"));

    expect(result.status).toBe("success");
    expect(result.delivery).toBe("queued");
    expect(result.taskId).toBe("sess_b");
    expect(calls).toEqual([
      { toSessionId: "sess_b", content: "hello from A", sourceCommandId: "trace-1" },
    ]);
  });

  it("fails unknown non-session targets when no bridge handles them", async () => {
    const port = createPort();

    const result = await port.sendMessage!(buildSendMessageRequest("agent_unknown"));

    expect(result.status).toBe("failed");
    expect(result.error).toContain("No active local_agent task");
  });
});
