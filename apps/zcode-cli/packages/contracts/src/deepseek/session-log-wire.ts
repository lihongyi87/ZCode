/**
 * DeepSeek `dsh_session_log` 请求字段——v1 wire 类型与增量打包(spec 157)。
 *
 * 语义移植自 @deepseek-ai/dsh-session-log-deepseek(Apache-2.0,语义对齐其 README):
 * - 顶层请求字段,不进 messages;模型零 token 成本;服务端用于 KV 预热。
 * - watermark 续传:每次上传携 afterSeq(已确认水位),积压跨请求排空;宁重复不跳过。
 * - 事件表是 DSH 服务端认识的词表(user/message 等);ZCode 自有事件以外的记录
 *   转为 opaque ignorable 保持 seq 连续性。
 *
 * 本模块为纯函数(无 IO),便于单测;IO(水印持久化/发送)在 core 与 provider 层。
 */

/** DSH 服务端认识的表面事件词表(增量上传只携带这些;其余转 opaque ignorable)。 */
export type DeepSeekSurfaceEventType =
  | "developer/message"
  | "system/message"
  | "user/message"
  | "assistant/message"
  | "tool/result";

export interface DeepSeekSessionLogWireHeader {
  readonly version: number;
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly seedLength?: number;
  readonly origin?: "subagent";
  readonly delegationDepth?: number;
  readonly agentPreset?: string;
}

export type DeepSeekSessionLogWireSurfaceOp =
  | "append"
  | { readonly op: "replace"; readonly startSeq: number; readonly endSeq: number };

export interface DeepSeekSessionLogWireEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
  readonly ignorable?: true;
  readonly surfaceOp?: DeepSeekSessionLogWireSurfaceOp;
  readonly sourceEventSeqs?: readonly number[];
}

/** 版本化的增量会话日志字段(官方 DeepSeek 请求顶层携带)。 */
export interface DeepSeekSessionLogExtension {
  readonly version: 1;
  readonly sessionFormatVersion: number;
  readonly session: DeepSeekSessionLogWireHeader;
  readonly afterSeq: number;
  readonly throughSeq: number;
  readonly events: readonly DeepSeekSessionLogWireEvent[];
}

/** 待上传事件(canonical log 的一条;ZCode 事件到 wire 的映射由调用方完成)。 */
export interface DeepSeekSessionLogPendingEvent {
  readonly seq: number;
  readonly wire: DeepSeekSessionLogWireEvent;
}

/** 打包输入:水位之后的事件 + 上限。 */
export interface DeepSeekSessionLogPackInput {
  readonly session: DeepSeekSessionLogWireHeader;
  readonly sessionFormatVersion: number;
  readonly afterSeq: number;
  readonly pending: readonly DeepSeekSessionLogPendingEvent[];
  readonly maxBytes: number;
}

export type DeepSeekSessionLogPackResult =
  | {
      readonly packed: true;
      readonly value: DeepSeekSessionLogExtension;
      readonly throughSeq: number;
      readonly eventCount: number;
    }
  | {
      /** 首个待传事件单独超限:字段省略,水位停在该事件前(与 DSH 同语义)。 */
      readonly packed: false;
      readonly blockedAtSeq: number;
      readonly neededBytes: number;
    };

/** UTF-8 JSON 字节数;序列化失败计 Infinity(视为超出一切上限)。 */
export function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * 打包水位之后的增量会话日志:最长可容纳的前缀(事件按 seq 升序,整包含头)。
 * 首个事件单独超限时省略字段并报 blockedAtSeq(DSH 同语义:后续事件排在其后等待)。
 */
export function packDeepSeekSessionLog(
  input: DeepSeekSessionLogPackInput,
): DeepSeekSessionLogPackResult {
  const { session, sessionFormatVersion, afterSeq, pending, maxBytes } = input;
  if (pending.length > 0) {
    const first = pending[0];
    if (first.seq <= afterSeq) {
      throw new Error(
        `dsh_session_log: first pending seq ${String(first.seq)} is behind watermark ${String(afterSeq)}`,
      );
    }
  }

  const envelopeBase = {
    version: 1 as const,
    sessionFormatVersion,
    session,
    afterSeq,
  };
  // 不含 events/throughSeq 的基础字节数;每个候选前缀在此基础上累加。
  let bytes = jsonByteLength({ ...envelopeBase, throughSeq: 0, events: [] }) - 1;
  const events: DeepSeekSessionLogWireEvent[] = [];
  let throughSeq = afterSeq;
  let candidateBytes = 0;

  for (const item of pending) {
    const next = bytes + (events.length === 0 ? 0 : 1) + jsonByteLength(item.wire);
    candidateBytes = next + String(item.seq).length;
    if (candidateBytes > maxBytes) break;
    bytes = next;
    events.push(item.wire);
    throughSeq = item.seq;
  }

  if (events.length === 0) {
    const first = pending[0];
    return {
      packed: false,
      blockedAtSeq: first?.seq ?? afterSeq,
      neededBytes: candidateBytes,
    };
  }
  return {
    packed: true,
    value: { ...envelopeBase, throughSeq, events },
    throughSeq,
    eventCount: events.length,
  };
}
