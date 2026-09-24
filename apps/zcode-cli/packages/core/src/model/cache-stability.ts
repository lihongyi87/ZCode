import { createHash } from "node:crypto";

/**
 * Provider 请求缓存稳定性检测（cache-stability linter）。
 *
 * 语义：agent 循环的正常增长是「尾部追加」——相邻两次 provider 请求里，
 * 旧请求的全部内容应原样出现在新请求前缀里。任何发生在旧请求**尾部之前**的
 * 变异（system 变了 / 工具表变了 / 第 i 条历史消息变了）都会让上一次写入的
 * prompt cache 前缀作废，等于白写一次缓存。
 *
 * 本模块把这件事变成可观测、可回归的工程对象：
 * - `diffProviderRequests`：纯函数，给出两次请求的分叉报告；
 * - `trackProviderRequestStabilityForRuntime`：运行时接线（按 runtime 实例
 *   维护上一次请求指纹），检测到前缀变异时返回报告，由调用方落日志。
 *
 * 排除项：`cacheControl` 标记本身每轮移动（滚动断点），不参与哈希。
 */

interface MessageLike {
  role?: string;
  content?: unknown;
  cacheControl?: unknown;
}

interface ToolLike {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  parameters?: unknown;
}

interface RequestLike {
  messages?: ReadonlyArray<MessageLike>;
  tools?: ReadonlyArray<ToolLike>;
}

export interface ProviderRequestSections {
  systemDigest: string;
  toolsDigest: string;
  /** 逐条消息哈希（含 role+content，不含 cacheControl）。 */
  messageDigests: string[];
}

export interface CacheStabilityReport {
  /** system 段（全部 system 消息）与上次不同。 */
  systemChanged: boolean;
  /** 工具表（name+description+schema）与上次不同。 */
  toolsChanged: boolean;
  /** 首条发生变异的历史消息下标；纯尾部追加时为 null。 */
  firstMutatedMessageIndex: number | null;
  /** 上一次写缓存的前缀是否被作废（system/工具/尾部之前的消息任一变异）。 */
  mutatedBeforeTail: boolean;
  /** 人类可读的一行结论，直接进日志。 */
  summary: string;
}

/** 稳定序列化：对象键排序后序列，避免键序噪声触发假变异。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

function messageDigest(message: MessageLike): string {
  return digest({ role: message.role, content: message.content });
}

export function sectionizeProviderRequest(request: RequestLike): ProviderRequestSections {
  const messages = request.messages ?? [];
  const systemMessages = messages.filter((m) => m.role === "system");
  return {
    systemDigest: digest(systemMessages.map((m) => m.content)),
    toolsDigest: digest(request.tools ?? []),
    messageDigests: messages.map((m) => messageDigest(m)),
  };
}

export function diffProviderRequests(
  previous: ProviderRequestSections,
  next: ProviderRequestSections,
): CacheStabilityReport {
  const systemChanged = previous.systemDigest !== next.systemDigest;
  const toolsChanged = previous.toolsDigest !== next.toolsDigest;

  const previousDigests = previous.messageDigests;
  let firstMutatedMessageIndex: number | null = null;
  for (let i = 0; i < previousDigests.length; i += 1) {
    if (previousDigests[i] !== next.messageDigests[i]) {
      firstMutatedMessageIndex = i;
      break;
    }
  }
  const mutatedBeforeTail =
    systemChanged ||
    toolsChanged ||
    (firstMutatedMessageIndex !== null && firstMutatedMessageIndex < previousDigests.length - 1);

  const where = systemChanged
    ? "system"
    : toolsChanged
      ? "tools"
      : firstMutatedMessageIndex !== null
        ? `message[${firstMutatedMessageIndex}]`
        : null;
  return {
    systemChanged,
    toolsChanged,
    firstMutatedMessageIndex,
    mutatedBeforeTail,
    summary:
      where === null
        ? "prefix stable (append-only)"
        : `prefix mutated at ${where} before previous tail breakpoint (previous length ${previousDigests.length})`,
  };
}

interface RuntimeStabilityState {
  previous: ProviderRequestSections;
}

const runtimeStabilityStates = new WeakMap<object, RuntimeStabilityState>();

/**
 * 运行时接线：按 runtime 实例记住上一次请求的分段指纹，返回本次的稳定性报告。
 * 首次调用（无基线）返回 null。纯增量内存开销：每会话一份分段哈希。
 */
export function trackProviderRequestStabilityForRuntime(
  runtime: object,
  request: RequestLike,
): CacheStabilityReport | null {
  const sections = sectionizeProviderRequest(request);
  const existing = runtimeStabilityStates.get(runtime);
  runtimeStabilityStates.set(runtime, { previous: sections });
  if (!existing) return null;
  return diffProviderRequests(existing.previous, sections);
}
