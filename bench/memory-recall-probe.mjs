#!/usr/bin/env node
// 记忆召回质量探针（命理语料）——回答「召回管线在我的命理工作负载下到底准不准」。
//
// 背景：召回打分只看 description+filename 的词法覆盖（score.ts），融合档在生产
// 里是对「词法 top-12 短名单」做余弦重排——口语化提问与记忆术语零词元重叠时，
// 正确条目可能根本进不了短名单，embedding 救不回来。本探针用两档难度量化：
//   A 档（术语直问）：查询含领域术语，词法应有基本盘；
//   B 档（口语转述）：用户嘴上的说法（老婆/惦记的人/卡在哪一步），与 description
//   零词元重叠——正是命理咨询的常态提问形态。
// 三种排序模式对比：
//   lexical         纯词法（无 embedding 配置时的生产形态）
//   fused-shortlist 词法 top-12 + 余弦重排（旧生产融合形态，已被 fused-full 取代；
//                   core 的 mergeRecallScores 已移除，此处内联保留仅作对照）
//   fused-full      全量条目 余弦×0.6 + 词法归一×0.4（v3 生产形态，core fuseRecallScoresFull）
//
// 语料两源：
//   fixture（默认）：内嵌合成命理语料 20 条——主题从真实记忆语料提炼、细节虚构
//     （公开 fork 不携带真实客户生辰/单号等 PII），结果可入库做基线。
//   live：--corpus <真实记忆目录> --queries <金标JSON>（金标含真实文件名，不入库）。
//
// 用法：
//   node --import tsx bench/memory-recall-probe.mjs                        # fixture，纯词法
//   node --import tsx bench/memory-recall-probe.mjs --embedding            # fixture，三档全跑
//   node --import tsx bench/memory-recall-probe.mjs --corpus <dir> --queries <file> --embedding --out <file>
// embedding 端点：--embedding-url/--embedding-key/--embedding-model 或
//   ZCODE_MEMORY_EMBEDDING_URL/KEY/MODEL（与生产同源，缺省 embedding-3）。

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
const CORPUS_DIR = argOf("--corpus", null);
const QUERIES_FILE = argOf("--queries", null);
const WANT_EMBEDDING = process.argv.includes("--embedding");
const OUT = argOf("--out", "bench/memory-recall-result.json");
const EMBEDDING_URL = argOf("--embedding-url", process.env.ZCODE_MEMORY_EMBEDDING_URL);
const EMBEDDING_KEY = argOf("--embedding-key", process.env.ZCODE_MEMORY_EMBEDDING_KEY);
const EMBEDDING_MODEL = argOf(
  "--embedding-model",
  process.env.ZCODE_MEMORY_EMBEDDING_MODEL || "embedding-3",
);
const LEXICAL_SHORTLIST = 12; // 生产 reminder 的词法短名单宽度
const TOP_K = 5; // 生产注入条数

// ── fixture：合成命理语料（主题提炼自真实记忆分布，细节虚构） ──
const FIXTURE_ENTRIES = [
  {
    filename: "guishen-tiqu.md",
    description:
      "六爻鬼神断原典提取入库——276页OCR完成，「已/己」形近字是最大陷阱，爻位所属初家亲/二土地/三外鬼/四黄仙/五天地/六神佛",
  },
  {
    filename: "paixi-jiangyi.md",
    description: "新派系讲义上下册完整提取——独立体系零重复，接入方案已设计待批准",
  },
  {
    filename: "sanhe-xieyi.md",
    description: "三式合参协议v1落地——起局器+协议+护栏测试全绿，穿=协议扩展非符号互译",
  },
  {
    filename: "taiyi-anli.md",
    description: "太乙神数技能五源入库——334案例+5400断言+353测试绿，命盘十二宫+日计九法",
  },
  {
    filename: "qizheng-bench.md",
    description: "七政四余695案例bench收官——机械谓词全null诚实记录，三处真bug根修",
  },
  {
    filename: "koujing-caijue.md",
    description: "数字预测口径用户裁决——以主典为准：6=牢/四正{1,4,7,10}/大运正序20年，勿再翻案",
  },
  {
    filename: "sihua-koujing.md",
    description: "紫微十天干四化庚/壬两干口径定案——庚阳武阴同、壬梁紫左武，原典两诀为版本异读",
  },
  {
    filename: "genxiu-siwang.md",
    description:
      "八字死亡考卷根修四连——十干死墓绝全表构造+生日库四柱指纹键+歧义年判例，「不可修复」结论被推翻",
  },
  {
    filename: "zhunzhun-gongcheng.md",
    description:
      "八字准确度工程——124例考卷+18触发器，三层合断80.0%(+34.5pp)+四柱反查生日72.7%+阴性对照",
  },
  {
    filename: "tiqu-zhiliang.md",
    description:
      "原书提取质量监控流程——试提6页+视觉对照+噪声清理三模式（水印/目录导线杂字符/页眉误植重复标题）",
  },
  {
    filename: "zhineng-tixi.md",
    description: "命理智能体总体架构定论——三网关+智能体内核，通用RAG模式被四个命理器官替换",
  },
  {
    filename: "jifei-koujing.md",
    description:
      "命理技能LLM调用计费口径查证——套餐仅限指定工具，脚本外呼按量扣费实证；embedding本地Ollama零费用",
  },
  {
    filename: "xiezuo-fengge.md",
    description: "用户工作风格——对抗性质疑推动深度、验收只看交付文件、客户文本要小白大白话",
  },
  {
    filename: "yijing-koujing.md",
    description: "用户已婚自述——夫妻宫/桃花/添丁类信号对本人必须按已婚口径读",
  },
  {
    filename: "dingdan-daijiao.md",
    description: "A2订单交付——报告v5终版18172字五轮审查，待外行审读后正式交付",
  },
  {
    filename: "anli-qimen.md",
    description:
      "巳时女奇门命盘案例——阴遁六局八门伏吟·日干乾宫困龙被伤·年命空亡·流年判读与应期锚点待回填",
  },
  {
    filename: "anli-caifu.md",
    description: "卯时男紫微盘财富真值回填——资产已过亿·爆发应在大限35-44·45-54廉破限=证伪窗口",
  },
  {
    filename: "anli-yinyuan.md",
    description:
      "六爻双卦案——心中所想女生(无名)既济变蹇断无关联可放下+报数卦大过变夬断有关联难成正果",
  },
  {
    filename: "anli-zhichang.md",
    description: "亥时女职场冲突+父母因果六爻案——官鬼伏父母下断祖上横亡失祀，回填点三个待验证",
  },
  {
    filename: "touxiang-jiaoxun.md",
    description: "头像分析必须先确认分析对象是谁——马图案例把别人的头像错按用户自己生肖跑了引擎",
  },
];

const FIXTURE_QUERIES = [
  // A 档：术语直问
  { id: "q01", tier: "A", text: "六爻看鬼神的原典提取得怎么样了", gold: "guishen-tiqu.md" },
  { id: "q02", tier: "A", text: "三式合参的协议定稿了吗", gold: "sanhe-xieyi.md" },
  { id: "q03", tier: "A", text: "太乙神数案例库规模有多大", gold: "taiyi-anli.md" },
  { id: "q04", tier: "A", text: "七政四余bench最后收敛到什么结论", gold: "qizheng-bench.md" },
  { id: "q05", tier: "A", text: "数字预测的口径之争最后怎么裁的", gold: "koujing-caijue.md" },
  { id: "q06", tier: "A", text: "紫微四化庚干壬干用哪套口诀", gold: "sihua-koujing.md" },
  { id: "q07", tier: "A", text: "八字死亡考卷那几个根因修掉了什么", gold: "genxiu-siwang.md" },
  { id: "q08", tier: "A", text: "八字准确度工程最后提了多少分", gold: "zhunzhun-gongcheng.md" },
  { id: "q09", tier: "A", text: "提取原书之前为什么要先试提几页", gold: "tiqu-zhiliang.md" },
  { id: "q10", tier: "A", text: "命理智能体的架构最后怎么定的", gold: "zhineng-tixi.md" },
  // B 档：口语转述（与 description 零/极低词元重叠）
  { id: "q11", tier: "B", text: "我心里惦记的那个人到底能不能成", gold: "anli-yinyuan.md" },
  { id: "q12", tier: "B", text: "资产上亿那位45岁以后怎么看", gold: "anli-caifu.md" },
  { id: "q13", tier: "B", text: "我老婆的事在盘里怎么读", gold: "yijing-koujing.md" },
  { id: "q14", tier: "B", text: "还没给客户的那份东西卡在哪一步", gold: "dingdan-daijiao.md" },
  { id: "q15", tier: "B", text: "看图之前得先问清楚什么", gold: "touxiang-jiaoxun.md" },
  { id: "q16", tier: "B", text: "给小白写东西要注意什么", gold: "xiezuo-fengge.md" },
];

// entryText 与 score.ts 的 entryText 同面（description+filename+type）。
function entryTextOf(entry) {
  return [entry.description ?? "", entry.filename ?? "", entry.type ?? ""].join(" ");
}

function loadLiveCorpus(dir) {
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
  // 与 scanMemoryManifest 同口径：mtime 新→旧，截 200 条。
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 200);
}

/** 词法全量分（不带 topK/minScore 截断；零重叠=0 分）。 */
function lexicalScoresFull(query, entries) {
  const ranked = scoreMemoryEntries(query, entries, { topK: entries.length, minScore: 0 });
  const byName = new Map(ranked.map((r) => [r.entry.filename, r.score]));
  return entries.map((e) => ({ filename: e.filename, score: byName.get(e.filename) ?? 0 }));
}

function rankOf(ranked, gold) {
  const idx = ranked.findIndex((r) => r.filename === gold);
  return idx < 0 ? Infinity : idx + 1;
}

function evalTier(rows) {
  const n = rows.length || 1;
  const at = (k) => rows.filter((r) => r.rank <= k).length;
  const mrr = rows.reduce((s, r) => s + (r.rank === Infinity ? 0 : 1 / r.rank), 0);
  return {
    n: rows.length,
    hitAt1: `${((at(1) / n) * 100).toFixed(0)}%`,
    hitAt3: `${((at(3) / n) * 100).toFixed(0)}%`,
    hitAt5: `${((at(5) / n) * 100).toFixed(0)}%`,
    mrr: Number((mrr / n).toFixed(2)),
  };
}

async function main() {
  const live = CORPUS_DIR !== null;
  const entries = live
    ? loadLiveCorpus(CORPUS_DIR)
    : FIXTURE_ENTRIES.map((e, i) => ({
        ...e,
        filePath: e.filename,
        mtimeMs: FIXTURE_ENTRIES.length - i,
      }));
  const queries = live ? JSON.parse(readFileSync(QUERIES_FILE, "utf8")) : FIXTURE_QUERIES;
  const missing = queries.filter((q) => !entries.some((e) => e.filename === q.gold));
  const valid = queries.filter((q) => entries.some((e) => e.filename === q.gold));
  if (missing.length > 0)
    console.log(
      `[skip] ${missing.length} 条金标不在语料中（语料演化正常现象）：${missing.map((q) => q.id).join(",")}`,
    );
  console.log(
    `== 记忆召回质量探针 ==\n语料: ${live ? `live(${entries.length}条)` : `fixture(${entries.length}条)`}  查询: ${valid.length} 条（A/B 两档）  embedding: ${WANT_EMBEDDING ? EMBEDDING_MODEL : "关"}\n`,
  );

  // ── 模式一：纯词法（生产无 embedding 配置时的形态） ──
  const modes = {
    lexical: valid.map((q) => ({
      id: q.id,
      tier: q.tier,
      rank: rankOf(
        scoreMemoryEntries(q.text, entries, { topK: TOP_K }).map((r) => r.entry),
        q.gold,
      ),
    })),
  };

  // ── 模式二/三：融合档 ──
  if (WANT_EMBEDDING) {
    if (!EMBEDDING_URL)
      throw new Error("--embedding 需要 --embedding-url 或 ZCODE_MEMORY_EMBEDDING_URL");
    const endpoint = { url: EMBEDDING_URL, key: EMBEDDING_KEY, model: EMBEDDING_MODEL };
    const entryVecs = await fetchEmbeddings(endpoint, entries.map(entryTextOf));
    const queryVecs = await fetchEmbeddings(
      endpoint,
      valid.map((q) => q.text),
    );
    modes["fused-shortlist"] = valid.map((q, qi) => {
      const cosines = new Map(
        entries.map((e, i) => [e.filename, cosineSimilarity(queryVecs[qi], entryVecs[i])]),
      );
      const shortlist = scoreMemoryEntries(q.text, entries, { topK: LEXICAL_SHORTLIST });
      // 与生产 reminder 同构：短名单内 余弦×0.6 + 词法归一×0.4 重排。
      const maxLex = Math.max(0, ...shortlist.map((r) => r.score));
      const reranked = shortlist
        .map((r) => ({
          filename: r.entry.filename,
          score:
            (maxLex > 0 ? r.score / maxLex : 0) * 0.4 + (cosines.get(r.entry.filename) ?? 0) * 0.6,
        }))
        .sort((a, b) => b.score - a.score);
      return { id: q.id, tier: q.tier, rank: rankOf(reranked, q.gold) };
    });
    modes["fused-full"] = valid.map((q, qi) => {
      const cosines = new Map(
        entries.map((e, i) => [e.filename, cosineSimilarity(queryVecs[qi], entryVecs[i])]),
      );
      const lex = lexicalScoresFull(q.text, entries);
      const lexByName = new Map(lex.map((r) => [r.filename, r.score]));
      // 与生产 reminder 同源（core fuseRecallScoresFull），杜绝探针/生产口径漂移。
      const fused = fuseRecallScoresFull(entries, lexByName, cosines);
      return { id: q.id, tier: q.tier, rank: rankOf(fused, q.gold) };
    });
  }

  // ── 汇总输出 ──
  const summary = {};
  for (const [mode, rows] of Object.entries(modes)) {
    summary[mode] = {
      A: evalTier(rows.filter((r) => r.tier === "A")),
      B: evalTier(rows.filter((r) => r.tier === "B")),
      overall: evalTier(rows),
    };
    const s = summary[mode];
    console.log(
      `[${mode}]  A档 hit@1/3/5=${s.A.hitAt1}/${s.A.hitAt3}/${s.A.hitAt5} MRR=${s.A.mrr}   B档=${s.B.hitAt1}/${s.B.hitAt3}/${s.B.hitAt5} MRR=${s.B.mrr}`,
    );
  }
  // B 档逐条明细（穿透分析用）
  if (modes.lexical) {
    const bad = modes.lexical.filter((r) => r.tier === "B" && r.rank > TOP_K);
    if (bad.length > 0)
      console.log(
        `\n[lexical-B档失败明细] ${bad.map((r) => `${r.id}(rank=${r.rank === Infinity ? "∞" : r.rank})`).join(" ")}`,
      );
  }

  const out = {
    ranAt: new Date().toISOString(),
    corpus: live ? `live:${entries.length}` : `fixture:${entries.length}`,
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
