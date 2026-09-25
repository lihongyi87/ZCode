import type { ScoredMemoryEntry } from "./score.js";

/**
 * 记忆召回 v2：embedding 向量排序与词法打分的融合。
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

/** 词法分数归一化（除以最大值）后与余弦按 0.4/0.6 加权融合；无向量条目保留词法。 */
export function mergeRecallScores(
  lexical: readonly ScoredMemoryEntry[],
  cosineByFilename: ReadonlyMap<string, number>,
  cosineWeight = 0.6,
): ScoredMemoryEntry[] {
  // 词法分数已经过覆盖率计算（score）；此处归一化后与余弦加权融合。
  const maxLexical = lexical.reduce((max, item) => Math.max(max, item.score), 0);
  return lexical
    .map((item) => {
      const lexicalNorm = maxLexical > 0 ? item.score / maxLexical : 0;
      const cosine = cosineByFilename.get(item.entry.filename);
      const score =
        cosine === undefined
          ? lexicalNorm
          : lexicalNorm * (1 - cosineWeight) + cosine * cosineWeight;
      return { entry: item.entry, score };
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

/** OpenAI 兼容批量 embedding 请求；失败抛错由调用方降级。 */
export async function fetchEmbeddings(
  endpoint: EmbeddingEndpointConfig,
  texts: readonly string[],
): Promise<number[][]> {
  const res = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(endpoint.key ? { authorization: `Bearer ${endpoint.key}` } : {}),
    },
    body: JSON.stringify({ model: endpoint.model, input: texts }),
  });
  if (!res.ok) throw new Error(`embedding endpoint ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ embedding: number[]; index?: number }> };
  const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (data.length !== texts.length) throw new Error("embedding count mismatch");
  return data.map((item) => item.embedding);
}
