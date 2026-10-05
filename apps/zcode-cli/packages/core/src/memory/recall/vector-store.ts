import { dirname, join } from "node:path";

/**
 * 向量盘档缓存（P7，kb_recall 规模化前置）。
 *
 * vectorCache 是进程内 WeakMap，会话重启全量重暖；语料从 73 条记忆扩到
 * 2547+ 知识卡（约 35×）后，64 条/批×2.5s 预算需数十轮才暖满。盘档按
 * 「corpus 根 × embedding 模型」分文件存派生向量（非知识副本，合铁律5.8），
 * 键沿用 vectorCacheKey（filename+mtime+description），内容变更自动失效。
 *
 * 序列化用 Float32×base64：2048 维一条 ≈11KB，比 JSON 数组省 ~4×；
 * float32 舍入对余弦的影响 <1e-6 量级，召回排序无感。
 */

const FILE_PREFIX = ".vector-cache";

export interface PersistedVectorFile {
  version: 1;
  /** 生成向量的 embedding 模型名（换模型即换文件，天然隔离）。 */
  model: string;
  /** cacheKey → base64(Float32Array little-endian)。 */
  vectors: Record<string, string>;
}

/** 模型名里的路径不安全字符折叠成下划线。 */
function safeModelId(model: string): string {
  return model.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48) || "default";
}

/** 盘档文件路径：<memoryRoot 上级目录>/.vector-cache.<model>.json。 */
export function vectorStorePath(memoryRoot: string, model: string): string {
  return join(dirname(memoryRoot), `${FILE_PREFIX}.${safeModelId(model)}.json`);
}

/** 一条向量 → base64(Float32 LE)。空向量返回空串。 */
export function encodeVector(vector: readonly number[]): string {
  if (vector.length === 0) return "";
  const buffer = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) buffer[i] = vector[i]!;
  return Buffer.from(buffer.buffer, 0, buffer.byteLength).toString("base64");
}

/** base64(Float32 LE) → 向量；坏输入返回 null（调用方按未缓存处理）。 */
export function decodeVector(encoded: string): number[] | null {
  if (!encoded) return null;
  try {
    const buffer = Buffer.from(encoded, "base64");
    if (buffer.byteLength === 0 || buffer.byteLength % 4 !== 0) return null;
    const floats = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength / 4,
    );
    return Array.from(floats);
  } catch {
    return null;
  }
}

/** 解析盘档 JSON；版本/结构不符返回空 store（按未缓存处理，静默重算）。 */
export function parseVectorStoreFile(text: string, model: string): PersistedVectorFile {
  try {
    const parsed = JSON.parse(text) as Partial<PersistedVectorFile>;
    if (parsed?.version !== 1 || parsed.model !== model || typeof parsed.vectors !== "object" || parsed.vectors === null) {
      return { version: 1, model, vectors: {} };
    }
    return { version: 1, model, vectors: parsed.vectors };
  } catch {
    return { version: 1, model, vectors: {} };
  }
}
