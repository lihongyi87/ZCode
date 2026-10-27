import { describe, expect, it } from "vitest";
import type { NodeReplRequestMeta } from "@zcode/core/repl";
import {
  createToolsBridgeGlobals,
  type ActiveNodeReplCall,
  type ToolsBrokerTransport,
} from "../src/tools-bridge.js";

const requestMeta = {
  session_id: "sess_test",
  runtime_scope: "main",
} as NodeReplRequestMeta;

type BrokerResponse = Awaited<ReturnType<ToolsBrokerTransport>>;

function activeCall(generation = 1): ActiveNodeReplCall {
  return { generation, requestMeta, signal: new AbortController().signal };
}

function fakeTransport(
  respond: (request: Record<string, unknown>) => BrokerResponse,
): { transport: ToolsBrokerTransport; seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  const transport: ToolsBrokerTransport = async (request) => {
    seen.push(request);
    return respond(request);
  };
  return { transport, seen };
}

const ENV = {
  ZCODE_NODE_REPL_TOOLS_BROKER_SOCKET: "\\\\.\\pipe\\zcode-tools-test",
  ZCODE_NODE_REPL_TOOLS_BROKER_TOKEN: "t".repeat(32),
};

describe("createToolsBridgeGlobals", () => {
  it("broker env 缺失时 assertAvailable 抛明确不可用", () => {
    const globals = createToolsBridgeGlobals({
      generation: 1,
      getActiveCall: () => activeCall(),
      env: {},
    });
    const codemode = globals.codemode as { assertAvailable(): void };
    expect(() => codemode.assertAvailable()).toThrow(
      /Codemode is unavailable for this node_repl session/,
    );
  });

  it("describe 路由 op=describe 并携带 session 上下文", async () => {
    const { transport, seen } = fakeTransport(() => ({
      id: "00000000-0000-4000-8000-000000000000",
      ok: true,
      tools: [{ name: "read_file", description: "读文件" }],
    }));
    const globals = createToolsBridgeGlobals({
      generation: 1,
      getActiveCall: () => activeCall(),
      env: ENV,
      sendRequest: transport,
    });
    const codemode = globals.codemode as {
      describe(): Promise<{ name: string }[]>;
    };
    const tools = await codemode.describe();
    expect(tools.map((t) => t.name)).toEqual(["read_file"]);
    expect(seen[0]).toMatchObject({
      op: "describe",
      sessionId: "sess_test",
      runtimeScope: "main",
    });
  });

  it("invoke 路由工具名与参数，返回结果信封", async () => {
    const { transport, seen } = fakeTransport(() => ({
      id: "00000000-0000-4000-8000-000000000001",
      ok: true,
      result: { output: "hello", isError: false },
    }));
    const globals = createToolsBridgeGlobals({
      generation: 1,
      getActiveCall: () => activeCall(),
      env: ENV,
      sendRequest: transport,
    });
    const codemode = globals.codemode as {
      invoke(
        tool: string,
        args: Record<string, unknown>,
      ): Promise<{ output: string; isError: boolean }>;
    };
    const result = await codemode.invoke("read_file", { path: "a.txt" });
    expect(result).toEqual({ output: "hello", isError: false });
    expect(seen[0]).toMatchObject({
      op: "invoke",
      tool: "read_file",
      arguments: { path: "a.txt" },
    });
  });

  it("declarations 渲染速查并对超预算工具附省略提示", async () => {
    const { transport } = fakeTransport(() => ({
      id: "00000000-0000-4000-8000-000000000002",
      ok: true,
      tools: [
        { name: "read_file", description: "读文件", inputSchema: { type: "object" } },
        { name: "huge", description: "x".repeat(8_000) },
      ],
    }));
    const globals = createToolsBridgeGlobals({
      generation: 1,
      getActiveCall: () => activeCall(),
      env: ENV,
      inlineBudgetTokens: 120,
      sendRequest: transport,
    });
    const codemode = globals.codemode as { declarations(): Promise<string> };
    const declarations = await codemode.declarations();
    expect(declarations).toContain("declare function read_file(");
    expect(declarations).not.toContain("huge(");
    expect(declarations).toContain("codemode.describe()");
  });

  it("generation 过期后调用报 stale 错误", () => {
    const globals = createToolsBridgeGlobals({
      generation: 2,
      getActiveCall: () => activeCall(1),
      env: ENV,
    });
    const codemode = globals.codemode as { assertAvailable(): void };
    expect(() => codemode.assertAvailable()).toThrow(/stale after kernel reset/);
  });
});
