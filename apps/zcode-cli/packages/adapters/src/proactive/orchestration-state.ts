import { randomUUID } from "node:crypto";
import {
  SESSION_ENTRY_ORCHESTRATION_STATE,
  type ProactiveEventType,
  type ProactiveOrchestrationState,
  type ProactiveSubscription,
} from "@zcode/contracts";

/**
 * spec 154：会话编排状态的读写（`session_entry(type = "orchestration state")`）。
 *
 * 状态只有一个所有者——本模块。订阅的增删都必须经过这里，因为 generation 的递增
 * 是「旧 trigger 失效」的唯一依据：如果调用方直接改 JSON，generation 不会变，
 * 旧 generation 的待派发 trigger 就会被错误投递。
 */

export interface OrchestrationStateReader {
  sessionEntries(input: {
    sessionID: string;
    type?: string;
  }): Promise<{ type: string; data?: unknown }[]>;
  saveSessionEntry(input: {
    id: string;
    sessionID: string;
    type: string;
    data?: unknown;
    time: { created: number; updated: number };
  }): Promise<void>;
}

interface StoredEntry {
  type: string;
  data?: unknown;
}

const VALID_EVENT_TYPES = new Set<ProactiveEventType>([
  "mailbox_message",
  "automation_due",
  "task_completed",
  "task_failed",
]);

/**
 * 读取会话的编排状态。缺失或损坏时返回 null（视为未声明订阅）。
 *
 * 损坏不抛错是刻意的：一个会话的坏数据不能阻断派发循环，否则整个工作区的
 * 主动编排都会停摆。
 */
export async function readOrchestrationState(
  reader: OrchestrationStateReader,
  sessionId: string,
): Promise<{
  subscriptions: readonly ProactiveSubscription[];
  generation: number;
  status: "running" | "paused";
} | null> {
  const entries = await reader.sessionEntries({
    sessionID: sessionId,
    type: SESSION_ENTRY_ORCHESTRATION_STATE,
  });
  const entry = entries.at(-1) as StoredEntry | undefined;
  if (!entry) return null;

  const state = extractProactiveState(entry.data);
  if (!state) return null;
  return {
    subscriptions: state.proactive?.subscriptions ?? [],
    generation: state.proactive?.generation ?? 0,
    status: state.proactive?.status ?? "paused",
  };
}

/** 写入订阅集合（generation 自动递增）。返回新的 generation。 */
export async function writeSubscriptions(
  reader: OrchestrationStateReader,
  input: {
    sessionId: string;
    subscriptions: readonly ProactiveSubscription[];
    status?: "running" | "paused";
    now: number;
  },
): Promise<number> {
  const existing = await readOrchestrationState(reader, input.sessionId);
  const generation = (existing?.generation ?? 0) + 1;
  const next: ProactiveOrchestrationState = {
    proactive: {
      // 缺省 running：声明订阅即生效（与 ProactiveSubscribe 工具的缺省一致；
      // 曾在这里缺省 paused，端到端测试抓到「写入后永远不派发」的分叉）。
      status: input.status ?? existing?.status ?? "running",
      subscriptions: input.subscriptions,
      generation,
    },
  };
  await reader.saveSessionEntry({
    id: orchestrationEntryId(input.sessionId),
    sessionID: input.sessionId,
    type: SESSION_ENTRY_ORCHESTRATION_STATE,
    data: next,
    time: { created: input.now, updated: input.now },
  });
  return generation;
}

/** 校验并规范化一条订阅输入；非法返回错误消息字符串。 */
export function normalizeSubscriptionInput(input: {
  id?: string;
  event: string;
  sourceId: string;
  prompt: string;
}):
  | { ok: true; subscription: ProactiveSubscription }
  | { ok: false; error: string } {
  if (!VALID_EVENT_TYPES.has(input.event as ProactiveEventType)) {
    return { ok: false, error: `unsupported event type: ${input.event}` };
  }
  if (input.sourceId.trim().length === 0) {
    return { ok: false, error: "sourceId is required" };
  }
  if (input.prompt.trim().length === 0) {
    return { ok: false, error: "prompt is required" };
  }
  return {
    ok: true,
    subscription: {
      id: input.id ?? `sub_${randomUUID()}`,
      event: input.event as ProactiveEventType,
      sourceId: input.sourceId as ProactiveSubscription["sourceId"],
      prompt: input.prompt,
    },
  };
}

/** 编排状态的 session_entry id：每个会话固定一条（upsert 语义）。 */
function orchestrationEntryId(sessionId: string): string {
  return `orchestration:${sessionId}`;
}

function extractProactiveState(data: unknown): ProactiveOrchestrationState | null {
  if (typeof data !== "object" || data === null) return null;
  const proactive = (data as ProactiveOrchestrationState).proactive;
  if (typeof proactive !== "object" || proactive === null) return null;
  if (proactive.status !== "running" && proactive.status !== "paused") return null;
  if (!Number.isInteger(proactive.generation) || proactive.generation < 0) return null;
  if (!Array.isArray(proactive.subscriptions)) return null;
  // 逐条校验：坏订阅被丢弃而不是整条状态作废——一个坏订阅不该让其余订阅失效。
  const subscriptions = proactive.subscriptions.filter(
    (candidate): candidate is ProactiveSubscription =>
      typeof candidate === "object" &&
      candidate !== null &&
      typeof candidate.id === "string" &&
      VALID_EVENT_TYPES.has(candidate.event) &&
      typeof candidate.sourceId === "string" &&
      typeof candidate.prompt === "string",
  );
  return {
    proactive: { status: proactive.status, subscriptions, generation: proactive.generation },
  };
}
