#!/usr/bin/env node
// 知识卡召回探针（P1 kb_recall，live 语料：F:\智能体\.zcode\kb-cards）。
//
// 回答「一次语义召回能不能替代三层人肉路由+grep 找知识」：
//   A 档 术语直问（query 含领域词，词法应有基本盘）
//   B 档 口语转述（用户嘴上的问法，与卡面零词元重叠，只有余弦能救）
// 模式：lexical（离线确定性）/ fused（embedding 全量融合，走 core 正身
// fuseRecallScoresFull，与生产 kb_recall 同源）。
//
// 用法：
//   node --import tsx bench/kb-recall-probe.mjs                       # 纯词法
//   node --import tsx bench/kb-recall-probe.mjs --embedding --embedding-url <url>
// 产物：bench/kb-recall-result.json（只含聚合计分与逐题 rank，不含金标路径——
// 金标本体在 gitignore 的 bench/.kb-recall-queries.json 里）。

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { scoreMemoryEntries } from "../apps/zcode-cli/packages/core/src/memory/recall/score.ts";
import {
  cosineSimilarity,
  fetchEmbeddings,
  fuseRecallScoresFull,
} from "../apps/zcode-cli/packages/core/src/memory/recall/embedding.ts";
import { parseMemoryFrontmatter } from "../apps/zcode-cli/packages/core/src/memory/recall/manifest.ts";

const argOf = (n, f) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : f;
};
const CARDS_DIR = argOf("--cards", "F:/智能体/.zcode/kb-cards");
const QUERIES_FILE = argOf("--queries", "bench/.kb-recall-queries.json");
const WANT_EMBEDDING = process.argv.includes("--embedding");
const EMBEDDING_URL = argOf("--embedding-url", process.env.ZCODE_MEMORY_EMBEDDING_URL);
const EMBEDDING_KEY = argOf("--embedding-key", process.env.ZCODE_MEMORY_EMBEDDING_KEY);
const EMBEDDING_MODEL = argOf("--embedding-model", "embedding-3");
const OUT = argOf("--out", "bench/kb-recall-result.json");
const KB_LEXICAL_MIN_SCORE = 0.02; // 与生产 kb-recall-reminder 同值
const TOP_K = 5;

function loadCards(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || name === "MEMORY.md") continue;
    const filePath = `${dir}/${name}`;
    const head = readFileSync(filePath, "utf8").split("\n", 30).join("\n");
    const fm = parseMemoryFrontmatter(head);
    entries.push({
      description: fm.description,
      type: fm.type,
      filename: name,
      filePath,
      mtimeMs: statSync(filePath).mtimeMs,
    });
  }
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 24000); // 与生产 KB_FILE_LIMIT 对齐（默认 200 是 memory 档专用）
}

const entryTextOf = (e) => [e.description ?? "", e.filename ?? "", e.type ?? ""].join(" ");

function rankOf(descriptions, gold) {
  const idx = descriptions.findIndex((d) => d.includes(gold));
  return idx < 0 ? Infinity : idx + 1;
}

/** 文件级口径：top-K 内有任一张卡来自 gold 所在源文件（锚点= description 的
 * 路径前缀，即 gold 去掉 # 之后的部分）。 */
function fileRankOf(descriptions, gold) {
  const filePart = gold.includes("#") ? gold.split("#")[0] : gold;
  const idx = descriptions.findIndex((d) => d.includes(filePart));
  return idx < 0 ? Infinity : idx + 1;
}

function evalTier(rows) {
  const n = rows.length || 1;
  const at = (k, field) => rows.filter((r) => r[field] <= k).length;
  const mrr = rows.reduce((s, r) => s + (r.rank === Infinity ? 0 : 1 / r.rank), 0);
  return {
    n: rows.length,
    hitAt1: `${((at(1, "rank") / n) * 100).toFixed(0)}%`,
    hitAt3: `${((at(3, "rank") / n) * 100).toFixed(0)}%`,
    hitAt5: `${((at(5, "rank") / n) * 100).toFixed(0)}%`,
    fileHitAt5: `${((at(5, "fileRank") / n) * 100).toFixed(0)}%`,
    mrr: Number((mrr / n).toFixed(2)),
  };
}

async function main() {
  const entries = loadCards(CARDS_DIR);
  const queries = JSON.parse(readFileSync(resolve(QUERIES_FILE), "utf8"));
  console.log(
    `== 知识卡召回探针 ==\n语料: ${entries.length} 卡  查询: ${queries.length}  embedding: ${WANT_EMBEDDING ? EMBEDDING_MODEL : "关"}\n`,
  );

  const modes = {};
  modes.lexical = queries.map((q) => {
    const descs = scoreMemoryEntries(q.text, entries, {
      topK: TOP_K,
      minScore: KB_LEXICAL_MIN_SCORE,
    }).map((r) => entryTextOf(r.entry));
    return {
      id: q.id,
      tier: q.tier,
      rank: rankOf(descs, q.gold),
      fileRank: fileRankOf(descs, q.gold),
    };
  });

  if (WANT_EMBEDDING) {
    if (!EMBEDDING_URL) throw new Error("--embedding 需要 --embedding-url");
    const endpoint = { url: EMBEDDING_URL, key: EMBEDDING_KEY, model: EMBEDDING_MODEL };
    const entryVecs = await fetchEmbeddings(endpoint, entries.map(entryTextOf));
    const queryVecs = await fetchEmbeddings(
      endpoint,
      queries.map((q) => q.text),
    );
    modes.fused = queries.map((q, qi) => {
      const lexRanked = scoreMemoryEntries(q.text, entries, { topK: entries.length, minScore: 0 });
      const lexByName = new Map(lexRanked.map((r) => [r.entry.filename, r.score]));
      const cosines = new Map(
        entries.map((e, i) => [e.filename, cosineSimilarity(queryVecs[qi], entryVecs[i])]),
      );
      const fused = fuseRecallScoresFull(entries, lexByName, cosines);
      const descByName = new Map(entries.map((e) => [e.filename, entryTextOf(e)]));
      const descs = fused.slice(0, TOP_K).map((f) => descByName.get(f.filename) ?? "");
      return {
        id: q.id,
        tier: q.tier,
        rank: rankOf(descs, q.gold),
        fileRank: fileRankOf(descs, q.gold),
      };
    });
  }

  const summary = {};
  for (const [mode, rows] of Object.entries(modes)) {
    summary[mode] = {
      A: evalTier(rows.filter((r) => r.tier === "A")),
      B: evalTier(rows.filter((r) => r.tier === "B")),
      overall: evalTier(rows),
    };
    const s = summary[mode];
    console.log(
      `[${mode}]  A档 hit@1/3/5=${s.A.hitAt1}/${s.A.hitAt3}/${s.A.hitAt5}   B档=${s.B.hitAt1}/${s.B.hitAt3}/${s.B.hitAt5}   overall=${s.overall.hitAt5}`,
    );
  }

  const out = {
    ranAt: new Date().toISOString(),
    corpus: `kb-live:${entries.length}`,
    embedding: WANT_EMBEDDING ? EMBEDDING_MODEL : null,
    summary,
    perQuery: Object.fromEntries(
      Object.entries(modes).map(([m, rows]) => [
        m,
        rows.map((r) => ({ id: r.id, tier: r.tier, rank: r.rank === Infinity ? null : r.rank })),
      ]),
    ),
  };
  writeFileSync(pathToFileURL(resolve(OUT)), JSON.stringify(out, null, 2));
  console.log(`\n已写 ${OUT}`);
}

main().catch((e) => {
  console.error("probe 异常:", e);
  process.exit(1);
});
