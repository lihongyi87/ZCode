import assert from "node:assert/strict";
import test from "node:test";
import {
  diffProviderRequests,
  sectionizeProviderRequest,
  trackProviderRequestStabilityForRuntime,
} from "../src/model/cache-stability.js";

/**
 * 缓存稳定性检测器测试：核心契约是「正常增长=尾部追加；旧前缀内任何变异
 * 都必须被报告（mutatedBeforeTail）」，以及 cacheControl 标记不参与哈希
 * （滚动断点每轮移动，不是变异）。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/cache-stability.test.ts
 */

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const system = (text: string) => ({ role: "system", content: text });

test("纯尾部追加：无变异报告", () => {
  const prev = sectionizeProviderRequest({
    messages: [system("sys"), user("hi"), assistant("hello")],
    tools: [{ name: "Read" }],
  });
  const next = sectionizeProviderRequest({
    messages: [system("sys"), user("hi"), assistant("hello"), user("again")],
    tools: [{ name: "Read" }],
  });
  const report = diffProviderRequests(prev, next);
  assert.equal(report.mutatedBeforeTail, false);
  assert.equal(report.firstMutatedMessageIndex, null);
  assert.equal(report.systemChanged, false);
  assert.equal(report.toolsChanged, false);
});

test("system 变异：报告 systemChanged 且前缀作废", () => {
  const prev = sectionizeProviderRequest({ messages: [system("sys-a"), user("hi")], tools: [] });
  const next = sectionizeProviderRequest({ messages: [system("sys-b"), user("hi")], tools: [] });
  const report = diffProviderRequests(prev, next);
  assert.equal(report.systemChanged, true);
  assert.equal(report.mutatedBeforeTail, true);
});

test("工具表变异（如 cron 轮隐藏工具）：报告 toolsChanged", () => {
  const prev = sectionizeProviderRequest({
    messages: [system("sys"), user("hi")],
    tools: [{ name: "Read" }, { name: "Bash" }],
  });
  const next = sectionizeProviderRequest({
    messages: [system("sys"), user("hi")],
    tools: [{ name: "Read" }],
  });
  const report = diffProviderRequests(prev, next);
  assert.equal(report.toolsChanged, true);
  assert.equal(report.mutatedBeforeTail, true);
});

test("历史中部消息变异：报告首个变异下标", () => {
  const prev = sectionizeProviderRequest({
    messages: [system("sys"), user("a"), assistant("b"), user("c")],
    tools: [],
  });
  const next = sectionizeProviderRequest({
    messages: [system("sys"), user("a"), assistant("B-MUTATED"), user("c")],
    tools: [],
  });
  const report = diffProviderRequests(prev, next);
  assert.equal(report.firstMutatedMessageIndex, 2);
  assert.equal(report.mutatedBeforeTail, true);
});

test("仅末条消息内容更新（上一尾就是本条）：不算前缀变异", () => {
  const prev = sectionizeProviderRequest({
    messages: [system("sys"), user("a"), assistant("partial")],
    tools: [],
  });
  const next = sectionizeProviderRequest({
    messages: [system("sys"), user("a"), assistant("partial-full")],
    tools: [],
  });
  const report = diffProviderRequests(prev, next);
  // 流式增量重放场景：上一请求最后一条被本请求重写，属正常尾部演进。
  assert.equal(report.mutatedBeforeTail, false);
  assert.equal(report.firstMutatedMessageIndex, 2);
});

test("cacheControl 标记移动不参与哈希", () => {
  const withMarker = {
    messages: [system("sys"), { ...user("a"), cacheControl: { type: "ephemeral" } }],
    tools: [],
  };
  const withoutMarker = {
    messages: [system("sys"), user("a")],
    tools: [],
  };
  assert.deepEqual(
    sectionizeProviderRequest(withMarker as never),
    sectionizeProviderRequest(withoutMarker as never),
  );
});

test("运行时跟踪：首次无报告，第二次返回 diff，第三次跨对象互不干扰", () => {
  const runtimeA = {};
  const runtimeB = {};
  assert.equal(
    trackProviderRequestStabilityForRuntime(runtimeA, { messages: [user("1")], tools: [] }),
    null,
  );
  const report = trackProviderRequestStabilityForRuntime(runtimeA, {
    messages: [user("1"), user("2")],
    tools: [],
  });
  assert.ok(report);
  assert.equal(report?.mutatedBeforeTail, false);
  // 另一 runtime 实例独立基线：首次仍为 null。
  assert.equal(
    trackProviderRequestStabilityForRuntime(runtimeB, { messages: [user("x")], tools: [] }),
    null,
  );
});
