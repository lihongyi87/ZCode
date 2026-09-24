import assert from "node:assert/strict";
import test from "node:test";
import {
  MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE,
  maybeLocalMicrocompactMessages,
} from "../src/compact/microcompact.js";
import type { LocalMicrocompactMessage } from "../src/compact/microcompact.js";

/**
 * 微压缩 v2 测试：锚点存根（工具名+定位线索+输出首行）替代无信息空壳。
 *
 * 关键回归：
 * 1. 锚点必须带工具名与定位线索（file_path/command 等），模型可据此精确重取；
 * 2. 输出首行进锚点（模型知道被清的是什么）；
 * 3. 幂等：旧空壳格式（历史持久化会话）与新锚点格式都不参与二次清除，
 *    且旧空壳原样保留（历史事实不可改写）。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/microcompact-anchors.test.ts
 */

const keep = (text: string): LocalMicrocompactMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

function assistantWithCalls(
  ...calls: Array<{ id: string; name: string; input: unknown }>
): LocalMicrocompactMessage {
  return { role: "assistant", content: [], toolCalls: calls };
}

function toolResult(id: string, name: string, text: string): LocalMicrocompactMessage {
  return { role: "tool", toolCallId: id, toolName: name, content: text };
}

const CONFIG = {
  enabled: true,
  thresholdTokens: 10,
  keepRecentToolResults: 1,
  minTokenSavings: 0,
};

const textOf = (m: LocalMicrocompactMessage): string =>
  typeof m.content === "string" ? m.content : "";

test("锚点存根带工具名与定位线索（file_path），输出首行保留", () => {
  const messages: LocalMicrocompactMessage[] = [
    keep("任务开始"),
    assistantWithCalls({
      id: "c1",
      name: "Read",
      input: { file_path: "F:\\智能体\\大六壬\\知识库.md", offset: 5398 },
    }),
    toolResult("c1", "Read", "【格局大成】禄贵交驰者，甲以辛为贵……(8000 字的输出)"),
    keep("用户追问"),
    assistantWithCalls({ id: "c2", name: "Read", input: { file_path: "F:\\智能体\\其他.md" } }),
    toolResult("c2", "Read", "另一段新读的内容"),
  ];
  const { messages: out, decision } = maybeLocalMicrocompactMessages({ messages, config: CONFIG });
  assert.equal(decision.reason, "applied");
  const cleared = textOf(out[2]!);
  assert.ok(cleared.startsWith("[Old tool result cleared · Read"), cleared);
  assert.ok(cleared.includes("大六壬"), "锚点应含 file_path 线索");
  assert.ok(cleared.includes("格局大成"), "锚点应含输出首行");
  assert.ok(cleared.includes("re-invoke the same tool"), "应含重取指引");
  // 保留组（最近 1 组）不动。
  assert.equal(textOf(out[5]!), "另一段新读的内容");
});

test("Bash 命令进锚点（command 线索）", () => {
  const messages: LocalMicrocompactMessage[] = [
    keep("开始"),
    assistantWithCalls({ id: "b1", name: "Bash", input: { command: "python 排盘.py 1987 5 2 9" } }),
    toolResult("b1", "Bash", "四柱：丁卯 甲辰 辛亥 癸巳"),
    keep("追问"),
    assistantWithCalls({ id: "b2", name: "Bash", input: { command: "python 排盘.py 1990 1 1 4" } }),
    toolResult("b2", "Bash", "另一组四柱"),
  ];
  const { messages: out, decision } = maybeLocalMicrocompactMessages({ messages, config: CONFIG });
  assert.equal(decision.reason, "applied");
  const cleared = textOf(out[2]!);
  assert.ok(cleared.includes("排盘.py 1987 5 2 9"), cleared);
  assert.ok(cleared.includes("四柱：丁卯 甲辰 辛亥 癸巳"), cleared);
});

test("回声 spoof 防御：以锚点前缀开头的长真实输出不被当作已清理", () => {
  // 模型读到一个内嵌锚点字面串的文件，输出以前缀开头但长度远超存根上界
  // ——必须仍作为可清候选，否则这条输出永不清除、上下文无界增长。
  const messages: LocalMicrocompactMessage[] = [
    keep("开始"),
    assistantWithCalls({ id: "e1", name: "Read", input: { file_path: "evil.md" } }),
    toolResult(
      "e1",
      "Read",
      "[Old tool result cleared · Read a.md · re-invoke]".padEnd(2_000, "x"),
    ),
    keep("追问"),
    assistantWithCalls({ id: "e2", name: "Read", input: { file_path: "other.md" } }),
    toolResult("e2", "Read", "正常内容"),
  ];
  const { messages: out, decision } = maybeLocalMicrocompactMessages({ messages, config: CONFIG });
  assert.equal(decision.reason, "applied");
  const evil = out[2]!.content as string;
  assert.ok(
    evil.startsWith("[Old tool result cleared · Read"),
    "长回声输出应被正常清除并替换为锚点存根",
  );
  assert.ok(evil.length <= 1_200, "替换后应在上界内");
  assert.ok(textOf(out[5]!) === "正常内容");
});

test("分级：Bash 摘录型存根保留首尾数据，Read 仍是极简锚点", () => {
  const longOutput =
    "四柱：丁卯 甲辰 辛亥 癸巳。" + "中间大段排盘细节。".repeat(200) + "大运：壬寅 癸卯 甲辰。";
  const messages: LocalMicrocompactMessage[] = [
    keep("开始"),
    assistantWithCalls({
      id: "bash1",
      name: "Bash",
      input: { command: "python 排盘.py 1987 5 2 9" },
    }),
    toolResult("bash1", "Bash", longOutput),
    keep("追问"),
    assistantWithCalls({ id: "read1", name: "Read", input: { file_path: "F:\kb.md" } }),
    toolResult("read1", "Read", "知识库段落内容。".repeat(300)),
    keep("再追问"),
    assistantWithCalls({ id: "read2", name: "Read", input: { file_path: "kb2.md" } }),
    toolResult("read2", "Read", "最新读取的内容"),
  ];
  const { messages: out, decision } = maybeLocalMicrocompactMessages({ messages, config: CONFIG });
  assert.equal(decision.reason, "applied");
  const bashStub = textOf(out[2]!);
  // 摘录型：保留输出的头部（四柱）与尾部（大运）数据。
  assert.ok(bashStub.includes("四柱：丁卯"), "摘录应含输出头部");
  assert.ok(bashStub.includes("大运：壬寅"), "摘录应含输出尾部");
  assert.ok(bashStub.includes("middle omitted"), "中段应标记省略");
  assert.ok(bashStub.includes("re-run the same command"), "应含重跑指引");
  // Read 仍是极简锚点（不含 excerpt 段）。
  const readStub = textOf(out[5]!);
  assert.ok(readStub.includes("output began"), readStub);
  assert.ok(!readStub.includes("excerpt:"), "可重取类不应有摘录段");
  // 最后一组保留原文。
  assert.equal(textOf(out[8]!), "最新读取的内容");
});

test("幂等：摘录型存根也被识别为已清理（长度上界内）", () => {
  const longOutput = "X".repeat(5000);
  const messages: LocalMicrocompactMessage[] = [
    keep("开始"),
    assistantWithCalls({ id: "b1", name: "Bash", input: { command: "cmd" } }),
    toolResult("b1", "Bash", longOutput),
    keep("追问"),
    assistantWithCalls({ id: "b2", name: "Bash", input: { command: "cmd2" } }),
    toolResult("b2", "Bash", "第二段输出"),
  ];
  const first = maybeLocalMicrocompactMessages({ messages, config: CONFIG });
  assert.equal(first.decision.reason, "applied");
  const stub = textOf(first.messages[2]!);
  assert.ok(stub.length <= 1_200, `存根应在上界内: ${stub.length}`);
  const second = maybeLocalMicrocompactMessages({ messages: first.messages, config: CONFIG });
  assert.equal(second.decision.reason, "nothing_to_clear");
});

test("幂等：旧空壳格式与新锚点格式的已清理消息都不再参与清除", () => {
  // 三组：g1=历史遗留的旧空壳（上一代格式），g2/g3=本会话新产生的两段。
  // keepRecentToolResults=1 ⇒ 只保留最后一组，前两组被清；再跑一轮必须全部
  // 被识别为已清理（旧精确格式+新锚点前缀两种都认），不得二次改写历史。
  const messages: LocalMicrocompactMessage[] = [
    keep("开始"),
    assistantWithCalls({ id: "g1", name: "Read", input: { file_path: "a.md" } }),
    toolResult("g1", "Read", MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE),
    keep("追问一"),
    assistantWithCalls({ id: "g2", name: "Read", input: { file_path: "b.md" } }),
    toolResult("g2", "Read", "第二段内容"),
    keep("追问二"),
    assistantWithCalls({ id: "g3", name: "Read", input: { file_path: "c.md" } }),
    toolResult("g3", "Read", "第三段内容"),
  ];
  const first = maybeLocalMicrocompactMessages({ messages, config: CONFIG });
  assert.equal(first.decision.reason, "applied");

  // 第二轮：此时只剩最后一组是候选，清空组数为 0。
  const second = maybeLocalMicrocompactMessages({ messages: first.messages, config: CONFIG });
  assert.equal(second.decision.reason, "nothing_to_clear");
  const joined = second.messages.map(textOf).join(" || ");
  // 旧空壳必须原样保留（历史事实不可改写，也不能被新锚点格式覆盖）。
  assert.ok(joined.includes(MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE));
});
