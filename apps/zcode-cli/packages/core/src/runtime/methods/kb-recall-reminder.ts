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
const KB_TOP_K = 5;
/** kb 卡词法门槛：锚点 description 带路径词元更长，覆盖率天然稀释，放宽至 0.02。 */
const KB_LEXICAL_MIN_SCORE = 0.02;
/** kb 清单上限：与生成器护栏（8000）对齐——默认 200 会把数千卡语料截成
 * 「最新改动的 200 张」（对抗审查抓到），生产召回必须全量可见。 */
const KB_FILE_LIMIT = 8000;

export function kbCardsRootDir(workingDirectory: string): string {
  return join(workingDirectory, KB_CARDS_DIR);
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
    topK: KB_TOP_K,
    minScore: KB_LEXICAL_MIN_SCORE,
    fileLimit: KB_FILE_LIMIT,
  });
  if (ranked === null || ranked.length === 0) return null;
  const lines = [
    "以下为与本轮输入可能相关的知识库锚点（按相关度排序，格式：源文件#标题——摘要）。需要完整内容时用 Read 读取对应源文件；未列出的部分与本轮大概率无关。",
    ...ranked.map(
      (entry) => `- ${entry.description ?? entry.filename}`,
    ),
  ];
  return lines.join("\n");
}
