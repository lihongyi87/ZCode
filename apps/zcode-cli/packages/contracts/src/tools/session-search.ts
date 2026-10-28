// ============================================================
// SessionSearch Tool - agent 跨会话全文检索(spec 162 / 160 P1)
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const SESSION_SEARCH_TOOL_NAME = "SessionSearch";

export const SessionSearchInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "Literal substring to find in past session transcripts. Use plain words; avoid quotes/backslashes/newlines (JSON-escaped text will not match those).",
      ),
    scope: z
      .enum(["workspace", "all"])
      .optional()
      .describe("Restrict to sessions of the current workspace directory (default) or search all local sessions."),
    limit: z.number().int().min(1).max(50).optional().describe("Maximum matches to return (default 20)."),
    includeCurrentSession: z
      .boolean()
      .optional()
      .describe("Also search the current session (default false; running context is already visible)."),
  })
  .strict();

export type SessionSearchInput = z.infer<typeof SessionSearchInputSchema>;
export const SessionSearchInputJsonSchema = toToolJsonSchema(SessionSearchInputSchema);

export const SessionSearchMatchSchema = z
  .object({
    sessionId: z.string(),
    title: z.string(),
    directory: z.string(),
    timeCreated: z.number(),
    messageId: z.string(),
    partId: z.string(),
    /** 命中位置前后的正文片段(非 JSON,来自解码后的文本 part)。 */
    snippet: z.string(),
  })
  .strict();

export const SessionSearchOutputSchema = z
  .object({
    results: z.array(SessionSearchMatchSchema),
    /** 预滤扫描上限截断(还有更多命中未返回)时为真。 */
    truncated: z.boolean(),
    /** 空结果/能力受限时的说明;正常省略。 */
    note: z.string().optional(),
  })
  .strict();

export type SessionSearchMatch = z.infer<typeof SessionSearchMatchSchema>;
export type SessionSearchOutput = z.infer<typeof SessionSearchOutputSchema>;
export const SessionSearchOutputJsonSchema = toToolJsonSchema(SessionSearchOutputSchema);

/**
 * 只读跨会话检索端口(spec 162)。实现方持有 CLI 会话库的读通道;
 * 不写入、不建索引,失败返回空结果而非抛错(检索是增强,不是关键路径)。
 */
export interface SessionHistorySearchPort {
  search(input: SessionSearchInput, context: { currentSessionId?: string; currentDirectory: string }): Promise<SessionSearchOutput>;
}
