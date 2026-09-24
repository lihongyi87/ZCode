import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskReanchorReminderBody,
  firstRealUserText,
  shouldReanchorAtStep,
  TASK_REANCHOR_MAX_CHARS,
} from "../src/runtime/methods/task-reanchor-reminder.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";

/**
 * 任务再锚定提醒测试：里程碑触发、首条真实用户消息提取、截断与空值。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/task-reanchor.test.ts
 */

const user = (text: string): RuntimeMessageEntry => ({
  kind: "message",
  message: { role: "user", content: [{ type: "text", text }] },
  metadata: { source: "real_user" },
});
const synthetic = (text: string): RuntimeMessageEntry => ({
  kind: "message",
  message: { role: "user", content: [{ type: "text", text }] },
  metadata: { source: "legacy_synthetic" },
});
const assistant = (text: string): RuntimeMessageEntry => ({
  kind: "message",
  message: { role: "assistant", content: text },
});

test("里程碑：第 15/30 步触发，其他不触发", () => {
  assert.equal(shouldReanchorAtStep(15), true);
  assert.equal(shouldReanchorAtStep(30), true);
  assert.equal(shouldReanchorAtStep(14), false);
  assert.equal(shouldReanchorAtStep(16), false);
  assert.equal(shouldReanchorAtStep(0), false);
});

test("提取首条真实用户消息（跳过 synthetic）", () => {
  const entries = [
    synthetic("系统注入的东西"),
    user("断一段合婚"),
    assistant("好的"),
    user("再问流年"),
  ];
  assert.equal(firstRealUserText(entries), "断一段合婚");
});

test("无真实用户消息返回 null", () => {
  assert.equal(buildTaskReanchorReminderBody([synthetic("x"), assistant("y")]), null);
  assert.equal(buildTaskReanchorReminderBody([]), null);
});

test("正文含原任务与纪律行；超长任务被截断", () => {
  const body = buildTaskReanchorReminderBody([user("六爻起卦分析头疼原因")]);
  assert.ok(body?.includes("六爻起卦分析头疼原因"));
  assert.ok(body?.includes("长会话纪律"));

  const long = "很长的任务描述。".repeat(200);
  const longBody = buildTaskReanchorReminderBody([user(long)]);
  assert.ok(longBody?.includes("…"));
  assert.ok((longBody ?? "").length < long.length);
  assert.ok((longBody ?? "").includes(long.slice(0, TASK_REANCHOR_MAX_CHARS).slice(0, 20)));
});
