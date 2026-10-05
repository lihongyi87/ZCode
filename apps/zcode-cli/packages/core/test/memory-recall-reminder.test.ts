import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMemoryRecallReminderBody,
  flushVectorStores,
  resetVectorStoresForTesting,
} from "../src/runtime/methods/memory-recall-reminder.js";
import {
  decodeVector,
  encodeVector,
  vectorStorePath,
} from "../src/memory/recall/vector-store.js";
import type { FileSystemPort } from "@zcode/contracts";

/**
 * 记忆召回提醒 v3（全量融合）端到端：词法档、余弦救回、底线、降级、向量缓存。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/memory-recall-reminder.test.ts
 */

interface StubFile {
  name: string;
  mtimeMs: number;
  content: string;
}

function makeFileSystem(files: StubFile[], storage = new Map<string, string>()): FileSystemPort {
  return {
    async listDirectory({ path }) {
      return {
        path,
        durationMs: 0,
        numEntries: files.length,
        entries: files.map((f) => ({ kind: "file", name: f.name, path: `${path}/${f.name}` })),
      };
    },
    async stat({ path }) {
      const file = files.find((f) => path.endsWith(f.name));
      if (!file) throw new Error(`stat: ${path}`);
      return { path, kind: "file", sizeBytes: file.content.length, mtimeMs: file.mtimeMs };
    },
    async readTextFileRange({ path }) {
      const file = files.find((f) => path.endsWith(f.name));
      if (!file) throw new Error(`read: ${path}`);
      return {
        path,
        content: file.content,
        encoding: "utf8",
        bytesRead: file.content.length,
        sizeBytes: file.content.length,
        truncated: false,
        startLine: 1,
        lineCount: 1,
        totalLines: 1,
      };
    },
    async readTextFile({ path }) {
      const content = storage.get(path);
      if (content === undefined) throw new Error(`readTextFile: ${path}`);
      return {
        path,
        content,
        encoding: "utf8",
        bytesRead: content.length,
        sizeBytes: content.length,
        truncated: false,
      };
    },
    async writeTextFile({ path, content }) {
      storage.set(path, content);
      return { path, bytesWritten: content.length };
    },
  } as unknown as FileSystemPort;
}

const FILES: StubFile[] = [
  {
    name: "liuyao-anli.md",
    mtimeMs: 100,
    content: "---\ndescription: 六爻双卦案——心中所想女生既济变蹇断无关联可放下\n---\n正文",
  },
  {
    name: "sihua-koujing.md",
    mtimeMs: 99,
    content: "---\ndescription: 紫微四化庚壬两干口径定案——庚阳武阴同\n---\n正文",
  },
];

function userInput(text: string) {
  return [
    {
      message: { role: "user", content: text },
      metadata: { source: "real_user" },
    },
  ] as never;
}

function stubFetch(vectorsFor: (texts: string[]) => number[][] | Promise<number[][]>) {
  const batches: string[][] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] };
    batches.push(body.input);
    const vectors = await vectorsFor(body.input);
    return new Response(
      JSON.stringify({ data: vectors.map((v, i) => ({ embedding: v, index: i })) }),
      { status: 200 },
    );
  }) as typeof fetch;
  return {
    batches,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

const ENV = {
  url: "https://stub/embeddings",
  set() {
    process.env.ZCODE_MEMORY_EMBEDDING_URL = this.url;
  },
  clear() {
    delete process.env.ZCODE_MEMORY_EMBEDDING_URL;
  },
};

test("词法档（无端点）：术语查询命中 gold，口语化零重叠查询不注入", async () => {
  ENV.clear();
  const fs = makeFileSystem(FILES);
  const hit = await buildMemoryRecallReminderBody({
    runtime: {},
    fileSystem: fs,
    memoryRoot: "memory",
    entries: userInput("紫微四化庚干壬干用哪套口诀"),
  });
  assert.ok(hit?.includes("sihua-koujing.md"));
  const miss = await buildMemoryRecallReminderBody({
    runtime: {},
    fileSystem: fs,
    memoryRoot: "memory",
    entries: userInput("我心里惦记的那个人到底能不能成"),
  });
  assert.equal(miss, null);
});

test("P3 子代理档：无 real_user 时退回首个 coordinator_input 任务文本作查询", async () => {
  ENV.clear();
  const taskEntries = [
    {
      message: { role: "user", content: "写一份八字命理报告，注意紫微四化庚干壬干的口径" },
      metadata: { source: "legacy_synthetic", inputPresentation: "coordinator_input" },
    },
  ] as never;
  const body = await buildMemoryRecallReminderBody({
    runtime: {},
    fileSystem: makeFileSystem(FILES),
    memoryRoot: "memory",
    entries: taskEntries,
  });
  assert.ok(body?.includes("sihua-koujing.md"), `任务文本应触发词法命中，实际: ${body}`);
  // real_user 存在时优先于 coordinator_input（主 turn 语义不变）。
  const mixed = [
    ...taskEntries,
    {
      message: { role: "user", content: "六爻双卦案怎么断" },
      metadata: { source: "real_user" },
    },
  ] as never;
  const mixedBody = await buildMemoryRecallReminderBody({
    runtime: {},
    fileSystem: makeFileSystem(FILES),
    memoryRoot: "memory",
    entries: mixed,
  });
  assert.ok(mixedBody?.includes("liuyao-anli.md"));
});

test("融合档（v3 全量）：词法零重叠的口语查询被余弦救回", async () => {
  resetVectorStoresForTesting();
  ENV.set();
  // 查询与 gold（六爻双卦案）同向；另一条目正交。
  const stub = stubFetch((texts) =>
    texts.map((t) => (t.includes("六爻双卦") || t.includes("惦记") ? [1, 0] : [0, 1])),
  );
  try {
    const body = await buildMemoryRecallReminderBody({
      runtime: {},
      fileSystem: makeFileSystem(FILES),
      memoryRoot: "memory",
      entries: userInput("我心里惦记的那个人到底能不能成"),
    });
    assert.ok(body?.includes("liuyao-anli.md"), `应含 gold，实际: ${body}`);
  } finally {
    stub.restore();
    ENV.clear();
  }
});

test("融合档语义底线：词法零命中且余弦全部低于 0.4 时不注入（无关闲聊）", async () => {
  resetVectorStoresForTesting();
  ENV.set();
  // 查询向量 [1,0]，全部条目 [0,1] → 余弦恒 0，低于 0.4 底线。
  const stub = stubFetch((texts) => texts.map((t) => (t.includes("吃什么") ? [1, 0] : [0, 1])));
  try {
    const body = await buildMemoryRecallReminderBody({
      runtime: {},
      fileSystem: makeFileSystem(FILES),
      memoryRoot: "memory",
      entries: userInput("今天中午吃什么"),
    });
    assert.equal(body, null);
  } finally {
    stub.restore();
    ENV.clear();
  }
});

test("融合档降级：embedding 请求失败时退回词法档（口语查询 → null，不抛错）", async () => {
  resetVectorStoresForTesting();
  ENV.set();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  try {
    const body = await buildMemoryRecallReminderBody({
      runtime: {},
      fileSystem: makeFileSystem(FILES),
      memoryRoot: "memory",
      entries: userInput("我心里惦记的那个人到底能不能成"),
    });
    assert.equal(body, null);
  } finally {
    globalThis.fetch = realFetch;
    ENV.clear();
  }
});

test("向量缓存：同 runtime 第二轮只重嵌查询，不重嵌条目", async () => {
  resetVectorStoresForTesting();
  ENV.set();
  const stub = stubFetch((texts) => texts.map((t) => (t.includes("惦记") ? [1, 0] : [0, 1])));
  const runtime = {};
  const fs = makeFileSystem(FILES);
  try {
    await buildMemoryRecallReminderBody({ runtime, fileSystem: fs, memoryRoot: "memory", entries: userInput("惦记的那个人") });
    await buildMemoryRecallReminderBody({ runtime, fileSystem: fs, memoryRoot: "memory", entries: userInput("惦记的那个人") });
    // 第一轮：条目批（2条）+ 查询批（1条）；第二轮：条目走缓存、查询向量走
    // 同 runtime memo（同 query 复用，防 memory/kb 双花）——零嵌入请求。
    assert.deepEqual(stub.batches.map((b) => b.length), [2, 1]);
  } finally {
    stub.restore();
    ENV.clear();
  }
});

test("embedding 预算：端点慢时按预算快速降级，不拖死 turn", async () => {
  resetVectorStoresForTesting();
  ENV.set();
  process.env.ZCODE_MEMORY_EMBEDDING_BUDGET_MS = "300";
  // 条目批 600ms 才回（超过 300ms 预算）→ 本轮必须按词法档快速返回（零词法命中 → null）。
  const stub = stubFetch(async (texts) => {
    await new Promise((r) => setTimeout(r, 600));
    return texts.map(() => [0, 1]);
  });
  const t0 = Date.now();
  try {
    const body = await buildMemoryRecallReminderBody({
      runtime: {},
      fileSystem: makeFileSystem(FILES),
      memoryRoot: "memory",
      entries: userInput("我心里惦记的那个人到底能不能成"),
    });
    assert.equal(body, null);
    assert.ok(Date.now() - t0 < 2000, `应在预算内返回，实际 ${Date.now() - t0}ms`);
  } finally {
    stub.restore();
    ENV.clear();
    delete process.env.ZCODE_MEMORY_EMBEDDING_BUDGET_MS;
  }
});

// ── P7 向量盘档持久化 ──

test("P7 序列化：Float32×base64 往返，精度 1e-6 内", () => {
  const vector = [0.1, -0.5, 0.999999, 3.25, -1e-8, 0];
  const decoded = decodeVector(encodeVector(vector));
  assert.ok(decoded !== null);
  assert.equal(decoded.length, vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    assert.ok(Math.abs(decoded[i]! - vector[i]!) < 1e-6);
  }
  // 坏输入按未缓存处理
  assert.equal(decodeVector("not-base64!!"), null);
  assert.equal(decodeVector(""), null);
});

test("P7 重启补水：落盘后新 runtime 只嵌查询，不重嵌条目", async () => {
  resetVectorStoresForTesting();
  ENV.set();
  const storage = new Map<string, string>();
  const fs = makeFileSystem(FILES, storage);
  const stub = stubFetch((texts) => texts.map((t) => (t.includes("惦记") ? [1, 0] : [0, 1])));
  try {
    // 第一次进程：嵌入 2 条目 + 查询
    await buildMemoryRecallReminderBody({ runtime: {}, fileSystem: fs, memoryRoot: "mem-p7", entries: userInput("惦记的那个人") });
    await flushVectorStores();
    const storePath = vectorStorePath("mem-p7", "embedding-3");
    assert.ok(storage.has(storePath), "盘档文件必须已写入");
    // 模拟重启：清空进程内盘档槽（文件仍在 storage），新 runtime 从文件补水
    resetVectorStoresForTesting();
    await buildMemoryRecallReminderBody({ runtime: {}, fileSystem: fs, memoryRoot: "mem-p7", entries: userInput("惦记的那个人") });
    // 第一轮 [2条目,1查询]；重启后仅 [1查询]
    assert.deepEqual(stub.batches.map((b) => b.length), [2, 1, 1]);
  } finally {
    stub.restore();
    ENV.clear();
    resetVectorStoresForTesting();
  }
});

test("P7 键失效：description 变更的条目单独重算，其余直取盘档", async () => {
  resetVectorStoresForTesting();
  ENV.set();
  const storage = new Map<string, string>();
  const fs = makeFileSystem(FILES, storage);
  const stub = stubFetch((texts) => texts.map((t) => (t.includes("惦记") ? [1, 0] : [0, 1])));
  try {
    await buildMemoryRecallReminderBody({ runtime: {}, fileSystem: fs, memoryRoot: "mem-p7b", entries: userInput("惦记的那个人") });
    await flushVectorStores();
    resetVectorStoresForTesting();
    // 语料演化：改 gold 条目的 description（mtime 不变，键含 description 即失效）
    const evolved = FILES.map((f) =>
      f.name === "liuyao-anli.md"
        ? { ...f, content: "---\ndescription: 六爻双卦案改写后的新描述\n---\n正文" }
        : f,
    );
    const fs2 = makeFileSystem(evolved, storage);
    await buildMemoryRecallReminderBody({ runtime: {}, fileSystem: fs2, memoryRoot: "mem-p7b", entries: userInput("惦记的那个人") });
    // 重启后：1 条目（改写的那条）+ 1 查询
    assert.deepEqual(stub.batches.map((b) => b.length), [2, 1, 1, 1]);
  } finally {
    stub.restore();
    ENV.clear();
    resetVectorStoresForTesting();
  }
});
