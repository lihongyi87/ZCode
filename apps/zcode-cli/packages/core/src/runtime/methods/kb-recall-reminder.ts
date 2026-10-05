import { join } from "node:path";
import type { FileSystemPort } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { latestRealUserText, rankRecallCorpus } from "./memory-recall-reminder.js";

/**
 * 知识卡召回层（P1）：把「查知识」从三层人肉路由+grep 变成一次语义召回。
 *
 * 语料契约（workspace 侧生成器产出，ZCode 只读）：
 *   <工作目录>/.zcode/kb-cards/*.md
 *   frontmatter description = "<源文件相对路径>#<标题> —— <首段摘要>"
 *   （锚点路径写进 description：渲染即锚点，embedding 面也含路径词元）
 *
 * 排序与 memory 召回同源（rankRecallCorpus：词法+余弦全量融合、预算、
 * 盘档、语义底线），manifest/向量缓存/盘档按语料根天然隔离。模型拿到
 * top-K 锚点后用 Read 精读对应源文件——只存指针不存知识第二副本（铁律5.8）。
 */

const KB_CARDS_DIR = join(".zcode", "kb-cards");
/** 注入锚点数。 */
const KB_TOP_K = 5;
/** 多样化候选池：融合排序取前 N 再按源文件去重——22.5K 卡语料实测 strict
 * top-5 常被同一文件的多张卡挤占（如原典同一章的案例小节），去重后 top-5
 * 覆盖更多源文件，模型拿到的线索面更宽。 */
const KB_DIVERSIFY_POOL = 12;
/** 每个源文件最多占几个注入位。 */
const KB_MAX_PER_FILE = 2;
/** kb 卡词法门槛：锚点 description 带路径词元更长，覆盖率天然稀释，放宽至 0.02。 */
const KB_LEXICAL_MIN_SCORE = 0.02;
/** kb 清单上限：与生成器护栏（24000）对齐——默认 200/旧 8000 都会把语料
 * 截断（对抗审查：8000 按字母序截断曾整门派砍掉 ziwei-*），生产召回必须
 * 全量可见。生成器护栏变更时同步此值（两处注释互指）。 */
const KB_FILE_LIMIT = 24000;

export function kbCardsRootDir(workingDirectory: string): string {
  return join(workingDirectory, KB_CARDS_DIR);
}

/** 锚点所属源文件：description 的 `#` 之前路径段。 */
function anchorSourceFile(description: string | undefined, fallback: string): string {
  if (!description) return fallback;
  const hashIndex = description.indexOf("#");
  return hashIndex > 0 ? description.slice(0, hashIndex) : description;
}

/** 源文件多样化：保持融合排序序，每文件至多 KB_MAX_PER_FILE 张，取满 KB_TOP_K。 */
export function diversifyKbAnchors(
  ranked: ReadonlyArray<{ description?: string; filename: string }>,
  topK = KB_TOP_K,
  maxPerFile = KB_MAX_PER_FILE,
): Array<{ description?: string; filename: string }> {
  const perFile = new Map<string, number>();
  const picked: Array<{ description?: string; filename: string }> = [];
  for (const entry of ranked) {
    if (picked.length >= topK) break;
    const file = anchorSourceFile(entry.description, entry.filename);
    const count = perFile.get(file) ?? 0;
    if (count >= maxPerFile) continue;
    perFile.set(file, count + 1);
    picked.push(entry);
  }
  return picked;
}

export interface KbRecallReminderInput {
  runtime: object;
  fileSystem: FileSystemPort;
  workingDirectory: string;
  entries: readonly RuntimeMessageEntry[];
}

/** 返回知识卡提醒正文；无卡/无相关返回 null。 */
export async function buildKbRecallReminderBody(
  input: KbRecallReminderInput,
): Promise<string | null> {
  const query = latestRealUserText(input.entries);
  if (!query) return null;
  const ranked = await rankRecallCorpus({
    runtime: input.runtime,
    fileSystem: input.fileSystem,
    rootDir: kbCardsRootDir(input.workingDirectory),
    query,
    topK: KB_DIVERSIFY_POOL,
    minScore: KB_LEXICAL_MIN_SCORE,
    fileLimit: KB_FILE_LIMIT,
  });
  if (ranked === null || ranked.length === 0) return null;
  const lines = [
    "以下为与本轮输入可能相关的知识库锚点（按相关度排序，格式：源文件#标题——摘要）。需要完整内容时用 Read 读取对应源文件；未列出的部分与本轮大概率无关。",
    ...diversifyKbAnchors(ranked).map(
      (entry) => `- ${entry.description ?? entry.filename}`,
    ),
  ];
  return lines.join("\n");
}
