export interface SessionMessageSendRequested {
  content: string;
  createdAt: string;
  fromSessionId: string;
  messageId: string;
  requestId: string;
  toSessionId: string;
  /** spec 149 来源字段:与 SessionMailboxEnvelope(ZCode CLI contracts)可选字段同构。 */
  sourceType?: "task" | "automation" | "offpeak";
  sourceCommandId?: string;
  depth?: number;
  senderLabel?: string;
}

export interface SessionMessageDeliveryResult {
  error?: string;
  messageId: string;
  requestId: string;
  sessionId: string;
  status: "success" | "failed";
}
