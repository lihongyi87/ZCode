/**
 * 记忆召回 v2/v3：embedding 向量召回与词法打分的全量融合。
 *
 * 配置（环境变量，全部缺席 = 纯词法档，静默降级）：
 * - ZCODE_MEMORY_EMBEDDING_URL    embedding 端点（OpenAI 兼容 POST {input, model}）
 * - ZCODE_MEMORY_EMBEDDING_KEY    Bearer 密钥
 * - ZCODE_MEMORY_EMBEDDING_MODEL  模型名（默认 embedding-3，智谱）
 *
 * 设计约束（OWB/Hermes 同款）：单用户几百条记忆，不引向量库——批量取向量 +
 * 内存余弦暴力扫即最优；向量按条目缓存（mtime+描述变更才重算）；任何失败
 * （无配置/网络/解析）一律静默退回纯词法——召回是增强，不是功能依赖。
 */

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * 全量融合（v3 架构，2026-10-02 bench 实证）：对**全部**条目做
 * 余弦×cosineWeight + 归一化词法×(1-cosineWeight)，词法零重叠条目按词法 0 分参与。
 *
 * 为什么不是「词法短名单内重排」：命理语料 bench（bench/memory-recall-probe.mjs）
 * 实测口语化提问与记忆 description 零词元重叠——词法看不见的条目，短名单重排
 * 永远救不回（72 条真实语料 B 档 hit@5：词法 0%、短名单重排 0%、全量融合 100%）。
 * 短名单形态的 mergeRecallScores 已据此移除。
 */
export interface FusionCandidate {
  filename: string;
}

export function fuseRecallScoresFull(
  entries: readonly FusionCandidate[],
  lexicalScoreByFilename: ReadonlyMap<string, number>,
  cosineByFilename: ReadonlyMap<string, number>,
  cosineWeight = 0.6,
): Array<{ filename: string; score: number }> {
  let maxLexical = 0;
  for (const value of lexicalScoreByFilename.values()) {
    if (value > maxLexical) maxLexical = value;
  }
  return entries
    .map((entry) => {
      const lexical = lexicalScoreByFilename.get(entry.filename) ?? 0;
      const lexicalNorm = maxLexical > 0 ? lexical / maxLexical : 0;
      const cosine = cosineByFilename.get(entry.filename) ?? 0;
      return { filename: entry.filename, score: lexicalNorm * (1 - cosineWeight) + cosine * cosineWeight };
    })
    .sort((left, right) => right.score - left.score);
}

export interface EmbeddingEndpointConfig {
  url: string;
  key?: string;
  model?: string;
}

export function readEmbeddingEndpointConfig(
  env: Record<string, string | undefined> = process.env,
): EmbeddingEndpointConfig | null {
  const url = env.ZCODE_MEMORY_EMBEDDING_URL?.trim();
  if (!url) return null;
  return {
    url,
    key: env.ZCODE_MEMORY_EMBEDDING_KEY?.trim() || undefined,
    model: env.ZCODE_MEMORY_EMBEDDING_MODEL?.trim() || "embedding-3",
  };
}

/** 智谱 embedding-3 的 input 数组单请求上限（超出返回 400/code 1214）。 */
export const EMBEDDING_BATCH_LIMIT = 64;

export interface FetchEmbeddingsOptions {
  /** 传递给每个分批 fetch 的中止信号（调用方做整体预算时用）。 */
  signal?: AbortSignal;
}

/** OpenAI 兼容批量 embedding 请求；失败抛错由调用方降级。
 * 超过单请求条数上限时自动分批，结果按输入顺序拼接（调用方无感）。 */
export async function fetchEmbeddings(
  endpoint: EmbeddingEndpointConfig,
  texts: readonly string[],
  options: FetchEmbeddingsOptions = {},
): Promise<number[][]> {
  const chunks: string[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_LIMIT) {
    chunks.push(texts.slice(i, i + EMBEDDING_BATCH_LIMIT) as string[]);
  }
  const vectors: number[][] = [];
  for (const chunk of chunks) {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(endpoint.key ? { authorization: `Bearer ${endpoint.key}` } : {}),
      },
      body: JSON.stringify({ model: endpoint.model, input: chunk }),
      signal: options.signal,
    });
    if (!res.ok) throw new Error(`embedding endpoint ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ embedding: number[]; index?: number }> };
    const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== chunk.length) throw new Error("embedding count mismatch");
    vectors.push(...data.map((item) => item.embedding));
  }
  return vectors;
}
