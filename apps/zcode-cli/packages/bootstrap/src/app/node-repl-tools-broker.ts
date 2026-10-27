import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, McpServerConfig } from "@zcode/contracts";
import {
  NODE_REPL_TOOLS_BROKER_SOCKET_ENV,
  NODE_REPL_TOOLS_BROKER_TOKEN_ENV,
  nodeReplToolsBrokerRequestSchema,
  type NodeReplToolsBrokerRequest,
  type NodeReplToolsBrokerResponse,
  type NodeReplToolDescriptor,
  type NodeReplToolInvokeResult,
} from "@zcode/shared";
import type { NodeReplToolsPort } from "./node-repl-tools-port.js";

const NODE_REPL_MCP_SERVER_NAME = "node_repl";
const MAX_REQUEST_BYTES = 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface NodeReplToolsBroker {
  close(): Promise<void>;
  ready: Promise<void>;
  socketPath: string;
  token: string;
}

/**
 * Codemode tools broker（spec 158）：把 agent 进程的策略预批工具面经本地 socket
 * 暴露给 node_repl Worker 的 `codemode` 全局。协议与生命周期镜像
 * node-repl-browser-broker.ts；Port 用 getter 惰性取用——broker 必须先于 runtime
 * 创建（env 注入在 config 解析期），而 Port 依赖其后装配好的 ToolRegistry/Executor
 * （create-app.ts 前向引用，同 node.ts 的 hasActiveTurnRef 模式）。
 */
export function createNodeReplToolsBroker(input: {
  getToolsPort: () => NodeReplToolsPort | undefined;
  logger: Logger;
  platform?: NodeJS.Platform | string;
}): NodeReplToolsBroker {
  const socketPath = createSocketPath(input.platform ?? process.platform);
  const token = randomBytes(32).toString("hex");
  const server = createServer((socket) => {
    handleSocket(socket, { ...input, token }).catch((error) => {
      input.logger.warn("Node REPL tools broker request failed", {
        event: "node_repl.tools_broker.request.failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  server.on("error", (error) => {
    input.logger.error("Node REPL tools broker failed", error, {
      event: "node_repl.tools_broker.failed",
    });
  });
  server.listen(socketPath);
  server.unref();
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  return {
    ready,
    socketPath,
    token,
    close: async () => {
      // 与 browser broker 同一极短生命周期边界：close 可能先于 listen 回调，
      // 直接检查 server.listening 会漏关随后才绑定成功的 socket。
      await ready.catch(() => undefined);
      await closeServer(server);
      if ((input.platform ?? process.platform) !== "win32") {
        await rm(socketPath, { force: true });
      }
    },
  };
}

export function injectNodeReplToolsBroker(
  servers: Record<string, McpServerConfig>,
  broker: NodeReplToolsBroker | undefined,
): Record<string, McpServerConfig> {
  if (!broker) return servers;
  const nodeRepl = servers[NODE_REPL_MCP_SERVER_NAME];
  if (!nodeRepl || nodeRepl.type !== "stdio") return servers;
  return {
    ...servers,
    [NODE_REPL_MCP_SERVER_NAME]: {
      ...nodeRepl,
      env: {
        ...nodeRepl.env,
        [NODE_REPL_TOOLS_BROKER_SOCKET_ENV]: broker.socketPath,
        [NODE_REPL_TOOLS_BROKER_TOKEN_ENV]: broker.token,
      },
    },
  };
}

function createSocketPath(platform: NodeJS.Platform | string): string {
  const id = randomUUID();
  return platform === "win32"
    ? `\\\\.\\pipe\\zcode-node-repl-tools-${id}`
    : join(tmpdir(), `znrt-${id}.sock`);
}

async function handleSocket(
  socket: Socket,
  input: {
    getToolsPort: () => NodeReplToolsPort | undefined;
    logger: Logger;
    token: string;
  },
): Promise<void> {
  const abortController = new AbortController();
  let completed = false;
  let requestId = randomUUID();
  // 对端断开（steer 取消后 socket.destroy）收敛为「取消当前请求」而非进程级错误，
  // 与 browser broker 的 EPIPE 教训同一处置（见其 handleSocket 注释）。
  socket.on("error", (error) => {
    if (!completed) abortController.abort();
    input.logger.debug("Node REPL tools broker connection dropped", {
      event: "node_repl.tools_broker.connection.dropped",
      error: error.message,
    });
  });
  socket.once("close", () => {
    if (!completed) abortController.abort();
  });
  try {
    const raw = await readLine(socket, abortController.signal);
    const payload = JSON.parse(raw) as unknown;
    requestId = requestIdFromPayload(payload) ?? requestId;
    const request = nodeReplToolsBrokerRequestSchema.parse(payload);
    requestId = request.id as ReturnType<typeof randomUUID>;
    authorizeRequest(request, input);
    const toolsPort = input.getToolsPort();
    if (!toolsPort) {
      throw new Error("Node REPL tools broker port is not bound to a runtime yet");
    }
    const response = await executeRequest(request, toolsPort, abortController.signal);
    completed = true;
    respond(socket, response);
  } catch (error) {
    completed = true;
    respond(socket, {
      id: requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function requestIdFromPayload(payload: unknown): ReturnType<typeof randomUUID> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" && UUID_PATTERN.test(id)
    ? (id as ReturnType<typeof randomUUID>)
    : undefined;
}

function respond(socket: Socket, response: NodeReplToolsBrokerResponse): void {
  if (!socket.writable) return;
  socket.end(`${JSON.stringify(response)}\n`);
}

function authorizeRequest(request: NodeReplToolsBrokerRequest, input: { token: string }): void {
  const actual = Buffer.from(request.token);
  const expected = Buffer.from(input.token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Node REPL tools broker request is not authorized");
  }
  // token 先证明请求来自宿主启动的 node_repl；工具面本身是策略预批的
  // （needsApproval 工具不在 describe/invoke 两端出现），subagent scope 由
  // Port 侧按 runtimeScope 决定是否收紧，不在此处重复裁决。
}

async function executeRequest(
  request: NodeReplToolsBrokerRequest,
  toolsPort: NodeReplToolsPort,
  signal: AbortSignal,
): Promise<NodeReplToolsBrokerResponse> {
  if (request.op === "describe") {
    const tools: NodeReplToolDescriptor[] = toolsPort.describe();
    return { id: request.id, ok: true, tools };
  }
  const result: NodeReplToolInvokeResult = await toolsPort.invoke({
    tool: request.tool,
    arguments: request.arguments,
    signal,
  });
  return { id: request.id, ok: true, result };
}

async function readLine(socket: Socket, signal: AbortSignal): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        cleanup();
        reject(new Error("Node REPL tools broker request exceeded 1 MiB"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffer.slice(0, newline));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
