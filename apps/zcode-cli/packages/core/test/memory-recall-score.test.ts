import assert from "node:assert/strict";
import test from "node:test";
import { scoreMemoryEntries, tokenizeForRecall } from "../src/memory/recall/score.js";
import type { MemoryManifestEntry } from "../src/memory/recall/types.js";

/**
 * 记忆召回打分器测试：CJK 二元组 + 拉丁词混合打分，查询词元的覆盖率即得分。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/memory-recall-score.test.ts
 */

const entry = (filename: string, description: string): MemoryManifestEntry => ({
  filename,
  filePath: `memory/${filename}`,
  mtimeMs: 0,
  description,
});

test("CJK 二元组命中：相关记忆排在无关记忆之前", () => {
  const entries = [
    entry("bazi-geju.md", "八字格局大成：禄贵交驰等格局"),
    entry("liuyao-headache.md", "六爻测头疼健康的断法与用神"),
    entry("docker-deploy.md", "Docker 部署与 compose 配置"),
  ];
  const ranked = scoreMemoryEntries("六爻起卦分析头疼原因", entries);
  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0]!.entry.filename, "liuyao-headache.md");
  assert.ok(!ranked.some((r) => r.entry.filename === "docker-deploy.md"), "无关条目不应入榜");
});

test("拉丁词命中：大小写不敏感，短词（1 字符）不参与", () => {
  const entries = [
    entry("koffi-staging.md", "koffi native addon staging 修复记录"),
    entry("unrelated.md", "完全无关的条目"),
  ];
  const ranked = scoreMemoryEntries("KOFFI staging", entries);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.entry.filename, "koffi-staging.md");
});

test("无命中返回空数组（不注入）", () => {
  const ranked = scoreMemoryEntries("量子纠缠态", [
    entry("a.md", "docker compose"),
    entry("b.md", "rust ownership"),
  ]);
  assert.deepEqual(ranked, []);
});

test("空查询返回空数组", () => {
  assert.deepEqual(scoreMemoryEntries("", [entry("a.md", "任意")]), []);
});

test("topK 截断：命中多条时只保留前 K", () => {
  const entries = [
    entry("m1.md", "排盘 用神"),
    entry("m2.md", "排盘 忌神"),
    entry("m3.md", "排盘 大运"),
    entry("m4.md", "无关"),
  ];
  const ranked = scoreMemoryEntries("排盘 用神 忌神", entries, { topK: 2 });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0]!.entry.filename, "m1.md");
});

test("tokenize：CJK 二元组覆盖相邻字，拉丁词含内部连字符", () => {
  const tokens = tokenizeForRecall("六爻测头疼 koffi-staging v2");
  assert.ok(tokens.has("六爻"));
  assert.ok(tokens.has("爻测"));
  assert.ok(tokens.has("头疼"));
  assert.ok(tokens.has("koffi-staging"));
  assert.ok(tokens.has("v2"));
});
