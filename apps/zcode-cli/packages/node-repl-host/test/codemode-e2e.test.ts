import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInProcessNodeReplExecutor,
  createNodeReplMcpRuntime,
  type NodeReplMcpRuntime,
} from "../src/server.js";
import { nodeReplToolsBrokerRequestSchema } from "@zcode/shared/node-repl-tools-broker";

const TOOLS = [
  {
    name: "read_file",
    description: "读文件",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  { name: "web_search", description: "搜索", inputSchema: { type: "object" } },
];

// 真 socket 的最小 broker peer：协议用 shared 的 schema 逐字节解析，行为与 bootstrap
// 的正式 broker 一致（describe/invoke），但工具面是测试固定数据——本测试验证的是
// 「MCP 运行时 → Worker → codemode 桥 → 真 socket」这段链路，broker 本体另有 6 例单测。
function startBrokerPeer(): Promise<{ socketPath: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: NetServer = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = nodeReplToolsBrokerRequestSchema.parse(
          JSON.parse(buffer.slice(0, newline)) as unknown,
        );
        const respond = (payload: Record<string, unknown>) => {
          if (socket.writable) {
            socket.end(`${JSON.stringify({ id: request.id, ...payload })}\n`);
          }
        };
        if (request.op === "describe") {
          respond({ ok: true, tools: TOOLS });
        } else {
          const path = (request.arguments as { path?: unknown }).path;
          respond({
            ok: true,
            result: { output: `echo:${String(path ?? "")}`, isError: false },
          });
        }
      });
    });
    const id = randomUUID();
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\zcode-codemode-e2e-${id}`
        : join(tmpdir(), `zcode-codemode-e2e-${id}.sock`);
    server.listen(socketPath, () =>
      resolve({
        socketPath,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      }),
    );
  });
}

const requestMeta = (sessionId: string) => ({
  "com.zcode/request-context": {
    runtime_scope: "main",
    session_id: sessionId,
    turn_id: "turn-1",
  },
});

describe("codemode end-to-end (real socket + real MCP runtime)", () => {
  let runtime: NodeReplMcpRuntime;
  let client: Client;
  let peer: { socketPath: string; close: () => Promise<void> };
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    peer = await startBrokerPeer();
    saved.socket = process.env.ZCODE_NODE_REPL_TOOLS_BROKER_SOCKET;
    saved.token = process.env.ZCODE_NODE_REPL_TOOLS_BROKER_TOKEN;
    process.env.ZCODE_NODE_REPL_TOOLS_BROKER_SOCKET = peer.socketPath;
    process.env.ZCODE_NODE_REPL_TOOLS_BROKER_TOKEN = "t".repeat(32);
    runtime = createNodeReplMcpRuntime({ executeJs: createInProcessNodeReplExecutor() });
    client = new Client({ name: "codemode-e2e", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await runtime.server.connect(serverTransport);
    await client.connect(clientTransport);
  }, 30_000);

  afterEach(async () => {
    await client.close();
    runtime.dispose();
    await peer.close();
    if (saved.socket === undefined) {
      delete process.env.ZCODE_NODE_REPL_TOOLS_BROKER_SOCKET;
    } else {
      process.env.ZCODE_NODE_REPL_TOOLS_BROKER_SOCKET = saved.socket;
    }
    if (saved.token === undefined) {
      delete process.env.ZCODE_NODE_REPL_TOOLS_BROKER_TOKEN;
    } else {
      process.env.ZCODE_NODE_REPL_TOOLS_BROKER_TOKEN = saved.token;
    }
  });

  it("broker 注入后 js 工具描述携带 codemode 可用性提示", async () => {
    const { tools } = await client.listTools();
    const js = tools.find((tool) => tool.name === "js");
    expect(String(js?.description)).toContain("`codemode` global is available");
    expect(String(js?.description)).toContain("codemode.invoke(name, args)");
  });

  it("脚本经 codemode.invoke 走真 socket 拿到工具输出", async () => {
    const result = await client.callTool({
      name: "js",
      arguments: {
        code: `await codemode.invoke("read_file", { path: "a.txt" })`,
        title: "codemode invoke 端到端",
      },
      _meta: requestMeta("codemode-e2e"),
    });
    const text = (result.content ?? [])
      .map((block) => ("text" in block ? (block as { text: string }).text : ""))
      .join("");
    expect(text).toContain("echo:a.txt");
    expect(text).toContain('"isError": false');
  }, 30_000);

  it("codemode.declarations 渲染策略预批工具的 TS 速查", async () => {
    const result = await client.callTool({
      name: "js",
      arguments: { code: `await codemode.declarations()`, title: "codemode declarations" },
      _meta: requestMeta("codemode-e2e"),
    });
    const text = JSON.stringify(result.content ?? []);
    expect(text).toContain("declare function read_file(");
    expect(text).toContain("declare function web_search(");
  }, 30_000);
});
