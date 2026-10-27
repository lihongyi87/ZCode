import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@zcode/contracts";
import type { ToolEntry, ToolExecutor, ToolRegistry } from "@zcode/core";
import {
  createNodeReplToolsBroker,
  injectNodeReplToolsBroker,
  type NodeReplToolsBroker,
} from "../src/app/node-repl-tools-broker.js";
import { createNodeReplToolsPort } from "../src/app/node-repl-tools-port.js";

const logger: Logger = {
  child: () => logger,
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

function fakeEntry(name: string, needsApproval = false): ToolEntry {
  return {
    metadata: { name, description: `${name} 描述`, needsApproval },
    inputSchema: { type: "object" },
  } as unknown as ToolEntry;
}

function fakeRegistry(entries: ToolEntry[]): ToolRegistry {
  return {
    get: (name: string) => entries.find((entry) => entry.metadata.name === name),
    has: (name: string) => entries.some((entry) => entry.metadata.name === name),
    list: () => entries.map((entry) => entry.metadata.name),
  } as unknown as ToolRegistry;
}

function fakeExecutor(
  run: (call: { id: string; name: string; input: unknown }) => {
    toolCallId: string;
    toolName: string;
    success: boolean;
    output: unknown;
  },
): ToolExecutor {
  return {
    execute: vi.fn(async (call) => run(call)),
  } as unknown as ToolExecutor;
}

function exchange(socketPath: string, request: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    });
    socket.on("error", reject);
  });
}

describe("node_repl tools broker", () => {
  let broker: NodeReplToolsBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  it("injects an authenticated local endpoint only into the global node_repl server", () => {
    broker = createNodeReplToolsBroker({ getToolsPort: () => undefined, logger });
    const untouched: Record<string, unknown> = { type: "http", url: "https://example.test/mcp" };
    const servers = injectNodeReplToolsBroker(
      {
        node_repl: { type: "stdio", command: "node", args: ["server.js"] },
        remote: untouched as never,
      },
      broker,
    );

    expect(servers.node_repl).toMatchObject({
      env: {
        ZCODE_NODE_REPL_TOOLS_BROKER_SOCKET: broker.socketPath,
        ZCODE_NODE_REPL_TOOLS_BROKER_TOKEN: broker.token,
      },
    });
    expect(servers.remote).toBe(untouched);
  });

  it("describe 只暴露策略预批工具（needsApproval 被过滤）", async () => {
    const port = createNodeReplToolsPort({
      registry: fakeRegistry([fakeEntry("read_file"), fakeEntry("bash", true)]),
      executor: fakeExecutor(() => ({
        toolCallId: "call-1",
        toolName: "read_file",
        success: true,
        output: "ignored",
      })),
    });
    broker = createNodeReplToolsBroker({ getToolsPort: () => port, logger });
    await broker.ready;

    const response = await exchange(broker.socketPath, {
      id: randomUUID(),
      op: "describe",
      runtimeScope: "main",
      sessionId: "session-1",
      token: broker.token,
    });
    expect(response).toMatchObject({
      ok: true,
      tools: [{ name: "read_file" }],
    });
    expect(JSON.stringify(response)).not.toContain('"bash"');
  });

  it("invoke 走执行器并回传文本结果信封", async () => {
    const executor = fakeExecutor((call) => ({
      toolCallId: call.id,
      toolName: call.name,
      success: true,
      output: "hello",
    }));
    const port = createNodeReplToolsPort({
      registry: fakeRegistry([fakeEntry("read_file")]),
      executor,
    });
    broker = createNodeReplToolsBroker({ getToolsPort: () => port, logger });
    await broker.ready;

    const response = await exchange(broker.socketPath, {
      id: randomUUID(),
      op: "invoke",
      runtimeScope: "main",
      sessionId: "session-1",
      token: broker.token,
      tool: "read_file",
      arguments: { path: "a.txt" },
    });
    expect(response).toMatchObject({
      ok: true,
      result: { output: "hello", isError: false },
    });
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ name: "read_file", input: { path: "a.txt" } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("invoke 对审批类工具报不可用（策略预批边界）", async () => {
    const port = createNodeReplToolsPort({
      registry: fakeRegistry([fakeEntry("bash", true)]),
      executor: fakeExecutor(() => ({
        toolCallId: "call-1",
        toolName: "bash",
        success: true,
        output: "should not run",
      })),
    });
    broker = createNodeReplToolsBroker({ getToolsPort: () => port, logger });
    await broker.ready;

    const response = await exchange(broker.socketPath, {
      id: randomUUID(),
      op: "invoke",
      runtimeScope: "main",
      sessionId: "session-1",
      token: broker.token,
      tool: "bash",
      arguments: {},
    });
    expect(response).toMatchObject({ ok: false });
    expect(String(response.error)).toContain("not available via codemode");
  });

  it("token 不匹配拒绝", async () => {
    const port = createNodeReplToolsPort({
      registry: fakeRegistry([fakeEntry("read_file")]),
      executor: fakeExecutor(() => ({
        toolCallId: "call-1",
        toolName: "read_file",
        success: true,
        output: "",
      })),
    });
    broker = createNodeReplToolsBroker({ getToolsPort: () => port, logger });
    await broker.ready;

    const response = await exchange(broker.socketPath, {
      id: randomUUID(),
      op: "describe",
      runtimeScope: "main",
      sessionId: "session-1",
      token: "w".repeat(32),
    });
    expect(response).toMatchObject({ ok: false });
    expect(String(response.error)).toContain("not authorized");
  });

  it("subagent scope fail-closed（审计归属保护，CUA 同款先例）", async () => {
    const port = createNodeReplToolsPort({
      registry: fakeRegistry([fakeEntry("read_file")]),
      executor: fakeExecutor(() => ({
        toolCallId: "call-1",
        toolName: "read_file",
        success: true,
        output: "should not run",
      })),
    });
    broker = createNodeReplToolsBroker({ getToolsPort: () => port, logger });
    await broker.ready;

    const response = await exchange(broker.socketPath, {
      id: randomUUID(),
      op: "invoke",
      runtimeScope: "subagent",
      sessionId: "session-1",
      token: broker.token,
      tool: "read_file",
      arguments: {},
    });
    expect(response).toMatchObject({ ok: false });
    expect(String(response.error)).toContain("not available in subagent");
  });

  it("Port 未绑定时报明确错误（runtime 尚未装配）", async () => {
    broker = createNodeReplToolsBroker({ getToolsPort: () => undefined, logger });
    await broker.ready;

    const response = await exchange(broker.socketPath, {
      id: randomUUID(),
      op: "describe",
      runtimeScope: "main",
      sessionId: "session-1",
      token: broker.token,
    });
    expect(response).toMatchObject({ ok: false });
    expect(String(response.error)).toContain("not bound to a runtime yet");
  });
});
