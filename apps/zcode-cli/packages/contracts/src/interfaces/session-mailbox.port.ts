import type { SessionId } from "./shared.js";

/**
 * 任务消息来源类别。task=会话任务互发;automation/offpeak=调度器代发。
 * 缺席=旧格式/来源不明(spec 149 深度护栏:永不作为 proactive 唤醒依据)。
 */
export type SessionMailboxSourceType = "task" | "automation" | "offpeak";

export interface SessionMailboxEnvelope {
  version: 1;
  messageId: string;
  fromSessionId: SessionId;
  toSessionId: SessionId;
  content: string;
  createdAt: string;
  sourceType?: SessionMailboxSourceType;
  /** 触发本次发送的命令锚点(信任锚);与 sourceType/depth 共同构成可唤醒条件。 */
  sourceCommandId?: string;
  /** 唤醒链深度:人/自动化发起=0,任务消息触发的再发送=N+1。 */
  depth?: number;
  /** 发送方展示名(任务名),供 UI 徽标与 `<session-message>` 注入。 */
  senderLabel?: string;
}

/** 投递输入:messageId/createdAt 由信箱适配器生成(信封身份单一所有者)。 */
export interface SessionMailboxAppendInput {
  toSessionId: SessionId;
  fromSessionId: SessionId;
  content: string;
  sourceType?: SessionMailboxSourceType;
  sourceCommandId?: string;
  depth?: number;
  senderLabel?: string;
}

export interface SessionMailboxPort {
  drainUnread(
    input: {
      sessionId: SessionId;
      limit?: number;
      /** 只取出满足谓词的信封;不满足者留在 unread(供人驱动的下一次 drain 交付)。 */
      filter?: (envelope: SessionMailboxEnvelope) => boolean;
    },
    options?: { signal?: AbortSignal },
  ): Promise<SessionMailboxEnvelope[]>;
  /** 投递一条消息到目标会话 unread;原子落盘,幂等性由调用方 requestId 保障。 */
  append(input: SessionMailboxAppendInput): Promise<SessionMailboxEnvelope>;
}

/** 判定信封是否满足 proactive 唤醒条件(信任锚三件套齐全且深度未超限)。 */
export function isWakeableTaskMessage(
  envelope: SessionMailboxEnvelope,
  maxWakeDepth: number,
): boolean {
  return (
    envelope.sourceType !== undefined &&
    envelope.sourceCommandId !== undefined &&
    typeof envelope.depth === "number" &&
    envelope.depth >= 0 &&
    envelope.depth <= maxWakeDepth
  );
}
