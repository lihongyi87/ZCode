import type { MemoryManifestEntry } from "./types.js";

/**
 * 记忆清单相关性打分（纯函数，无外部依赖）。
 *
 * 现状：记忆清单按 mtime 全量注入，模型注意力要自己在一长串文件名里挑相关项。
 * 本模块按「本轮用户输入 ↔ 记忆摘要」的词法重叠度对清单排序——查询分词为
 * CJK 二元组 + 拉丁/数字词，命中比例即得分。刻意不用 embedding：
 * 单用户几百条记忆，词法打分已是零成本、零依赖、确定性可测的第一档；
 * 向量召回作为 v2 增强（接口已按可插拔预留：换掉 scoreOne 即可）。
 */

export interface ScoredMemoryEntry {
  entry: MemoryManifestEntry;
  score: number;
}

export interface ScoreMemoryOptions {
  /** 返回条数上限（默认 5）。 */
  topK?: number;
  /** 最低分阈值：低于此值的条目不注入（默认 0.1）。 */
  minScore?: number;
}

/** CJK 范围（含扩展A）+ 拉丁/数字词。 */
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const WORD = /[a-z0-9_][a-z0-9_\-]*/i;

/** 查询/条目文本 → 词元集：CJK 相邻二元组 + 拉丁小写词（≥2 字符）。 */
export function tokenizeForRecall(text: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = (text ?? "").toLowerCase();
  const latin = normalized.match(/[a-z0-9_][a-z0-9_\-]+/gi) ?? [];
  for (const word of latin) tokens.add(word);
  const cjk = Array.from(normalized).filter((ch) => CJK_CHAR.test(ch));
  for (let i = 0; i + 1 < cjk.length; i += 1) tokens.add(cjk[i] + cjk[i + 1]);
  return tokens;
}

/** 条目参与匹配的文本面：描述权重最高的直觉用拼接实现，由打分统一度量。 */
function entryText(entry: MemoryManifestEntry): string {
  return [entry.description ?? "", entry.filename ?? "", entry.type ?? ""].join(" ");
}

export function scoreMemoryEntries(
  query: string,
  entries: readonly MemoryManifestEntry[],
  options: ScoreMemoryOptions = {},
): ScoredMemoryEntry[] {
  const topK = options.topK ?? 5;
  const minScore = options.minScore ?? 0.1;
  const queryTokens = tokenizeForRecall(query);
  if (queryTokens.size === 0 || entries.length === 0) return [];

  const scored: ScoredMemoryEntry[] = [];
  for (const entry of entries) {
    const entryTokens = tokenizeForRecall(entryText(entry));
    if (entryTokens.size === 0) continue;
    // 打分口径 = 条目覆盖率（查询命中的条目词元 / 条目词元总数），分母与查询
    // 长度无关——长提问（命理咨询常带大段背景）不会稀释得分；条目越被查询
    // 「覆盖」越相关。查询侧只要求至少命中一个条目词元。
    let matched = 0;
    for (const token of entryTokens) {
      if (queryTokens.has(token)) matched += 1;
    }
    const score = matched / entryTokens.size;
    if (matched > 0 && score >= minScore) scored.push({ entry, score });
  }
  scored.sort(
    (left, right) => right.score - left.score || right.entry.mtimeMs - left.entry.mtimeMs,
  );
  return scored.slice(0, topK);
}
