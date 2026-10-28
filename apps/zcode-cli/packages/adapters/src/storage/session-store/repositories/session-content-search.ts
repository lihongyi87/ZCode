import type { DatabaseSync } from "node:sqlite";
import type {
  SessionSearchInput,
  SessionSearchMatch,
  SessionSearchOutput,
} from "@zcode/contracts";
import { decodePartRow } from "../codecs.js";
import type { PartRow } from "../rows.js";

// spec 162(SessionSearch):agent 跨会话只读检索。会话事实归 CLI db(spec 160/162),
// 这里不写入、不建索引——SQL LIKE 预滤(node:sqlite C 速度)+ JS 解码后对真实文本字段
// 精确匹配并取片段。升级路径(FTS5 旁路只读索引)见 spec,正库 schema 永不因检索改动。

/** SQL 预滤行上限;多取 1 行用于探测截断。 */
const PREFETCH_LIMIT = 400;
/** 片段窗口:命中位置两侧各取的字符数。 */
const SNIPPET_RADIUS = 240;

interface PrefilterRow extends PartRow {
  session_title: string;
  session_directory: string;
  session_created: number;
}

export async function searchSessionContent(
  db: DatabaseSync,
  input: SessionSearchInput,
  context: { currentSessionId?: string; currentDirectory: string },
): Promise<SessionSearchOutput> {
  const scope = input.scope ?? "workspace";
  const limit = input.limit ?? 20;
  const clauses = ["s.time_deleted is null", `p.data like ? escape '\\'`];
  const values: Array<string | number> = [`%${escapeLike(input.query)}%`];
  if (scope === "workspace") {
    clauses.push("s.directory = ?");
    values.push(context.currentDirectory);
  }
  if (!input.includeCurrentSession && context.currentSessionId) {
    clauses.push("p.session_id != ?");
    values.push(context.currentSessionId);
  }
  values.push(PREFETCH_LIMIT + 1);

  let rows: PrefilterRow[];
  try {
    rows = db
      .prepare(
        `select p.*, s.title as session_title, s.directory as session_directory,
                s.time_created as session_created
         from part p join session s on s.id = p.session_id
         where ${clauses.join(" and ")}
         order by p.time_created desc
         limit ?`,
      )
      .all(...values) as unknown as PrefilterRow[];
  } catch {
    // 检索是增强能力,库结构异常/锁定时返回空结果而非让工具调用失败。
    return { results: [], truncated: false, note: "session store unavailable for search" };
  }

  const truncatedByPrefetch = rows.length > PREFETCH_LIMIT;
  if (truncatedByPrefetch) rows = rows.slice(0, PREFETCH_LIMIT);

  const needle = input.query.toLowerCase();
  const results: SessionSearchMatch[] = [];
  for (const row of rows) {
    if (results.length >= limit) break;
    const part = decodePartRow(row);
    // SQL 预滤可能命中 JSON 键名噪音;JS 段只认真实文本字段(TextPart.text 等)。
    const text = typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : undefined;
    if (!text) continue;
    const index = text.toLowerCase().indexOf(needle);
    if (index < 0) continue;
    const start = Math.max(0, index - SNIPPET_RADIUS);
    const end = Math.min(text.length, index + needle.length + SNIPPET_RADIUS);
    results.push({
      sessionId: row.session_id,
      title: row.session_title,
      directory: row.session_directory,
      timeCreated: row.session_created,
      messageId: row.message_id,
      partId: row.id,
      snippet: text.slice(start, end),
    });
  }

  return {
    results,
    truncated: truncatedByPrefetch || results.length >= limit,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (ch) => `\\${ch}`);
}
