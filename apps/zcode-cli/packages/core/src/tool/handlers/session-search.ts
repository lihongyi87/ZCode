import {
  CoreErrorType,
  SESSION_SEARCH_TOOL_NAME,
  SessionSearchInputJsonSchema,
  SessionSearchInputSchema,
  SessionSearchOutputJsonSchema,
  SessionSearchOutputSchema,
  createCoreError,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

/**
 * SessionSearch:agent 跨会话全文检索(spec 162 / 160 P1)。
 *
 * 会话正文是最大的经验库,但 agent 此前没有回忆面——记忆只覆盖主动沉淀的事实,
 * KbSearch 只覆盖知识卡。本工具只读检索本机 CLI 会话库(未删除、按 scope 隔离),
 * 返回命中片段;与 Hermes 分工一致:记忆管要点,搜索回忆细节。
 */
export const sessionSearchHandler: ToolHandler = async (input, context) => {
  const request = SessionSearchInputSchema.parse(input);
  const port = context.sessionHistorySearchPort;
  if (!port) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SessionSearch requires a local session store",
      {
        context: { toolCallId: context.toolCallId, toolName: SESSION_SEARCH_TOOL_NAME },
        recoverable: false,
      },
    );
  }
  const result = await port.search(request, {
    currentSessionId: context.sessionId,
    currentDirectory: context.workingDirectory,
  });
  return SessionSearchOutputSchema.parse(result) as unknown;
};

export const sessionSearchToolEntry: ToolEntry = {
  capability: "Search past local session transcripts and return match snippets",
  metadata: {
    name: SESSION_SEARCH_TOOL_NAME,
    description:
      "Search the full text of past local sessions (all messages and tool results you or other sessions " +
      "produced on this machine) and return up to 50 match snippets with sessionId, title, directory, time and a " +
      "±240-char snippet. Default scope is the current workspace directory; `all` searches every non-deleted " +
      "local session. The current session is excluded unless `includeCurrentSession` is true. " +
      "Use this when a question depends on what was discussed or found in earlier tasks " +
      "('did we already debug this last week?'); memory covers curated facts, this covers the raw history. " +
      "Query is a literal plain-word substring; returns empty `results` when nothing matches — do not invent history.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10_000,
    maxOutputBytes: 64_000,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: sessionSearchHandler,
  inputSchema: SessionSearchInputJsonSchema,
  outputSchema: SessionSearchOutputJsonSchema,
  runtimeInputSchema: SessionSearchInputSchema,
  runtimeOutputSchema: SessionSearchOutputSchema,
  permission: {
    permission: "sessionSearch",
    reason: "SessionSearch only reads local session transcripts",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 64_000,
    maxModelBytes: 64_000,
    strategy: "truncate",
    preview: {
      maxBytes: 64_000,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 10_000,
    maxMs: 20_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "SessionSearch was cancelled before match snippets were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
