import { z } from "zod";

// Codemode tools 桥（spec 158）：node_repl Worker 经本地 socket 以「描述 + 调用」两个
// 操作访问 agent 进程的策略预批工具面。协议形状与 browser-use/nodeReplBroker.ts 同构——
// newline 分帧 JSON、uuid id 回显、token 认证、runtimeScope 区分主/子代理。
export const NODE_REPL_TOOLS_BROKER_SOCKET_ENV = "ZCODE_NODE_REPL_TOOLS_BROKER_SOCKET";
export const NODE_REPL_TOOLS_BROKER_TOKEN_ENV = "ZCODE_NODE_REPL_TOOLS_BROKER_TOKEN";

// 策略预批（spec 158 方案 1）：只有无需审批的工具进入 codemode 暴露面；needsApproval
// 工具在 describe/invoke 两端都拒绝，审批语义不进脚本路径。invoke 结果 MVP 走文本口径
// （工具结果的文本渲染），富媒体结果在原生工具路径照常走，不经脚本桥。
export const nodeReplToolDescriptorSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type NodeReplToolDescriptor = z.infer<typeof nodeReplToolDescriptorSchema>;

const requestBase = z.object({
  id: z.string().uuid(),
  runtimeScope: z.enum(["main", "subagent"]),
  token: z.string().min(32),
  sessionId: z.string().trim().min(1),
  turnId: z.string().trim().min(1).optional(),
  trace: z
    .object({
      traceId: z.string().trim().min(1),
      spanId: z.string().trim().min(1).optional(),
      parentSpanId: z.string().trim().min(1).optional(),
    })
    .strict()
    .optional(),
});

export const nodeReplToolsBrokerRequestSchema = z.discriminatedUnion("op", [
  requestBase.extend({ op: z.literal("describe") }).strict(),
  requestBase
    .extend({
      op: z.literal("invoke"),
      tool: z.string().trim().min(1),
      arguments: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);
export type NodeReplToolsBrokerRequest = z.infer<typeof nodeReplToolsBrokerRequestSchema>;

export const nodeReplToolInvokeResultSchema = z
  .object({
    output: z.string(),
    isError: z.boolean(),
  })
  .strict();
export type NodeReplToolInvokeResult = z.infer<typeof nodeReplToolInvokeResultSchema>;

export const nodeReplToolsBrokerResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      id: z.string().uuid(),
      ok: z.literal(true),
      tools: z.array(nodeReplToolDescriptorSchema).optional(),
      result: nodeReplToolInvokeResultSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      ok: z.literal(false),
      error: z.string().min(1),
    })
    .strict(),
]);
export type NodeReplToolsBrokerResponse = z.infer<typeof nodeReplToolsBrokerResponseSchema>;
