import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  SessionId,
  SessionMailboxAppendInput,
  SessionMailboxEnvelope,
  SessionMailboxPort,
} from "@zcode/contracts";

export interface NodeSessionMailboxOptions {
  rootDir: string;
}

const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9._-]+$/;

/** append 写入的文件名前缀长度：15 位零填充毫秒时间戳 + 一个 "-"。 */
const MESSAGE_ID_PREFIX_LENGTH = 16;

export class NodeSessionMailboxAdapter implements SessionMailboxPort {
  constructor(private readonly options: NodeSessionMailboxOptions) {}

  async drainUnread(
    input: {
      sessionId: SessionId;
      limit?: number;
      filter?: (envelope: SessionMailboxEnvelope) => boolean;
    },
    options?: { signal?: AbortSignal },
  ): Promise<SessionMailboxEnvelope[]> {
    const unreadDir = this.sessionDir(input.sessionId, "unread");
    const readDir = this.sessionDir(input.sessionId, "read");
    await mkdir(unreadDir, { recursive: true });
    await mkdir(readDir, { recursive: true });

    const entries = (await readdir(unreadDir))
      .filter((entry) => entry.endsWith(".json"))
      .sort();
    const messages: SessionMailboxEnvelope[] = [];

    for (const entry of entries) {
      if (messages.length >= (input.limit ?? 20)) break;
      options?.signal?.throwIfAborted();
      const unreadPath = join(unreadDir, entry);
      const readPath = join(readDir, entry);
      const envelope = parseEnvelope(await readFile(unreadPath, "utf8"));
      // 过滤谓词不满足的信封留在 unread:limit 只计命中数,非命中不得阻塞队列。
      if (input.filter && !input.filter(envelope)) continue;
      messages.push(envelope);
      await rename(unreadPath, readPath);
    }

    return messages;
  }

  /**
   * 只读窥视 unread：与 drainUnread 同样按文件名字典序（即投递序），但**不移动文件**。
   * proactive dispatcher 用它判断「有没有可唤醒的信封」——发布事件失败时消息必须仍是
   * unread，否则下一次 drain 会静默漏掉这次唤醒。
   */
  async peekUnread(input: {
    sessionId: SessionId;
    limit?: number;
    filter?: (envelope: SessionMailboxEnvelope) => boolean;
  }): Promise<SessionMailboxEnvelope[]> {
    const unreadDir = this.sessionDir(input.sessionId, "unread");
    await mkdir(unreadDir, { recursive: true });

    const entries = (await readdir(unreadDir))
      .filter((entry) => entry.endsWith(".json"))
      .sort();
    const messages: SessionMailboxEnvelope[] = [];
    for (const entry of entries) {
      if (messages.length >= (input.limit ?? 20)) break;
      const envelope = parseEnvelope(await readFile(join(unreadDir, entry), "utf8"));
      if (input.filter && !input.filter(envelope)) continue;
      messages.push(envelope);
    }
    return messages;
  }

  /**
   * 按 messageId 把 unread 标记为已读。幂等：已读或不存在的 id 静默跳过。
   * @returns 实际移动的消息数。
   */
  async markRead(input: {
    sessionId: SessionId;
    messageIds: readonly string[];
  }): Promise<number> {
    if (input.messageIds.length === 0) return 0;
    const unreadDir = this.sessionDir(input.sessionId, "unread");
    const readDir = this.sessionDir(input.sessionId, "read");
    await mkdir(readDir, { recursive: true });

    const wanted = new Set(input.messageIds);
    let moved = 0;
    let entries: string[];
    try {
      entries = await readdir(unreadDir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      // 文件名 = <15 位零填充时间戳>-<messageId>.json；按前缀长度切，不能用 split("-")
      // （messageId 是带连字符的 UUID，按连字符切会只剩最后一段）。
      const stem = entry.slice(0, -".json".length);
      const messageId = stem.slice(MESSAGE_ID_PREFIX_LENGTH);
      if (!wanted.has(messageId)) continue;
      try {
        await rename(join(unreadDir, entry), join(readDir, entry));
        moved += 1;
      } catch {
        // 并发 drain 已移走该文件：目标状态已达成，不算失败。
      }
    }
    return moved;
  }

  async append(input: SessionMailboxAppendInput): Promise<SessionMailboxEnvelope> {    const unreadDir = this.sessionDir(input.toSessionId, "unread");
    await mkdir(unreadDir, { recursive: true });

    // drainUnread 按文件名字典序取最旧,文件名以毫秒时间戳为前缀保证投递序可读。
    const createdAt = new Date();
    const envelope: SessionMailboxEnvelope = {
      version: 1,
      messageId: randomUUID(),
      fromSessionId: input.fromSessionId,
      toSessionId: input.toSessionId,
      content: input.content,
      createdAt: createdAt.toISOString(),
      ...(input.sourceType !== undefined ? { sourceType: input.sourceType } : {}),
      ...(input.sourceCommandId !== undefined
        ? { sourceCommandId: input.sourceCommandId }
        : {}),
      ...(input.depth !== undefined ? { depth: input.depth } : {}),
      ...(input.senderLabel !== undefined ? { senderLabel: input.senderLabel } : {}),
    };
    const fileName = `${String(createdAt.getTime()).padStart(15, "0")}-${envelope.messageId}.json`;
    // tmp+rename 原子落盘:drain 端 rename/readdir 不会读到半截 JSON。
    const tmpPath = join(unreadDir, `.${fileName}.tmp`);
    const finalPath = join(unreadDir, fileName);
    await writeFile(tmpPath, JSON.stringify(envelope), "utf8");
    await rename(tmpPath, finalPath);
    return envelope;
  }

  private sessionDir(sessionId: SessionId, kind: "read" | "unread"): string {
    const normalizedSessionId = String(sessionId);
    if (!SESSION_ID_PATTERN.test(normalizedSessionId)) {
      throw new Error(`Invalid session id: ${normalizedSessionId}`);
    }

    const rootDir = resolve(this.options.rootDir);
    const sessionDir = resolve(rootDir, normalizedSessionId, kind);
    const relativePath = relative(rootDir, sessionDir);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Session mailbox path escapes root: ${normalizedSessionId}`);
    }
    return sessionDir;
  }
}

export function createNodeSessionMailboxAdapter(
  options: NodeSessionMailboxOptions,
): SessionMailboxPort {
  return new NodeSessionMailboxAdapter(options);
}

function parseEnvelope(content: string): SessionMailboxEnvelope {
  const parsed = JSON.parse(content) as SessionMailboxEnvelope;
  if (
    parsed.version !== 1 ||
    typeof parsed.messageId !== "string" ||
    typeof parsed.fromSessionId !== "string" ||
    typeof parsed.toSessionId !== "string" ||
    typeof parsed.content !== "string" ||
    typeof parsed.createdAt !== "string"
  ) {
    throw new Error("Invalid session mailbox envelope");
  }
  // spec 149:可选来源/深度字段——在场但类型非法视为信封损坏(走既有死信语义),
  // 缺席=旧格式,照常解析(消费端护栏负责"不唤醒")。
  if (
    (parsed.sourceType !== undefined &&
      parsed.sourceType !== "task" &&
      parsed.sourceType !== "automation" &&
      parsed.sourceType !== "offpeak") ||
    (parsed.sourceCommandId !== undefined && typeof parsed.sourceCommandId !== "string") ||
    (parsed.depth !== undefined &&
      (!Number.isInteger(parsed.depth) || parsed.depth < 0)) ||
    (parsed.senderLabel !== undefined && typeof parsed.senderLabel !== "string")
  ) {
    throw new Error("Invalid session mailbox envelope source fields");
  }
  return parsed;
}
