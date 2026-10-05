import type { FileSystemPort } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { modelMessageContentToText } from "../deps.js";
import { scanMemoryManifest } from "../../memory/recall/index.js";
import { scoreMemoryEntries } from "../../memory/recall/score.js";
import {
  cosineSimilarity,
  EMBEDDING_BATCH_LIMIT,
  fetchEmbeddings,
  fuseRecallScoresFull,
  readEmbeddingEndpointConfig,
} from "../../memory/recall/embedding.js";
import {
  decodeVector,
  encodeVector,
  parseVectorStoreFile,
  vectorStorePath,
  type PersistedVectorFile,
} from "../../memory/recall/vector-store.js";
import type { MemoryManifestEntry } from "../../memory/recall/types.js";

/**
 * 记忆召回提醒的构建（turn 级，吸收 Hermes 的 prefetch 模式）。
 *
 * 每轮用户输入落定后：对记忆清单按「本轮输入 ↔ 条目摘要」做相关性排序，
 * top-K 以 system-reminder 注入本轮请求——模型看到的是「可能与本轮相关的少量
 * 记忆 + 精确路径」，而不是全量索引；需要细节时用 Read 精确重取。
 *
 * v3 全量融合（2026-10-02 命理语料 bench 实证，bench/memory-recall-probe.mjs）：
 * embedding 端点已配置时对**全部**条目做 余弦×0.6+归一化词法×0.4——口语化提问
 * 与记忆术语零词元重叠时（「我老婆的事」vs「用户已婚……夫妻宫口径」，B 档
 * hit@5 词法 0%），短名单重排永远救不回；72 条真实语料实测全量融合 A/B 双档
 * hit@5 100%。词法档（无 embedding 配置）行为不变。向量按条目缓存
 * （filename+mtime+description 变更才重算），逐轮增量补缺。
 *
 * 与缓存的关系（刻意为之）：提醒是 per-request 附件，只出现在本轮尾部，
 * 不改写历史前缀——已写入的 prompt cache 不受影响；缓存稳定性检测器也不会
 * 把它报成前缀变异。
 *
 * 清单扫描按 runtime 缓存 60s（扫描要读最多 200 个文件的 frontmatter，
 * 逐轮全扫是纯浪费）；失败降级为无召回，绝不阻塞 turn。
 */

const SCAN_TTL_MS = 60_000;
const TOP_K = 5;
/**
 * 语义档注入底线（仅词法零命中时生效）：余弦低于此值视为不相关，不注入。
 * 校准依据（72 条真实命理语料）：相关 gold 余弦 0.41-0.51，无关闲聊 top1
 * 0.22-0.37，0.40 落在两类之间。词法有命中时沿用词法 minScore 门槛，不加此底。
 */
const SEMANTIC_FLOOR = 0.4;
/**
 * 单轮 embedding 总预算（ms）：召回是增强，绝不允许拖慢 turn。undici 默认
 * headers timeout 高达 300s——端点挂起会让每轮对话都拖死几分钟。预算内分批
 * 暖缓存（每批完成即入缓存），预算尽则本轮用已得向量（缺失条目退纯词法分），
 * 下轮从断点继续补。可用 ZCODE_MEMORY_EMBEDDING_BUDGET_MS 覆盖（下限 250）。
 */
const DEFAULT_EMBEDDING_BUDGET_MS = 2500;

function readEmbeddingBudgetMs(): number {
  const raw = Number(process.env.ZCODE_MEMORY_EMBEDDING_BUDGET_MS);
  return Number.isFinite(raw) && raw >= 250 ? raw : DEFAULT_EMBEDDING_BUDGET_MS;
}

interface CacheSlot {
  at: number;
  entries: MemoryManifestEntry[];
}

/** manifest 扫描缓存：runtime → (rootDir → 槽)；kb 卡语料与 memory 语料各自缓存。 */
const manifestCache = new WeakMap<object, Map<string, CacheSlot>>();
/** 条目向量缓存：runtime → (缓存键 → 向量)；键含 mtime+description，内容变更自动失效。 */
const vectorCache = new WeakMap<object, Map<string, number[]>>();
/** 查询向量备忘：同一 runtime 内同 query 文本复用上次向量——memory 与 kb 两语料
 * 在同一 turn 用同一查询各调一次 rankRecallCorpus，不备忘会双花一次 embedding
 * 请求（每次几百 ms 落在 TTFT 上）。query 变了自然失效（键含全文）。 */
interface QueryVectorSlot {
  query: string;
  vector: number[];
}
const queryVectorCache = new WeakMap<object, QueryVectorSlot>();

function vectorCacheKey(rootDir: string, entry: MemoryManifestEntry): string {
  return `${rootDir}\u0000${entry.filename}\u0000${entry.mtimeMs}\u0000${entry.description ?? ""}`;
}

// ── P7 向量盘档：进程内缓存重启即丢，盘档让重暖从数十轮降为一次加载。 ──
const PERSIST_DEBOUNCE_MS = 5_000;

interface DiskSlot {
  loadPromise: Promise<void> | null;
  store: PersistedVectorFile | null;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
  fileSystem?: FileSystemPort;
}

const diskSlots = new Map<string, DiskSlot>();

function diskSlotFor(storePath: string): DiskSlot {
  let slot = diskSlots.get(storePath);
  if (!slot) {
    slot = { loadPromise: null, store: null, dirty: false };
    diskSlots.set(storePath, slot);
  }
  return slot;
}

function schedulePersist(slot: DiskSlot, storePath: string, fileSystem: FileSystemPort): void {
  slot.fileSystem = fileSystem;
  if (slot.timer !== undefined) return;
  slot.timer = setTimeout(() => {
    slot.timer = undefined;
    void persistSlot(slot, storePath);
  }, PERSIST_DEBOUNCE_MS);
  slot.timer.unref?.();
}

async function persistSlot(slot: DiskSlot, storePath: string): Promise<void> {
  if (!slot.dirty || !slot.store || !slot.fileSystem) return;
  slot.dirty = false;
  try {
    await slot.fileSystem.writeTextFile({ path: storePath, content: JSON.stringify(slot.store), atomic: true });
  } catch {
    slot.dirty = true; // 写失败留脏位，下个窗口再试；盘档是加速器，失败不阻断召回。
  }
}

/** 立即落盘所有脏槽（测试与进程收尾用）。 */
export async function flushVectorStores(): Promise<void> {
  for (const [storePath, slot] of diskSlots) {
    if (slot.timer !== undefined) {
      clearTimeout(slot.timer);
      slot.timer = undefined;
    }
    await persistSlot(slot, storePath);
  }
}

/** 测试隔离：清空盘档内存态（不删文件）。 */
export function resetVectorStoresForTesting(): void {
  for (const slot of diskSlots.values()) {
    if (slot.timer !== undefined) clearTimeout(slot.timer);
  }
  diskSlots.clear();
}

/** 融合档取全部条目向量：命中缓存直取，缺的先从盘档补水、再按 64 条/批在
 * 预算内增量补——每批完成立即入缓存与盘档（中断不丢批次）。 */
async function ensureEntryVectors(
  runtime: object,
  endpoint: NonNullable<ReturnType<typeof readEmbeddingEndpointConfig>>,
  entries: readonly MemoryManifestEntry[],
  deadlineAt: number,
  fileSystem: FileSystemPort,
  rootDir: string,
): Promise<Map<string, number[]>> {
  let cache = vectorCache.get(runtime);
  if (!cache) {
    cache = new Map();
    vectorCache.set(runtime, cache);
  }
  const liveKeys = new Set(entries.map((entry) => vectorCacheKey(rootDir, entry)));
  for (const key of cache.keys()) {
    if (!liveKeys.has(key)) cache.delete(key); // 语料演化：清掉已消失/已变更条目的旧向量
  }
  // P7 盘档：按 corpus×模型分文件，加载单飞；失败按空盘档处理（静默重算）。
  const storePath = vectorStorePath(rootDir, endpoint.model ?? "embedding-3");
  const slot = diskSlotFor(storePath);
  if (slot.loadPromise === null) {
    slot.loadPromise = (async () => {
      try {
        const read = await fileSystem.readTextFile({ path: storePath });
        slot.store = parseVectorStoreFile(read.content, endpoint.model ?? "embedding-3");
      } catch {
        slot.store = { version: 1, model: endpoint.model ?? "embedding-3", vectors: {} };
      }
    })();
  }
  await slot.loadPromise;
  if (slot.store !== null) {
    for (const entry of entries) {
      if (cache.has(vectorCacheKey(rootDir, entry))) continue;
      const decoded = decodeVector(slot.store.vectors[vectorCacheKey(rootDir, entry)] ?? "");
      if (decoded !== null) cache.set(vectorCacheKey(rootDir, entry), decoded);
    }
  }
  const missing = entries.filter((entry) => !cache.has(vectorCacheKey(rootDir, entry)));
  for (let i = 0; i < missing.length; i += EMBEDDING_BATCH_LIMIT) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) break;
    const batch = missing.slice(i, i + EMBEDDING_BATCH_LIMIT);
    try {
      const vectors = await fetchEmbeddings(
        endpoint,
        batch.map((entry) => `${entry.description ?? ""} ${entry.filename} ${entry.type ?? ""}`),
        { signal: AbortSignal.timeout(remaining) },
      );
      batch.forEach((entry, j) => {
        cache!.set(vectorCacheKey(rootDir, entry), vectors[j]!);
        if (slot.store !== null) {
          slot.store.vectors[vectorCacheKey(rootDir, entry)] = encodeVector(vectors[j]!);
          slot.dirty = true;
        }
      });
    } catch {
      break; // 预算尽/端点故障：保留已缓存批次，其余下轮续补
    }
  }
  // 落盘调度一次/调用（批次内不重复挂表）：kb 规模（数千卡≈数十 MB JSON）
  // 下每批一写会把 stringify-写盘变成热路径；防抖窗口本就跨 turn，无丢失代价。
  if (slot.dirty) schedulePersist(slot, storePath, fileSystem);
  return cache;
}

export function latestRealUserText(entries: readonly RuntimeMessageEntry[]): string | null {
  // 主 turn：最近一条真实用户输入即查询。
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    // 同 task-reanchor：message entry 不带 kind 字段，按非 attachment 判定。
    if (entry && "message" in entry && entry.metadata?.source === "real_user") {
      const text = modelMessageContentToText(entry.message.content).trim();
      if (text) return text;
    }
  }
  // 子代理档：任务输入带 inputPresentation=coordinator_input（source 被标为
  // legacy_synthetic 而非 real_user），没有 real_user 条目——退回首个任务文本
  // 作为召回查询（P3：子代理共享主记忆召回的查询面）。
  for (const entry of entries) {
    if (
      entry &&
      "message" in entry &&
      entry.metadata?.inputPresentation === "coordinator_input"
    ) {
      const text = modelMessageContentToText(entry.message.content).trim();
      if (text) return text;
    }
  }
  return null;
}

export interface MemoryRecallReminderInput {
  runtime: object;
  fileSystem: FileSystemPort;
  memoryRoot: string;
  entries: readonly RuntimeMessageEntry[];
}

export interface RankRecallCorpusInput {
  runtime: object;
  fileSystem: FileSystemPort;
  /** 语料根（memory 根或 kb 卡目录），manifest/向量缓存与盘档均按它隔离。 */
  rootDir: string;
  query: string;
  topK?: number;
  /** 词法最低分（默认 0.1）。kb 卡 description 含路径词元更长，覆盖率天然
   * 稀释，kb 档可放宽（相关性排序仍由融合分决定，此值只管「有无一点关系」）。 */
  minScore?: number;
  /** 清单条数上限（默认 200=memory 档；kb 卡语料必须放宽）。 */
  fileLimit?: number;
}

/**
 * 语料排序管线（P1 抽取，memory 与 kb 卡同源共用，杜绝口径漂移）：
 * manifest 扫描（runtime×root 60s 缓存）→ 词法 → embedding 端点在则全量融合
 * （预算/盘档/语义底线同源）。返回按相关度排序的条目；空语料/无相关返回 null。
 */
export async function rankRecallCorpus(
  input: RankRecallCorpusInput,
): Promise<MemoryManifestEntry[] | null> {
  const topK = input.topK ?? TOP_K;
  let roots = manifestCache.get(input.runtime);
  if (!roots) {
    roots = new Map();
    manifestCache.set(input.runtime, roots);
  }
  const now = Date.now();
  let slot = roots.get(input.rootDir);
  if (!slot || now - slot.at > SCAN_TTL_MS) {
    try {
      slot = {
        entries: await scanMemoryManifest({
          fileSystem: input.fileSystem,
          rootDir: input.rootDir,
          ...(input.fileLimit !== undefined ? { fileLimit: input.fileLimit } : {}),
        }),
        at: now,
      };
      roots.set(input.rootDir, slot);
    } catch {
      return null;
    }
  }
  if (slot.entries.length === 0) return null;

  const lexical = scoreMemoryEntries(input.query, slot.entries, {
    topK: slot.entries.length,
    minScore: input.minScore ?? 0.1,
  });
  const endpoint = readEmbeddingEndpointConfig();
  if (!endpoint) {
    if (lexical.length === 0) return null;
    return lexical.slice(0, topK).map((item) => item.entry);
  }

  try {
    const deadlineAt = Date.now() + readEmbeddingBudgetMs();
    const cache = await ensureEntryVectors(
      input.runtime,
      endpoint,
      slot.entries,
      deadlineAt,
      input.fileSystem,
      input.rootDir,
    );
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("embedding budget exhausted");
    const memo = queryVectorCache.get(input.runtime);
    let queryVector: number[] | undefined = memo?.query === input.query ? memo.vector : undefined;
    if (queryVector === undefined) {
      [queryVector] = await fetchEmbeddings(endpoint, [input.query], {
        signal: AbortSignal.timeout(remaining),
      });
      if (queryVector) queryVectorCache.set(input.runtime, { query: input.query, vector: queryVector });
    }
    if (!queryVector) {
      if (lexical.length === 0) return null;
      return lexical.slice(0, topK).map((item) => item.entry);
    }
    const cosineByFilename = new Map<string, number>();
    for (const entry of slot.entries) {
      const vector = cache.get(vectorCacheKey(input.rootDir, entry));
      if (vector) cosineByFilename.set(entry.filename, cosineSimilarity(queryVector, vector));
    }
    const lexicalScoreByFilename = new Map(lexical.map((item) => [item.entry.filename, item.score]));
    const fused = fuseRecallScoresFull(slot.entries, lexicalScoreByFilename, cosineByFilename);
    if (lexical.length === 0 && (fused[0]?.score ?? 0) < SEMANTIC_FLOOR) return null; // 纯语义档：全都不相关
    const byFilename = new Map(slot.entries.map((entry) => [entry.filename, entry]));
    const rankedEntries = fused
      .slice(0, topK)
      .map((item) => byFilename.get(item.filename))
      .filter((entry): entry is MemoryManifestEntry => entry !== undefined);
    if (rankedEntries.length === 0) return null;
    return rankedEntries;
  } catch {
    // embedding 失败：静默退回词法档（词法也无命中则不注入）。
    if (lexical.length === 0) return null;
    return lexical.slice(0, topK).map((item) => item.entry);
  }
}

/** 返回提醒正文；无相关记忆时返回 null（不注入）。 */
export async function buildMemoryRecallReminderBody(
  input: MemoryRecallReminderInput,
): Promise<string | null> {
  const query = latestRealUserText(input.entries);
  if (!query) return null;
  const ranked = await rankRecallCorpus({
    runtime: input.runtime,
    fileSystem: input.fileSystem,
    rootDir: input.memoryRoot,
    query,
  });
  if (ranked === null || ranked.length === 0) return null;
  return renderReminder(ranked);
}

function renderReminder(entries: readonly MemoryManifestEntry[]): string {
  const lines = [
    "以下为与本轮输入可能相关的既有记忆（按相关度排序）。需要细节时用 Read 读取对应文件；未列出的记忆与本轮大概率无关。",
    ...entries.map(
      ({ filePath, description }) => `- ${filePath}${description ? ` — ${description}` : ""}`,
    ),
  ];
  return lines.join("\n");
}
