import assert from "node:assert/strict";
import test from "node:test";
import {
  cosineSimilarity,
  fetchEmbeddings,
  fuseRecallScoresFull,
  readEmbeddingEndpointConfig,
} from "../src/memory/recall/embedding.js";

/**
 * 记忆召回 v2/v3（embedding 融合）测试：余弦、全量融合、分批请求、端点配置。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/memory-recall-embedding.test.ts
 */

test("余弦：同向=1，正交=0，零向量=0", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([], [1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

test("全量融合：词法零重叠条目被余弦救回（v3 的核心命题）", () => {
  const entries = [{ filename: "术语命中.md" }, { filename: "口语命中.md" }, { filename: "无关.md" }];
  // 词法：只有「术语命中」有分；「口语命中」零词法重叠（口语化提问场景）。
  const lexical = new Map([
    ["术语命中.md", 0.5],
    ["无关.md", 0.1],
  ]);
  const cosine = new Map([
    ["术语命中.md", 0.2],
    ["口语命中.md", 0.8],
    ["无关.md", 0.1],
  ]);
  const fused = fuseRecallScoresFull(entries, lexical, cosine);
  // 口语命中：0.4×0 + 0.6×0.8 = 0.48；术语命中：0.4×1 + 0.6×0.2 = 0.52
  assert.equal(fused[0]!.filename, "术语命中.md");
  assert.equal(fused[1]!.filename, "口语命中.md");
  assert.ok(Math.abs(fused[1]!.score - 0.48) < 1e-9);
  // 短名单重排形态下「口语命中」根本不进候选——这正是 v3 全量化的理由。
  assert.equal(fused[2]!.filename, "无关.md");
});

test("全量融合：余弦证据更强时可翻转词法排序", () => {
  const entries = [{ filename: "weak-lexical.md" }, { filename: "strong-lexical.md" }];
  const fused = fuseRecallScoresFull(
    entries,
    new Map([
      ["weak-lexical.md", 0.2],
      ["strong-lexical.md", 1.0],
    ]),
    new Map([
      ["weak-lexical.md", 1.0],
      ["strong-lexical.md", 0.0],
    ]),
  );
  assert.equal(fused[0]!.filename, "weak-lexical.md");
});

test("全量融合：词法全零时纯余弦排序（口语化提问、词法零命中）", () => {
  const entries = [{ filename: "a.md" }, { filename: "b.md" }];
  const fused = fuseRecallScoresFull(entries, new Map(), new Map([["b.md", 0.7]]));
  assert.equal(fused[0]!.filename, "b.md");
  assert.ok(Math.abs(fused[0]!.score - 0.7 * 0.6) < 1e-9);
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

test("fetchEmbeddings：超 64 条自动分批且顺序保持（智谱 1214 上限回归保护）", async () => {
  const batchSizes: number[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] };
    batchSizes.push(body.input.length);
    const data = body.input.map((_, i) => ({ embedding: [body.input.length, i], index: i }));
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  try {
    const texts = Array.from({ length: 130 }, (_, i) => `记忆条目${i}`);
    const vectors = await fetchEmbeddings(
      { url: "https://stub/embeddings", key: "k", model: "embedding-3" },
      texts,
    );
    // 130 条 → 64 + 64 + 2 三批
    assert.deepEqual(batchSizes, [64, 64, 2]);
    assert.equal(vectors.length, 130);
    // 顺序保持：向量 = [批大小, 批内序号]；第 65 条是第二批第 0 条
    assert.deepEqual(vectors[64], [64, 0]);
    assert.deepEqual(vectors[129], [2, 1]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchEmbeddings：端点非 200 抛错（调用方降级）", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  try {
    await assert.rejects(
      fetchEmbeddings({ url: "https://stub/embeddings" }, ["a"]),
      /embedding endpoint 401/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
