import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCaliberGuardReminderBody,
  matchCaliberEntries,
} from "../src/runtime/methods/caliber-guard-reminder.js";
import type { FileSystemPort } from "@zcode/contracts";

/**
 * P2 口径裁决护栏测试：复合键 AND 匹配、双触发面（本轮输入+已召回正文）、
 * 裸干支闲聊不误触、未登记/坏注册表静默。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/caliber-guard-reminder.test.ts
 */

const REGISTRY = [
  {
    keys: ["紫微", "四化", "庚"],
    topic: "紫微十天干四化·庚干",
    authority: "ziwei_base.py:52 SIHUA 常量（新代码一律 from ziwei_base import SIHUA）",
    verdict: "庚阳武阴同（太阳/武曲/太阴/天同）——原典两诀为版本异读，用户已拍板勿翻案",
    decidedAt: "2026-08-23",
  },
  {
    keys: ["老婆"],
    topic: "用户本人婚姻状态读盘口径",
    authority: "memory/user-marital-status.md",
    verdict: "用户已婚——夫妻宫/桃花/添丁类信号对本人必须按已婚口径读",
    decidedAt: "2026-09-05",
  },
];

function fsWith(files: Record<string, string>): FileSystemPort {
  return {
    async readTextFile({ path }) {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return { path, content, encoding: "utf8", bytesRead: content.length, sizeBytes: content.length, truncated: false };
    },
  } as unknown as FileSystemPort;
}

const userInput = (text: string) =>
  [{ message: { role: "user", content: text }, metadata: { source: "real_user" } }] as never;

function run(files: Record<string, string>, text: string, recalledText?: string) {
  return buildCaliberGuardReminderBody({
    runtime: {},
    fileSystem: fsWith(files),
    workingDirectory: "W:\\proj",
    entries: userInput(text),
    ...(recalledText !== undefined ? { recalledText } : {}),
  });
}

test("复合键 AND：全 key 命中才触发，裸干支闲聊不误触", async () => {
  const files = { "W:\\proj\\.zcode\\caliber-registry.json": JSON.stringify(REGISTRY) };
  assert.ok((await run(files, "紫微四化庚干壬干用哪套口诀"))?.includes("庚阳武阴同"), "全 key 命中应触发");
  assert.equal(await run(files, "今天庚日适合出门吗"), null, "裸「庚」闲聊不触发");
  assert.equal(await run(files, "紫微斗数入门看什么书"), null, "只有「紫微」不触发");
});

test("双触发面：query 缺 key 但已召回正文补齐也触发", async () => {
  const files = { "W:\\proj\\.zcode\\caliber-registry.json": JSON.stringify(REGISTRY) };
  const body = await run(files, "帮我断一下盘", "- memory/ziwei-sihua-koujing.md — 紫微十天干四化庚/壬两干口径定案");
  assert.ok(body?.includes("庚阳武阴同"), "召回正文补齐 key 应触发护栏");
});

test("命中渲染：裁决摘要+权威源+勿翻案指引齐备", async () => {
  const files = { "W:\\proj\\.zcode\\caliber-registry.json": JSON.stringify(REGISTRY) };
  const body = await run(files, "我老婆的事在盘里怎么读");
  assert.ok(body?.includes("用户已婚"));
  assert.ok(body?.includes("memory/user-marital-status.md"));
  assert.ok(body?.includes("勿翻案"));
});

test("未登记/坏注册表/空匹配静默返回 null", async () => {
  assert.equal(await run({}, "紫微四化庚"), null, "未登记静默");
  assert.equal(
    await run({ "W:\\proj\\.zcode\\caliber-registry.json": "{broken" }, "紫微四化庚"),
    null,
    "坏 JSON 静默",
  );
  assert.equal(
    await run({ "W:\\proj\\.zcode\\caliber-registry.json": JSON.stringify(REGISTRY) }, "帮我看个卦"),
    null,
    "无匹配静默",
  );
});

test("matchCaliberEntries 纯函数：跨文本命中、大小写不敏感", () => {
  const hit = matchCaliberEntries(["A 紫微", "四化庚"], REGISTRY);
  assert.equal(hit.length, 1, "key 可分布在不同文本");
  const none = matchCaliberEntries(["紫微"], REGISTRY);
  assert.equal(none.length, 0);
});
