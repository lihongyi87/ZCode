import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isWakeableTaskMessage } from "@zcode/contracts";
import { createNodeSessionMailboxAdapter } from "../src/mailbox/index.js";

describe("NodeSessionMailboxAdapter", () => {
  it("drains unread messages to read", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-mailbox-"));
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });
    const messageId = "mailbox-message-1";
    const unreadDir = join(rootDir, "sess_target", "unread");
    const unreadPath = join(unreadDir, `${messageId}.json`);
    await mkdir(unreadDir, { recursive: true });
    await writeFile(
      unreadPath,
      `${JSON.stringify(
        {
          version: 1,
          messageId,
          fromSessionId: "sess_source",
          toSessionId: "sess_target",
          content: "hello",
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(stat(unreadPath)).resolves.toBeTruthy();

    const drained = await mailbox.drainUnread({ sessionId: "sess_target" });

    expect(drained).toEqual([
      expect.objectContaining({
        messageId,
        fromSessionId: "sess_source",
        toSessionId: "sess_target",
        content: "hello",
      }),
    ]);
    await expect(stat(unreadPath)).rejects.toBeTruthy();
    const readPath = join(rootDir, "sess_target", "read", `${messageId}.json`);
    await expect(readFile(readPath, "utf8")).resolves.toContain("hello");
  });

  it("rejects session ids that would escape the mailbox root", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "zcode-mailbox-parent-"));
    const rootDir = join(parentDir, "mailbox", "root");
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });

    await expect(mailbox.drainUnread({ sessionId: "../escaped-target" as never })).rejects.toThrow(
      "Invalid session id",
    );
    await expect(stat(resolve(rootDir, "..", "escaped-target"))).rejects.toBeTruthy();
  });

  // spec 149:信封 v2——append 往返带来源/深度字段,旧格式兼容,非法可选字段拒收。
  it("append writes a wakeable envelope and drain returns source fields", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-mailbox-append-"));
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });

    const envelope = await mailbox.append({
      toSessionId: "sess_target",
      fromSessionId: "sess_source",
      content: "task handoff",
      sourceType: "task",
      sourceCommandId: "cmd-1",
      depth: 1,
      senderLabel: "任务A",
    });

    expect(envelope.version).toBe(1);
    expect(envelope.messageId).toBeTruthy();
    expect(envelope.sourceType).toBe("task");
    expect(envelope.depth).toBe(1);

    const drained = await mailbox.drainUnread({ sessionId: "sess_target" });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      sourceType: "task",
      sourceCommandId: "cmd-1",
      depth: 1,
      senderLabel: "任务A",
    });
  });

  it("drain filter leaves non-matching envelopes in unread", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-mailbox-filter-"));
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });
    await mailbox.append({
      toSessionId: "sess_target",
      fromSessionId: "sess_source",
      content: "wakeable",
      sourceType: "task",
      sourceCommandId: "cmd-1",
      depth: 0,
    });
    await mailbox.append({
      toSessionId: "sess_target",
      fromSessionId: "sess_legacy",
      content: "legacy",
    });

    const wakeOnly = await mailbox.drainUnread({
      sessionId: "sess_target",
      filter: (envelope) => isWakeableTaskMessage(envelope, 4),
    });
    expect(wakeOnly).toHaveLength(1);
    expect(wakeOnly[0].content).toBe("wakeable");

    // 未命中的旧格式信封仍在 unread,等人驱动的下一次全量 drain 交付。
    const all = await mailbox.drainUnread({ sessionId: "sess_target" });
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe("legacy");
  });

  it("parses legacy envelopes without source fields and rejects invalid optional fields", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-mailbox-legacy-"));
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });
    const unreadDir = join(rootDir, "sess_target", "unread");
    await mkdir(unreadDir, { recursive: true });
    await writeFile(
      join(unreadDir, "legacy.json"),
      JSON.stringify({
        version: 1,
        messageId: "legacy-1",
        fromSessionId: "sess_source",
        toSessionId: "sess_target",
        content: "old format",
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await writeFile(
      join(unreadDir, "bad-depth.json"),
      JSON.stringify({
        version: 1,
        messageId: "bad-1",
        fromSessionId: "sess_source",
        toSessionId: "sess_target",
        content: "broken",
        createdAt: new Date().toISOString(),
        depth: -1,
      }),
      "utf8",
    );

    // 既有死信语义:任一信封解析失败,drain 整批拒绝(与 JSON.parse 损坏同路径)。
    await expect(mailbox.drainUnread({ sessionId: "sess_target" })).rejects.toThrow(
      "Invalid session mailbox envelope source fields",
    );

    // 把坏信封改写成合法内容后,旧格式信封(无可选字段)正常解析交付。
    await writeFile(
      join(unreadDir, "bad-depth.json"),
      JSON.stringify({
        version: 1,
        messageId: "bad-1",
        fromSessionId: "sess_source",
        toSessionId: "sess_target",
        content: "broken",
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const legacy = await mailbox.drainUnread({
      sessionId: "sess_target",
      filter: (envelope) => envelope.messageId === "legacy-1",
    });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]?.messageId).toBe("legacy-1");
  });
});
