import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";
import { searchSessionContent } from "../src/storage/session-store/repositories/session-content-search.js";

// spec 162(SessionSearch):只读跨会话检索——SQL LIKE 预滤 + JS 解码后对真实文本字段
// 精确匹配取片段。软删除过滤、scope 隔离、当前会话排除、通配符转义在此钉住。
async function openDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  await runSqliteSessionMigrations(db, ":memory:");
  return db;
}

function seedSession(
  db: DatabaseSync,
  input: { id: string; directory: string; title?: string; timeCreated?: number; deleted?: boolean },
): void {
  db.prepare(
    `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated, time_deleted)
     values (?, 'proj', ?, ?, ?, '1.0.0', ?, ?, ?)`,
  ).run(
    input.id,
    `slug-${input.id}`,
    input.directory,
    input.title ?? input.id,
    input.timeCreated ?? 1_000,
    input.timeCreated ?? 1_000,
    input.deleted ? 2_000 : null,
  );
}

function seedTextPart(
  db: DatabaseSync,
  input: { id: string; sessionId: string; messageId: string; text: string; timeCreated?: number },
): void {
  db.prepare(
    `insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, '{}')`,
  ).run(input.messageId, input.sessionId, input.timeCreated ?? 1_000, input.timeCreated ?? 1_000);
  db.prepare(
    `insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)
     values (?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    input.id,
    input.messageId,
    input.sessionId,
    input.timeCreated ?? 1_000,
    input.timeCreated ?? 1_000,
    JSON.stringify({ type: "text", text: input.text }),
  );
}

const CTX = { currentSessionId: "cur", currentDirectory: "/w/main" };

it("命中真实文本 part 并返回片段;scope=workspace 只搜本目录", async () => {
  const db = await openDb();
  try {
    seedSession(db, { id: "s1", directory: "/w/main" });
    seedSession(db, { id: "s2", directory: "/w/other" });
    seedTextPart(db, { id: "p1", sessionId: "s1", messageId: "m1", text: "我们上次讨论过 KV 缓存预热方案" });
    seedTextPart(db, { id: "p2", sessionId: "s2", messageId: "m2", text: "别处的 KV 缓存预热" });

    const result = await searchSessionContent(db, { query: "缓存预热" }, CTX);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.sessionId).toBe("s1");
    expect(result.results[0]?.partId).toBe("p1");
    expect(result.results[0]?.snippet).toContain("缓存预热");

    const all = await searchSessionContent(db, { query: "缓存预热", scope: "all" }, CTX);
    expect(all.results).toHaveLength(2);
  } finally {
    db.close();
  }
});

it("软删除会话被过滤;当前会话默认排除、显式包含可搜", async () => {
  const db = await openDb();
  try {
    seedSession(db, { id: "dead", directory: "/w/main", deleted: true });
    seedSession(db, { id: "cur", directory: "/w/main" });
    seedSession(db, { id: "old", directory: "/w/main" });
    seedTextPart(db, { id: "pd", sessionId: "dead", messageId: "md", text: "target-token 出现在软删除会话" });
    seedTextPart(db, { id: "pc", sessionId: "cur", messageId: "mc", text: "target-token 出现在当前会话" });
    seedTextPart(db, { id: "po", sessionId: "old", messageId: "mo", text: "target-token 出现在历史会话" });

    const def = await searchSessionContent(db, { query: "target-token" }, CTX);
    expect(def.results.map((r) => r.sessionId)).toEqual(["old"]);

    const withCur = await searchSessionContent(
      db,
      { query: "target-token", includeCurrentSession: true },
      CTX,
    );
    expect(withCur.results.map((r) => r.sessionId).sort()).toEqual(["cur", "old"]);
  } finally {
    db.close();
  }
});

it("SQL 通配符按字面匹配;大小写不敏感;非文本 part 不产出结果", async () => {
  const db = await openDb();
  try {
    seedSession(db, { id: "s1", directory: "/w/main" });
    seedTextPart(db, { id: "p1", sessionId: "s1", messageId: "m1", text: "progress 100% done, keep 50_percent" });
    db.prepare(
      `insert into message (id, session_id, time_created, time_updated, data) values ('m2','s1',3,3,'{}')`,
    ).run();
    db.prepare(
      `insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)
       values ('p2','m2','s1',3,3,?,2)`,
    ).run(JSON.stringify({ type: "tool", tool: "Percent", state: { status: "completed" } }));

    const pct = await searchSessionContent(db, { query: "100%" }, CTX);
    expect(pct.results.map((r) => r.partId)).toEqual(["p1"]);

    const underscore = await searchSessionContent(db, { query: "50_percent" }, CTX);
    expect(underscore.results.map((r) => r.partId)).toEqual(["p1"]);

    const ci = await searchSessionContent(db, { query: "PROGRESS" }, CTX);
    expect(ci.results.map((r) => r.partId)).toEqual(["p1"]);

    // SQL 命中 tool part 的 data(JSON 键名 status)但 JS 段无 text 字段 → 不产出
    const toolName = await searchSessionContent(db, { query: "status" }, CTX);
    expect(toolName.results).toHaveLength(0);
  } finally {
    db.close();
  }
});

it("limit 截断置位 truncated;查询无命中返回空结果", async () => {
  const db = await openDb();
  try {
    seedSession(db, { id: "s1", directory: "/w/main" });
    for (let i = 0; i < 3; i++) {
      seedTextPart(db, {
        id: `p${i}`,
        sessionId: "s1",
        messageId: `m${i}`,
        text: `hit-number-${i} marker`,
        timeCreated: 1_000 + i,
      });
    }
    const limited = await searchSessionContent(db, { query: "marker", limit: 2 }, CTX);
    expect(limited.results).toHaveLength(2);
    expect(limited.truncated).toBe(true);
    // 时间降序:最新在前
    expect(limited.results[0]?.partId).toBe("p2");

    const none = await searchSessionContent(db, { query: "不存在的内容" }, CTX);
    expect(none.results).toHaveLength(0);
    expect(none.truncated).toBe(false);
  } finally {
    db.close();
  }
});
