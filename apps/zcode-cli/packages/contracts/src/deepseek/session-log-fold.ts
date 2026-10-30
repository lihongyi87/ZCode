/**
 * DeepSeek `dsh_session_log` 的会话消息折叠(spec 157)。
 *
 * 输入是每次模型请求现成的 `ModelInputMessage[]`(canonical 模型表面历史)——与 DSH
 * session-log-deepseek(Apache-2.0)从 canonical log 折叠同语义,但不需要独立事件流:
 * fold 是确定性的纯函数,同一消息序列永远折叠出同一 wire 序列,seq 即折叠序号。
 *
 * 增量与水印:watermark 记录 {messageCount, chainHash, throughSeq}。当前 messages
 * 前 messageCount 条的链式指纹与水印匹配 → 打包 throughSeq 之后的增量;不匹配
 * (compact/rewind/fork/进程重启)→ 水印失效,从 0 全量重发。at-least-once:宁重复
 * 不跳过,服务端按 afterSeq 幂等。
 */

import type { ModelInputMessage } from "../model/index.js";
import {
  packDeepSeekSessionLog,
  type DeepSeekSessionLogExtension,
  type DeepSeekSessionLogPendingEvent,
  type DeepSeekSessionLogWireEvent,
} from "./session-log-wire.js";

/**
 * 折叠指纹:水印续传的前缀一致性判定。
 * chainHash 是前 messageCount 条消息的链式 hash(逐条混入 role+文本头 256 字符)——
 * 锚定前缀而非末条,追加新消息不破坏旧前缀的指纹,增量续传才成立;前缀内任何变异
 * (编辑/compact/rewind)都会改变链值,触发从 0 全量重发。
 */
export interface DeepSeekSessionLogFingerprint {
  readonly messageCount: number;
  readonly chainHash: number | null;
}

/** 水印 = 上次 2xx 确认的折叠进度。 */
export interface DeepSeekSessionLogWatermark extends DeepSeekSessionLogFingerprint {
  readonly throughSeq: number;
  /** 本会话 log 视图的创建时间(wire header createdAt);水印失效重建时刷新。 */
  readonly createdAt: number;
}

/** 每次模型请求的传递对象:注入值 + 发送成功后的确认回调(runtime-only,不可序列化)。 */
export interface DeepSeekSessionLogRequestTransaction {
  readonly value: DeepSeekSessionLogExtension;
  readonly throughSeq: number;
  /** HTTP 2xx 后由 provider fetch 层调用一次;实现方据此推进水印。 */
  readonly accept: () => void;
}

/** 消息文本投影:仅 text 块;空内容返回 undefined(整条跳过不占 seq)。 */
export function sessionLogMessageText(message: ModelInputMessage): string | undefined {
  if (typeof message.content === "string") {
    return message.content.length > 0 ? message.content : undefined;
  }
  const text = message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n\n");
  return text.length > 0 ? text : undefined;
}

/** djb2:折叠指纹专用(非加密)。 */
export function sessionLogHash(input: string): number {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0;
  }
  return hash | 0;
}

/** 前 count 条消息的链式前缀指纹;count<=0 返回 null。每条只混入文本头 256 字符,O(n)。 */
export function computeChainHash(
  messages: readonly ModelInputMessage[],
  count: number,
): number | null {
  if (count <= 0) return null;
  let chain = 5381;
  const limit = Math.min(count, messages.length);
  for (let index = 0; index < limit; index += 1) {
    const message = messages[index];
    chain = sessionLogHash(
      `${chain}:${message.role}:${(sessionLogMessageText(message) ?? "").slice(0, 256)}`,
    );
  }
  return chain | 0;
}

export function fingerprintModelMessages(
  messages: readonly ModelInputMessage[],
): DeepSeekSessionLogFingerprint {
  return {
    messageCount: messages.length,
    chainHash: computeChainHash(messages, messages.length),
  };
}

/**
 * 确定性折叠:messages → wire 事件序列(seq = 折叠序号)。
 * 词表映射:system→system/message、user→user/message、assistant→assistant/message、
 * tool→tool/result;空文本消息(纯 reasoning/附件)不占 seq。
 */
export function foldModelMessagesToSessionLogWire(
  messages: readonly ModelInputMessage[],
): DeepSeekSessionLogPendingEvent[] {
  const pending: DeepSeekSessionLogPendingEvent[] = [];
  let seq = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const text = sessionLogMessageText(message);
    if (text === undefined) continue;
    let type: DeepSeekSessionLogWireEvent["type"];
    let data: unknown;
    switch (message.role) {
      case "system":
        type = "system/message";
        data = { text };
        break;
      case "user":
        type = "user/message";
        data = { text };
        break;
      case "assistant":
        type = "assistant/message";
        data = { text };
        break;
      case "tool":
        type = "tool/result";
        data = {
          ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
          ...(message.toolCallId !== undefined ? { id: message.toolCallId } : {}),
          ...(message.isError === true ? { isError: true } : {}),
          text,
        };
        break;
      default:
        continue;
    }
    const wire: DeepSeekSessionLogWireEvent = {
      type,
      seq,
      time: Date.now(),
      data,
      surfaceOp: "append",
      sourceEventSeqs: [index],
    };
    pending.push({ seq, wire });
    seq += 1;
  }
  return pending;
}

export interface BuiltDeepSeekSessionLog {
  readonly value: DeepSeekSessionLogExtension;
  readonly throughSeq: number;
  /** accept 成功后应持久化的水印。 */
  readonly watermark: DeepSeekSessionLogWatermark;
}

/**
 * fold + 指纹判定 + 打包;返回 undefined 表示本请求不携带(无新增事件,或首个事件
 * 单独超 maxBytes)。指纹失配时自动从 0 全量重发(at-least-once)。
 */
export function buildDeepSeekSessionLog(input: {
  sessionId: string;
  messages: readonly ModelInputMessage[];
  watermark: DeepSeekSessionLogWatermark | undefined;
  maxBytes: number;
  /** 子会话的父会话 ID(spec 165 session affinity);wire parentSession 字段,服务端按它聚合缓存域。 */
  parentSessionId?: string;
}): BuiltDeepSeekSessionLog | undefined {
  const { sessionId, messages, watermark, maxBytes, parentSessionId } = input;
  // 水印匹配锚定「前 watermark.messageCount 条」的链式指纹:追加新消息不影响旧前缀,
  // 增量续传成立;前缀变异/收缩(compact、rewind)则链值不同,自动全量重发。
  const watermarkMatches =
    watermark !== undefined &&
    watermark.messageCount <= messages.length &&
    computeChainHash(messages, watermark.messageCount) === watermark.chainHash;
  const currentFingerprint = fingerprintModelMessages(messages);
  const effectiveWatermark: DeepSeekSessionLogWatermark = watermarkMatches
    ? watermark
    : { ...currentFingerprint, throughSeq: 0, createdAt: Date.now() };

  // 失配(或无水印)= 全量重发:过滤基准用 -1,让 seq=0 的首条事件也进包;
  // wire envelope 的 afterSeq 语义是「服务端已确认水位」,首次全量归 0。
  const afterSeq = watermarkMatches ? watermark.throughSeq : -1;

  const all = foldModelMessagesToSessionLogWire(messages);
  const pending = all.filter((event) => event.seq > afterSeq);
  if (pending.length === 0) return undefined;

  const packed = packDeepSeekSessionLog({
    session: {
      version: 1,
      id: sessionId,
      createdAt: effectiveWatermark.createdAt,
      ...(parentSessionId !== undefined ? { parentSession: parentSessionId } : {}),
    },
    sessionFormatVersion: 1,
    afterSeq: Math.max(0, afterSeq),
    pending,
    maxBytes,
  });
  if (!packed.packed) return undefined;
  return {
    value: packed.value,
    throughSeq: packed.throughSeq,
    watermark: {
      messageCount: messages.length,
      chainHash: currentFingerprint.chainHash,
      throughSeq: packed.throughSeq,
      createdAt: effectiveWatermark.createdAt,
    },
  };
}
