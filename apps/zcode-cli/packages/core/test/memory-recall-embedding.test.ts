import assert from "node:assert/strict";
import test from "node:test";
import {
  cosineSimilarity,
  mergeRecallScores,
  readEmbeddingEndpointConfig,
} from "../src/memory/recall/embedding.js";
import type { MemoryManifestEntry } from "../src/memory/recall/types.js";

/**
 * 记忆召回 v2（embedding 融合）测试：余弦、加权融合、端点配置解析与降级。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/memory-recall-embedding.test.ts
 */

const entry = (filename: string, description: string): MemoryManifestEntry => ({
  filename,
  filePath: `memory/${filename}`,
  mtimeMs: 0,
  description,
});

test("余弦：同向=1，正交=0，零向量=0", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([], [1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

test("融合：余弦权重 0.6 + 归一化词法 0.4", () => {
  const lexical = [
    { entry: entry("a.md", "排盘"), score: 1.0 },
    { entry: entry("b.md", "排盘相关次之"), score: 0.5 },
  ];
  const merged = mergeRecallScores(
    lexical,
    new Map([
      ["a.md", 1],
      ["b.md", 0],
    ]),
  );
  // a: 0.4×1 + 0.6×1 = 1.0；b: 0.4×0.5 + 0.6×0 = 0.2
  assert.equal(merged[0]!.entry.filename, "a.md");
  assert.ok(Math.abs(merged[0]!.score - 1) < 1e-9);
  assert.ok(Math.abs(merged[1]!.score - 0.2) < 1e-9);
});

test("无向量条目保留纯词法归一值", () => {
  const lexical = [
    { entry: entry("a.md", "排盘"), score: 1.0 },
    { entry: entry("b.md", "排盘次之"), score: 0.5 },
  ];
  const merged = mergeRecallScores(lexical, new Map());
  assert.ok(Math.abs(merged[0]!.score - 1) < 1e-9);
  assert.ok(Math.abs(merged[1]!.score - 0.5) < 1e-9);
});

test("融合可翻转词法排序（余弦证据更强时）", () => {
  const lexical = [
    { entry: entry("weak-lexical.md", "x"), score: 0.2 },
    { entry: entry("strong-lexical.md", "y"), score: 1.0 },
  ];
  const merged = mergeRecallScores(
    lexical,
    new Map([
      ["weak-lexical.md", 1.0],
      ["strong-lexical.md", 0.0],
    ]),
  );
  assert.equal(merged[0]!.entry.filename, "weak-lexical.md");
});

test("端点配置：无 URL 返回 null（纯词法降级）", () => {
  assert.equal(readEmbeddingEndpointConfig({}), null);
  assert.equal(readEmbeddingEndpointConfig({ ZCODE_MEMORY_EMBEDDING_URL: " " }), null);
  const cfg = readEmbeddingEndpointConfig({
    ZCODE_MEMORY_EMBEDDING_URL: "https://open.bigmodel.cn/api/paas/v4/embeddings",
    ZCODE_MEMORY_EMBEDDING_KEY: "k1",
  });
  assert.equal(cfg?.model, "embedding-3");
  assert.equal(cfg?.key, "k1");
});
