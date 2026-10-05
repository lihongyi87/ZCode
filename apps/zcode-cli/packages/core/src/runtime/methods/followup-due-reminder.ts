import { join } from "node:path";
import type { FileSystemPort } from "@zcode/contracts";

/**
 * 预测回填闭环·读侧（P5）：会话首个 turn 注入已到期/临期的预测登记，
 * 让「预测 → 到期验证 → 修规则」的自有回测飞轮转起来。
 *
 * 数据契约（workspace 侧登记，ZCode 只读）：
 *   <工作目录>/.zcode/followups.json = FollowupEntry[]
 *   { id, prediction, dueDate(ISO), verifyHint?, sourceAnchor? }
 * 写侧是技能交付约定（断语含应期/证伪窗口即追加登记），见 workspace AGENTS.md。
 *
 * 行为：每个 runtime 只注入一次（会话启动时机语义）；无到期项 → null 不注入；
 * 坏条目跳过并在正文尾行计数提示（diagnostics 语义），不阻断。
 */

/** 到期前多少天内算「临期」一并提醒。 */
const SOON_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FOLLOWUPS_RELATIVE_PATH = join(".zcode", "followups.json");

export interface FollowupEntry {
  id: string;
  /** 预测内容（一句话，含断语主体）。 */
  prediction: string;
  /** 应验/证伪到期日（ISO 8601）。 */
  dueDate: string;
  /** 怎么验证（找谁核对/看什么数据）。 */
  verifyHint?: string;
  /** 来源记忆/文件锚点（路径或记忆文件名）。 */
  sourceAnchor?: string;
}

let attemptedRuntimes = new WeakSet<object>();

/** 测试隔离：清除「每 runtime 一次」标记。 */
export function resetFollowupAttemptedForTesting(): void {
  attemptedRuntimes = new WeakSet();
}

interface ParsedFollowups {
  due: FollowupEntry[];
  invalidCount: number;
}

function parseFollowupsFile(text: string, now: number): ParsedFollowups {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { due: [], invalidCount: -1 }; // -1 = 整个文件不是合法 JSON
  }
  if (!Array.isArray(parsed)) return { due: [], invalidCount: -1 };
  const due: FollowupEntry[] = [];
  let invalidCount = 0;
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      invalidCount += 1;
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    const prediction =
      typeof record.prediction === "string" && record.prediction.trim().length > 0
        ? record.prediction.trim()
        : undefined;
    const dueMs = typeof record.dueDate === "string" ? Date.parse(record.dueDate) : Number.NaN;
    if (!id || !prediction || !Number.isFinite(dueMs)) {
      invalidCount += 1;
      continue;
    }
    if (dueMs <= now + SOON_WINDOW_MS) {
      due.push({
        id,
        prediction,
        dueDate: record.dueDate as string,
        ...(typeof record.verifyHint === "string" && record.verifyHint.trim()
          ? { verifyHint: record.verifyHint.trim() }
          : {}),
        ...(typeof record.sourceAnchor === "string" && record.sourceAnchor.trim()
          ? { sourceAnchor: record.sourceAnchor.trim() }
          : {}),
      });
    }
  }
  due.sort((left, right) => Date.parse(left.dueDate) - Date.parse(right.dueDate));
  return { due, invalidCount };
}

function renderFollowups(parsed: ParsedFollowups): string {
  const lines = [
    "以下为本项目已到期/7 天内到期的预测登记（回填闭环）。请在本轮工作内顺带核对结果并回填验证结论；核对不了的先向用户报告到期项。",
    ...parsed.due.map((entry) => {
      const parts = [`- [#${entry.id} ${entry.dueDate}] ${entry.prediction}`];
      if (entry.verifyHint) parts.push(`验证：${entry.verifyHint}`);
      if (entry.sourceAnchor) parts.push(`锚点：${entry.sourceAnchor}`);
      return parts.join("｜");
    }),
  ];
  if (parsed.invalidCount !== 0) {
    lines.push(
      parsed.invalidCount < 0
        ? "⚠ .zcode/followups.json 不是合法的登记数组，已跳过（请修复格式）"
        : `⚠ ${parsed.invalidCount} 条登记格式无效（缺 id/prediction/dueDate），已跳过`,
    );
  }
  return lines.join("\n");
}

export interface FollowupDueReminderInput {
  runtime: object;
  fileSystem: FileSystemPort;
  workingDirectory: string;
}

/** 返回提醒正文；无需提醒（未登记/无到期项/已注入过）返回 null。 */
export async function buildFollowupDueReminderBody(
  input: FollowupDueReminderInput,
): Promise<string | null> {
  if (attemptedRuntimes.has(input.runtime)) return null;
  attemptedRuntimes.add(input.runtime);
  let text: string;
  try {
    const read = await input.fileSystem.readTextFile({
      path: join(input.workingDirectory, FOLLOWUPS_RELATIVE_PATH),
    });
    text = read.content;
  } catch {
    return null; // 未登记是常态，静默
  }
  const parsed = parseFollowupsFile(text, Date.now());
  if (parsed.due.length === 0 && parsed.invalidCount === 0) return null;
  if (parsed.due.length === 0) return renderFollowups(parsed); // 只有坏条目也要提示修复
  return renderFollowups(parsed);
}
