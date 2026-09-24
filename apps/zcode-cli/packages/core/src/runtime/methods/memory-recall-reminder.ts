import type { FileSystemPort } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { modelMessageContentToText } from "../deps.js";
import { scanMemoryManifest } from "../../memory/recall/index.js";
import { scoreMemoryEntries } from "../../memory/recall/score.js";
import type { MemoryManifestEntry } from "../../memory/recall/types.js";

/**
 * 记忆召回提醒的构建（turn 级，吸收 Hermes 的 prefetch 模式）。
 *
 * 每轮用户输入落定后：对记忆清单按「本轮输入 ↔ 条目摘要」做词法相关性排序，
 * top-K 以 system-reminder 注入本轮请求——模型看到的是「可能与本轮相关的少量
 * 记忆 + 精确路径」，而不是全量索引；需要细节时用 Read 精确重取。
 *
 * 与缓存的关系（刻意为之）：提醒是 per-request 附件，只出现在本轮尾部，
 * 不改写历史前缀——已写入的 prompt cache 不受影响；缓存稳定性检测器也不会
 * 把它报成前缀变异。
 *
 * 清单扫描按 runtime 缓存 60s（扫描要读最多 200 个文件的 frontmatter，
 * 逐轮全扫是纯浪费）；失败降级为无召回，绝不阻塞 turn。
 */

const SCAN_TTL_MS = 60_000;
const TOP_K = 5;

interface CacheSlot {
  at: number;
  entries: MemoryManifestEntry[];
}

const manifestCache = new WeakMap<object, CacheSlot>();

export function latestRealUserText(entries: readonly RuntimeMessageEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "message" && entry.metadata?.source === "real_user") {
      const text = modelMessageContentToText(entry.message.content).trim();
      if (text) return text;
    }
  }
  return null;
}

export interface MemoryRecallReminderInput {
  runtime: object;
  fileSystem: FileSystemPort;
  memoryRoot: string;
  entries: readonly RuntimeMessageEntry[];
}

/** 返回提醒正文；无相关记忆时返回 null（不注入）。 */
export async function buildMemoryRecallReminderBody(
  input: MemoryRecallReminderInput,
): Promise<string | null> {
  const query = latestRealUserText(input.entries);
  if (!query) return null;

  const now = Date.now();
  let slot = manifestCache.get(input.runtime);
  if (!slot || now - slot.at > SCAN_TTL_MS) {
    try {
      slot = {
        entries: await scanMemoryManifest({
          fileSystem: input.fileSystem,
          rootDir: input.memoryRoot,
        }),
        at: now,
      };
      manifestCache.set(input.runtime, slot);
    } catch {
      return null;
    }
  }
  if (slot.entries.length === 0) return null;

  const ranked = scoreMemoryEntries(query, slot.entries, { topK: 5 });
  if (ranked.length === 0) return null;

  const lines = [
    "以下为与本轮输入可能相关的既有记忆（按相关度排序）。需要细节时用 Read 读取对应文件；未列出的记忆与本轮大概率无关。",
    ...ranked.map(
      ({ entry }) => `- ${entry.filePath}${entry.description ? ` — ${entry.description}` : ""}`,
    ),
  ];
  return lines.join("\n");
}
