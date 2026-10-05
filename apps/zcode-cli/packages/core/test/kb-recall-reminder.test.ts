import assert from "node:assert/strict";
import test from "node:test";

import { buildKbRecallReminderBody } from "../src/runtime/methods/kb-recall-reminder.js";
import { resetVectorStoresForTesting } from "../src/runtime/methods/memory-recall-reminder.js";
import type { FileSystemPort } from "@zcode/contracts";

/**
 * P1 知识卡召回测试：卡语料（.zcode/kb-cards）经共享 rankRecallCorpus 管线
 * 排序，渲染「源文件#标题——摘要」锚点；无卡目录静默。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/kb-recall-reminder.test.ts
 */

const CARDS: Record<string, string> = {
  "kb-liuyao-guishen.md":
    "---\ndescription: .agents/skills/liuyao-duanpan/references/02_鬼神专论提炼卡.md#爻位所属 —— 初家亲/二土地/三外鬼/四黄仙/五天地/六神佛，断鬼神冲撞必查爻位\n---\n正文略",
  "kb-ziwei-942.md":
    "---\ndescription: .agents/skills/ziwei-common/references/v2/04_技法/飞星派/942速查/01-命宫速查.md#命宫四化 —— 命宫四化象义速查表，忌入命宫主执着纠结\n---\n正文略",
  "kb-bazi-lvshi.md":
    "---\ndescription: 八字/知识库/01_吕氏/吕氏八字命理学知识库.md#动静理论 —— 只有大运流年冲合刑害到位的十神才动，动才有作用力\n---\n正文略",
};

function fsWith(files: Record<string, string>): FileSystemPort {
  return {
    async listDirectory({ path }) {
      if (!path.endsWith("kb-cards")) {
        return { path, durationMs: 0, numEntries: 0, entries: [] };
      }
      const names = Object.keys(files);
      return {
        path,
        durationMs: 0,
        numEntries: names.length,
        entries: names.map((name) => ({ kind: "file" as const, name, path: `${path}/${name}` })),
      };
    },
    async stat({ path }) {
      const name = path.split("/").pop() ?? "";
      const content = files[name];
      if (content === undefined) throw new Error(`stat: ${path}`);
      return { path, kind: "file", sizeBytes: content.length, mtimeMs: 1 };
    },
    async readTextFileRange({ path }) {
      const name = path.split("/").pop() ?? "";
      const content = files[name];
      if (content === undefined) throw new Error(`read: ${path}`);
      return { path, content, encoding: "utf8", bytesRead: content.length, sizeBytes: content.length, truncated: false, startLine: 1, lineCount: 1, totalLines: 1 };
    },
    async readTextFile({ path }) {
      throw new Error(`readTextFile: ${path}`);
    },
  } as unknown as FileSystemPort;
}

const userInput = (text: string) =>
  [{ message: { role: "user", content: text }, metadata: { source: "real_user" } }] as never;

test("词法档：术语问题命中对应知识卡，渲染源锚点", async () => {
  resetVectorStoresForTesting();
  delete process.env.ZCODE_MEMORY_EMBEDDING_URL;
  const body = await buildKbRecallReminderBody({
    runtime: {},
    fileSystem: fsWith(CARDS),
    workingDirectory: "W:\\proj",
    entries: userInput("六爻看鬼神爻位怎么分"),
  });
  assert.ok(body?.includes("02_鬼神专论提炼卡.md#爻位所属"), `应命中鬼神卡锚点，实际: ${body}`);
  assert.ok(body!.startsWith("以下为与本轮输入可能相关的知识库锚点"), "知识卡头部文案");
});

test("无卡目录/无关问题静默返回 null", async () => {
  resetVectorStoresForTesting();
  const none = await buildKbRecallReminderBody({
    runtime: {},
    fileSystem: fsWith({}),
    workingDirectory: "W:\\proj",
    entries: userInput("六爻看鬼神"),
  });
  assert.equal(none, null);
  const unrelated = await buildKbRecallReminderBody({
    runtime: {},
    fileSystem: fsWith(CARDS),
    workingDirectory: "W:\\proj",
    entries: userInput("帮我写个排序算法"),
  });
  assert.equal(unrelated, null, "零词法命中且无 embedding → 不注入");
});

test("共享管线：embedding 全量融合对 kb 卡同样生效（口语化零词元重叠被救回）", async () => {
  resetVectorStoresForTesting();
  process.env.ZCODE_MEMORY_EMBEDDING_URL = "https://stub/embeddings";
  const realFetch = globalThis.fetch;
  // 查询与「老婆/婚姻盘面」卡同向——本卡零词法重叠，只能靠余弦救回。
  const cards = {
    ...CARDS,
    "kb-user-marital.md":
      "---\ndescription: memory/user-marital-status.md#已婚口径 —— 用户已婚，夫妻宫桃花添丁按已婚读\n---\n正文",
  };
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] };
    const data = body.input.map((text) => ({
      embedding: text.includes("已婚") || text.includes("老婆") ? [1, 0] : [0, 1],
      index: 0,
    }));
    data.forEach((d, i) => (d.index = i));
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  try {
    const body = await buildKbRecallReminderBody({
      runtime: {},
      fileSystem: fsWith(cards),
      workingDirectory: "W:\\proj",
      entries: userInput("我老婆的事在盘里怎么读"),
    });
    assert.ok(body?.includes("user-marital-status.md#已婚口径"), `余弦应救回已婚口径卡，实际: ${body}`);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ZCODE_MEMORY_EMBEDDING_URL;
    resetVectorStoresForTesting();
  }
});
