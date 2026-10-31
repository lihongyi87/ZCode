import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { NodeReplRequestMeta, NodeReplSession } from "@zcode/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const NODE_REPL_CUA_BRIDGE_SYMBOL = Symbol.for("zcode.node-repl.computer-use-bridge");
export const CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Computer Use is not available in subagent";

// 方案 (a)：bridge 不可用时**停下并如实报告**，严禁自愈式安装。实测原文案（仅陈述「不可用」）
// 会被模型当成「环境缺依赖」，于是自行 npm install 猜包名（附图那次连猜两个不存在的包名）。
// 文案必须同时给「谁来做」（用户在设置里开启）与「不要做什么」（装包/换驱动）。
export const CUA_UNAVAILABLE_IN_SESSION_MESSAGE =
  "Computer Use is unavailable for this node_repl session: the runtime is provided by the " +
  "host and is not enabled for this client. Do not install, upgrade or guess a driver " +
  "package. Tell the user to enable Computer Use in Settings → Computer Use, then stop.";
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface ActiveCuaNodeReplCall {
  generation: number;
  requestMeta: NodeReplRequestMeta;
  signal: AbortSignal;
}

/** Worker 连 CUA broker 用的地址和本次调用的 token（由主线程账本签发）。 */
export interface NodeReplCuaBrokerConnection {
  socketPath: string;
  token: string;
}

export interface ComputerUseRuntimeBridge {
  /** 私有 capability 请求；这里不是 MCP tool 调用，MCP 只承载外层 node_repl。 */
  call(method: string, input: unknown): Promise<CallToolResult>;
  assertAvailable(): void;
  documentationRoot: string;
}

export function createComputerUseBridgeGlobals(input: {
  broker?: NodeReplCuaBrokerConnection;
  generation: number;
  getActiveCall: () => ActiveCuaNodeReplCall | undefined;
  session: () => NodeReplSession;
  documentationRoot: string;
}): Record<PropertyKey, unknown> {
  const assertActive = (): ActiveCuaNodeReplCall => {
    const active = input.getActiveCall();
    if (!active || active.generation !== input.generation) {
      throw new Error("Computer Use runtime binding is stale after kernel reset");
    }
    return active;
  };
  const assertAvailable = (): ActiveCuaNodeReplCall => {
    const active = assertActive();
    if (active.requestMeta.runtime_scope === "subagent") {
      throw new Error(CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE);
    }
    if (!input.broker) {
      // 方案 (a)：bridge 不可用即停下，明确禁止自愈式安装。原文案只陈述「不可用」，
      // 实测模型会据此自行 npm install 猜包名（附图那次连猜两个不存在的包名）。
      throw new Error(CUA_UNAVAILABLE_IN_SESSION_MESSAGE);
    }
    return active;
  };

  const bridge: ComputerUseRuntimeBridge = {
    documentationRoot: input.documentationRoot,
    assertAvailable: () => {
      assertAvailable();
    },
    call: async (method, methodInput) => {
      const active = assertAvailable();
      // 只发方法与参数：会话信息由主线程 broker 按本次调用的账本条目构造，目标应用身份也由 broker
      // 记进账本（20-node-repl-call-ledger.md「CUA broker」）。修复原因（MR !3207 评审 CR-01）：原来
      // 身份在这里记进 Worker 的运行状态，cell 能经 worker_threads 冒充 Worker 的结果消息伪造它。
      const result = await sendCuaBrokerRequest(
        input.broker!,
        { method, input: methodInput },
        active.signal,
      );
      assertActive();
      if (result.responseMeta) input.session().mergeResponseMeta(result.responseMeta);
      return result.result;
    },
  };

  return { [NODE_REPL_CUA_BRIDGE_SYMBOL]: bridge };
}

async function sendCuaBrokerRequest(
  broker: NodeReplCuaBrokerConnection,
  request: { method: string; input: unknown },
  signal: AbortSignal,
): Promise<{ result: CallToolResult; responseMeta?: Record<string, unknown> }> {
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    const socket = createConnection(broker.socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error?: unknown, value?: { result: CallToolResult; responseMeta?: Record<string, unknown> }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("Computer Use broker returned no response"));
    };
    const onAbort = () => finish(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, token: broker.token, ...request })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
        finish(new Error("Computer Use broker response exceeded the 32 MiB limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const payload = JSON.parse(buffer.slice(0, newline)) as {
          id?: unknown;
          ok?: unknown;
          error?: unknown;
          result?: CallToolResult;
          responseMeta?: Record<string, unknown>;
        };
        if (payload.id !== id) throw new Error("Computer Use broker response id mismatch");
        if (payload.ok !== true) throw new Error(typeof payload.error === "string" ? payload.error : "Computer Use broker failed");
        if (!payload.result) throw new Error("Computer Use broker returned no result");
        finish(undefined, { result: payload.result, responseMeta: payload.responseMeta });
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", finish);
    socket.once("close", () => {
      if (!settled) finish(new Error("Computer Use broker closed before returning a response"));
    });
    if (signal.aborted) onAbort();
  });
}
