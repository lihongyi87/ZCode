import {
  HookEventName,
  isWakeableTaskMessage,
  type SessionId,
  type SessionMailboxPort,
  type TraceContext,
} from "@zcode/contracts";
import type { HookRegistration } from "./types.js";

const MAILBOX_DRAIN_LIMIT = 20;
/** spec 149 深度护栏:唤醒链深度超过该值的消息只交付不唤醒(等人来)。 */
const MAX_TASK_MESSAGE_WAKE_DEPTH = 4;

export function createSessionMailboxHookRegistrations(options: {
  enqueuePendingInput?: (
    input: string,
    traceContext: TraceContext,
    meta?: {
      steerSource?: "task_message";
      /** 本批可唤醒信封的最大深度;发送侧据此递增下一跳 depth(spec 149)。 */
      wakeDepth?: number;
      fromSessionId: string;
      senderLabel?: string;
    },
  ) => Promise<void>;
  mailbox: SessionMailboxPort;
  sessionId: SessionId;
}): HookRegistration[] {
  const callback: HookRegistration["callback"] = async (input, context) => {
    // PostToolUse(忙时 guide steer)与 Stop(闲时唤醒)是 proactive 通道:只取满足
    // 信任锚+深度上限的信封;不满足者留在 unread,等人驱动的 UserPromptSubmit 交付。
    const wakeOnly = input.hookEventName !== HookEventName.UserPromptSubmit;
    const messages = await options.mailbox.drainUnread(
      {
        sessionId: options.sessionId,
        limit: MAILBOX_DRAIN_LIMIT,
        ...(wakeOnly
          ? { filter: (envelope) => isWakeableTaskMessage(envelope, MAX_TASK_MESSAGE_WAKE_DEPTH) }
          : {}),
      },
      { signal: context.signal },
    );
    if (messages.length === 0) return undefined;

    if (input.hookEventName === HookEventName.PostToolUse && options.enqueuePendingInput) {
      const wakeDepth = Math.max(0, ...messages.map((message) => message.depth ?? 0));
      for (const message of messages) {
        await options.enqueuePendingInput(
          formatMailboxMessages([message]),
          {
            sessionId: options.sessionId,
            traceId: input.traceId,
            turnId: input.turnId,
          },
          {
            ...(message.sourceType !== undefined ? { steerSource: "task_message" } : {}),
            wakeDepth,
            fromSessionId: message.fromSessionId,
            ...(message.senderLabel !== undefined ? { senderLabel: message.senderLabel } : {}),
          },
        );
      }
      return undefined;
    }

    const additionalContext = formatMailboxMessages(messages);
    return {
      ...(input.hookEventName === HookEventName.Stop ? { continue: true } : {}),
      hookSpecificOutput: {
        additionalContext,
        hookEventName: input.hookEventName,
      },
    };
  };

  return [HookEventName.UserPromptSubmit, HookEventName.PostToolUse, HookEventName.Stop].map(
    (event) => ({
      callback,
      descriptor: {
        clientVisible: false,
        commandDisplay: "Session mailbox",
        executionMode: "foreground",
        executionType: "process",
        sourceKind: "internal",
        timeoutMs: 60_000,
      },
      event,
      source: "builtin.sessionMailbox.drain",
    }),
  );
}

function formatMailboxMessages(
  messages: Awaited<ReturnType<SessionMailboxPort["drainUnread"]>>,
): string {
  return messages
    .map((message) =>
      [
        `<session-message source="mailbox" message_id="${escapeAttr(message.messageId)}" from_session="${escapeAttr(message.fromSessionId)}" created_at="${escapeAttr(message.createdAt)}"${formatSourceAttributes(message)}>`,
        "For reference only. Verify against raw source before acting.",
        "",
        message.content,
        "</session-message>",
      ].join("\n"),
    )
    .join("\n\n");
}

type DrainedMailboxMessages = Awaited<ReturnType<SessionMailboxPort["drainUnread"]>>;

function formatSourceAttributes(message: DrainedMailboxMessages[number]): string {
  let attributes = "";
  if (message.senderLabel !== undefined) {
    attributes += ` sender_label="${escapeAttr(message.senderLabel)}"`;
  }
  if (message.depth !== undefined) {
    attributes += ` depth="${message.depth}"`;
  }
  if (message.sourceType !== undefined) {
    attributes += ` source_type="${escapeAttr(message.sourceType)}"`;
  }
  return attributes;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
