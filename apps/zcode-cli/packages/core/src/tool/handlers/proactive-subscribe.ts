import {
  CoreErrorType,
  PROACTIVE_SUBSCRIBE_TOOL_NAME,
  ProactiveSubscribeInputJsonSchema,
  ProactiveSubscribeInputSchema,
  ProactiveSubscribeOutputSchema,
  SESSION_ENTRY_ORCHESTRATION_STATE,
  createCoreError,
  type ProactiveSubscribeInput,
  type ProactiveSubscribeOutput,
  type SessionEntryInfo,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

/**
 * spec 154：订阅式主动编排的声明入口。
 *
 * 工具写「当前会话」的 session_entry(orchestration state)：订阅集合整体替换，
 * generation 递增使旧 generation 的待派发 trigger 失效（写路径在 adapters 的
 * writeSubscriptions；这里只做校验与落盘，不重复实现 generation 语义）。
 *
 * 唤醒链的其余部分由宿主调度器承担（env 开启时才存在）；未开启的环境里
 * 订阅仍可写入（用户先声明、宿主后开启），不因功能关闭而报错。
 */

const MAX_PROACTIVE_SUBSCRIBE_MODEL_BYTES = 4096;

const PROACTIVE_SUBSCRIBE_PROVIDER_DESCRIPTION = [
  "# ProactiveSubscribe",
  "",
  "Declare this session's proactive wake-up subscriptions for multi-session handoffs.",
  "",
  "```json",
  '{"subscriptions": [{"event": "mailbox_message", "sourceId": "sess_xxx", "prompt": "The upstream task finished; continue with the integration work."}]}',
  "```",
  "",
  "Each subscription means: when `sourceId` fires `event`, inject `prompt` into THIS session and continue automatically — no human prompt needed.",
  "Use after coordinating with another session (SendMessage): subscribe so the handoff continues when the reply arrives.",
  "`subscriptions` replaces the whole set (pass [] to clear). `status: \"paused\"` keeps subscriptions but stops wake-ups.",
  "Requires the host to have proactive orchestration enabled; otherwise subscriptions are stored but dormant.",
].join("\n");

const PROACTIVE_SUBSCRIBE_TOOL_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    status: { type: "string", enum: ["success", "failed"] },
    generation: { type: "number" },
    subscriptionCount: { type: "number" },
    error: { type: "string" },
    message: { type: "string" },
  },
  required: ["status"],
  additionalProperties: false,
};

const proactiveSubscribeHandler: ToolHandler = async (input, context) => {
  const parsed = ProactiveSubscribeInputSchema.parse(input) as ProactiveSubscribeInput;

  const sessionStore = context.sessionStore;
  if (!sessionStore?.saveSessionEntry || !sessionStore?.sessionEntries) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Session store is not configured for ProactiveSubscribe",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: PROACTIVE_SUBSCRIBE_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const now = Date.now();
  // 读取现有编排状态：generation 递增 + 保留既有订阅（仅暂停/恢复时）。
  const entries = (await sessionStore.sessionEntries({
    sessionID: context.sessionId,
    type: SESSION_ENTRY_ORCHESTRATION_STATE,
  })) as SessionEntryInfo[];
  const previous = extractState(entries.at(-1)?.data);
  const previousState = previous?.proactive;

  const nextStatus = parsed.status ?? "running";
  // subscriptions 缺席 = 保留现有集合（只切换 status）；在场 = 整体替换。
  const nextSubscriptions =
    parsed.subscriptions === undefined
      ? (previousState?.subscriptions ?? [])
      : parsed.subscriptions.map((subscription, index) => ({
          id: `sub_${context.toolCallId}_${index}`,
          event: subscription.event,
          sourceId: subscription.sourceId,
          prompt: subscription.prompt,
        }));

  const generation = (previousState?.generation ?? 0) + 1;
  await sessionStore.saveSessionEntry({
    id: `orchestration:${context.sessionId}`,
    sessionID: context.sessionId,
    type: SESSION_ENTRY_ORCHESTRATION_STATE,
    data: {
      proactive: {
        status: nextStatus,
        subscriptions: nextSubscriptions,
        generation,
      },
    },
    time: { created: now, updated: now },
  });

  const output: ProactiveSubscribeOutput = {
    status: "success",
    generation,
    subscriptionCount: nextSubscriptions.length,
    ...(nextStatus === "paused" ? { message: "subscriptions kept; wake-ups paused" } : {}),
  };
  return output;
};

export const proactiveSubscribeToolEntry: ToolEntry = {
  capability: "Declare proactive wake-up subscriptions for multi-session handoffs",
  metadata: {
    shouldDefer: false,
    name: PROACTIVE_SUBSCRIBE_TOOL_NAME,
    searchHint: "proactive subscriptions multi-session handoff wake",
    description: PROACTIVE_SUBSCRIBE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 10_000,
    maxOutputBytes: MAX_PROACTIVE_SUBSCRIBE_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: proactiveSubscribeHandler,
  inputSchema: ProactiveSubscribeInputJsonSchema,
  outputSchema: PROACTIVE_SUBSCRIBE_TOOL_OUTPUT_SCHEMA,
  runtimeInputSchema: ProactiveSubscribeInputSchema,
  runtimeOutputSchema: ProactiveSubscribeOutputSchema,
  permission: {
    permission: "proactive.subscribe",
    reason: "ProactiveSubscribe rewrites this session's orchestration state",
    riskLevel: "medium",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_PROACTIVE_SUBSCRIBE_MODEL_BYTES,
    maxModelBytes: MAX_PROACTIVE_SUBSCRIBE_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_PROACTIVE_SUBSCRIBE_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: 10_000,
    maxMs: 10_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ProactiveSubscribe was cancelled before the subscription was stored",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

interface StoredSubscription {
  id: string;
  event: string;
  sourceId: string;
  prompt: string;
}

interface ProactiveStateShape {
  proactive?: {
    status?: "running" | "paused";
    subscriptions?: StoredSubscription[];
    generation?: number;
  };
}

function isStoredSubscription(value: unknown): value is StoredSubscription {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.event === "string" &&
    typeof candidate.sourceId === "string" &&
    typeof candidate.prompt === "string"
  );
}

/** 保守解析编排状态：只提取形状合法的字段，坏数据按缺失处理。 */
function extractState(data: unknown): ProactiveStateShape | null {
  if (typeof data !== "object" || data === null) return null;
  const proactive = (data as { proactive?: unknown }).proactive;
  if (typeof proactive !== "object" || proactive === null) return null;
  const candidate = proactive as {
    status?: unknown;
    subscriptions?: unknown;
    generation?: unknown;
  };
  return {
    proactive: {
      ...(candidate.status === "running" || candidate.status === "paused"
        ? { status: candidate.status }
        : {}),
      subscriptions: Array.isArray(candidate.subscriptions)
        ? candidate.subscriptions.filter(isStoredSubscription)
        : [],
      ...(typeof candidate.generation === "number" && Number.isInteger(candidate.generation)
        ? { generation: candidate.generation }
        : {}),
    },
  };
}
