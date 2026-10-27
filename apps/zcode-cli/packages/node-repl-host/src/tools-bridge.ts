import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { NodeReplRequestMeta } from "@zcode/core/repl";
// 只加载 broker 协议；shared 总入口会在每个 Worker 中初始化无关领域的 schema（同 browser-bridge）。
import {
  NODE_REPL_TOOLS_BROKER_SOCKET_ENV,
  NODE_REPL_TOOLS_BROKER_TOKEN_ENV,
  nodeReplToolsBrokerResponseSchema,
  type NodeReplToolDescriptor,
  type NodeReplToolInvokeResult,
} from "@zcode/shared/node-repl-tools-broker";
import { renderCodemodeToolDeclarations } from "./tools-bindings.js";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
// spec 158：inlineBudget 默认 3000 tokens；env 覆盖给测试与高级用户。
const DEFAULT_INLINE_BUDGET_TOKENS = 3_000;

type BrokerResponse = ReturnType<typeof nodeReplToolsBrokerResponseSchema.parse>;
type SuccessfulBrokerResponse = Extract<BrokerResponse, { ok: true }>;

export interface ActiveNodeReplCall {
  generation: number;
  requestMeta: NodeReplRequestMeta;
  signal: AbortSignal;
}

export interface ToolsBrokerTransport {
  (request: Record<string, unknown>, signal: AbortSignal): Promise<SuccessfulBrokerResponse>;
}

export interface CodemodeFacade {
  describe(): Promise<NodeReplToolDescriptor[]>;
  invoke(tool: string, args: Record<string, unknown>): Promise<NodeReplToolInvokeResult>;
  declarations(): Promise<string>;
  assertAvailable(): void;
}

export function createToolsBridgeGlobals(input: {
  generation: number;
  getActiveCall: () => ActiveNodeReplCall | undefined;
  inlineBudgetTokens?: number;
  env?: NodeJS.ProcessEnv;
  sendRequest?: ToolsBrokerTransport;
}): Record<PropertyKey, unknown> {
  const assertActive = (): ActiveNodeReplCall => {
    const active = input.getActiveCall();
    if (!active || active.generation !== input.generation) {
      throw new Error("Codemode binding is stale after kernel reset");
    }
    return active;
  };
  const send = input.sendRequest ?? defaultSendRequest;
  const env = input.env ?? process.env;

  const assertAvailable = (): void => {
    assertActive();
    if (
      !env[NODE_REPL_TOOLS_BROKER_SOCKET_ENV]?.trim() ||
      !env[NODE_REPL_TOOLS_BROKER_TOKEN_ENV]?.trim()
    ) {
      throw new Error(
        "Codemode is unavailable for this node_repl session: the tools broker is not attached. " +
          "Use the native tool surface instead.",
      );
    }
  };

  const facade: CodemodeFacade = {
    assertAvailable,
    describe: async () => {
      const active = assertActive();
      const response = await send(
        { op: "describe", ...requestContext(active.requestMeta) },
        active.signal,
      );
      assertActive();
      return response.tools ?? [];
    },
    invoke: async (tool, args) => {
      const active = assertActive();
      if (typeof tool !== "string" || !tool.trim()) {
        throw new Error("codemode.invoke requires a non-empty tool name");
      }
      const response = await send(
        {
          op: "invoke",
          tool,
          arguments: args ?? {},
          ...requestContext(active.requestMeta),
        },
        active.signal,
      );
      assertActive();
      if (!response.result) throw new Error("Tools broker returned no result");
      return response.result;
    },
    declarations: async () => {
      const descriptors = await facade.describe();
      const budget = Number.parseInt(
        env.ZCODE_NODE_REPL_TOOLS_INLINE_BUDGET?.trim() || "",
        10,
      );
      const rendered = renderCodemodeToolDeclarations(
        descriptors,
        Number.isFinite(budget) && budget > 0
          ? budget
          : (input.inlineBudgetTokens ?? DEFAULT_INLINE_BUDGET_TOKENS),
      );
      const omittedNote = rendered.omitted.length
        ? `\n// 另有 ${rendered.omitted.length} 个工具超出速查预算，用 codemode.describe() 按需发现。`
        : "";
      return (
        "// 策略预批工具面：通过 codemode.invoke(\"<工具名>\", args) 调用；调用走与原生工具相同的审批闸。\n" +
        rendered.declarations +
        omittedNote
      );
    },
  };

  return { codemode: facade };
}

function requestContext(meta: NodeReplRequestMeta): Record<string, unknown> {
  const sessionId = meta.session_id;
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new Error("node_repl codemode request is missing session_id metadata");
  }
  return {
    runtimeScope: meta.runtime_scope === "subagent" ? "subagent" : "main",
    sessionId,
    ...(typeof meta.turn_id === "string" && meta.turn_id.trim()
      ? { turnId: meta.turn_id.trim() }
      : {}),
  };
}

function defaultSendRequest(
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<SuccessfulBrokerResponse> {
  const socketPath = process.env[NODE_REPL_TOOLS_BROKER_SOCKET_ENV]?.trim();
  const token = process.env[NODE_REPL_TOOLS_BROKER_TOKEN_ENV]?.trim();
  if (!socketPath || !token) {
    throw new Error("Codemode is unavailable for this node_repl session");
  }
  const id = randomUUID();
  return new Promise<SuccessfulBrokerResponse>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const socket = createConnection(socketPath);
    const finish = (error?: unknown, value?: SuccessfulBrokerResponse) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("Tools broker returned no response"));
    };
    const onAbort = () => finish(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, token, ...request })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
        finish(new Error("Tools broker response exceeded the 32 MiB limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = nodeReplToolsBrokerResponseSchema.parse(
          JSON.parse(buffer.slice(0, newline)) as unknown,
        );
        if (parsed.id !== id) throw new Error("Tools broker response id mismatch");
        if (!parsed.ok) throw new Error(parsed.error);
        finish(undefined, parsed);
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", finish);
    socket.once("close", () => {
      if (!settled) finish(new Error("Tools broker closed before returning a response"));
    });
    if (signal.aborted) onAbort();
  });
}
