import { describe, expect, it } from "vitest";
import {
  buildDeepSeekSessionLog,
  fingerprintModelMessages,
  foldModelMessagesToSessionLogWire,
  type DeepSeekSessionLogWatermark,
} from "../src/deepseek/session-log-fold.js";
import type { ModelInputMessage } from "../src/model/index.js";

/** spec 157:dsh_session_log 折叠/指纹/增量打包(watermark 语义对齐 DSH at-least-once)。 */

const user = (text: string): ModelInputMessage => ({ role: "user", content: text });
const assistant = (text: string): ModelInputMessage => ({ role: "assistant", content: text });
const toolResult = (text: string, toolName = "Bash"): ModelInputMessage => ({
  role: "tool",
  content: text,
  toolName,
});

const MAX_BYTES = 8 * 1024 * 1024;

describe("foldModelMessagesToSessionLogWire", () => {
  it("四类角色映射到 DSH 词表;空文本消息不占 seq", () => {
    const messages = [
      { role: "system", content: "sys" } as ModelInputMessage,
      user("hello"),
      assistant("hi"),
      toolResult("ok"),
      { role: "assistant", content: [{ type: "reasoning", text: "think" }] } as ModelInputMessage,
      user("again"),
    ];
    const folded = foldModelMessagesToSessionLogWire(messages);
    expect(folded.map((event) => event.wire.type)).toEqual([
      "system/message",
      "user/message",
      "assistant/message",
      "tool/result",
      "user/message",
    ]);
    expect(folded.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4]);
    // tool/result 携带工具名与来源消息索引
    expect(folded[3].wire.data).toMatchObject({ toolName: "Bash", text: "ok" });
    expect(folded[3].wire.sourceEventSeqs).toEqual([3]);
  });
});

describe("buildDeepSeekSessionLog 增量语义", () => {
  it("无水印:全量打包;watermark.throughSeq=最后 seq", () => {
    const built = buildDeepSeekSessionLog({
      sessionId: "sess-1",
      messages: [user("a"), assistant("b")],
      watermark: undefined,
      maxBytes: MAX_BYTES,
    });
    expect(built).toBeDefined();
    expect(built?.value.afterSeq).toBe(0);
    expect(built?.value.events.map((event) => event.type)).toEqual([
      "user/message",
      "assistant/message",
    ]);
    expect(built?.throughSeq).toBe(1);
    expect(built?.watermark.throughSeq).toBe(1);
  });

  it("指纹匹配:只打包水印之后的增量(afterSeq=throughSeq)", () => {
    const messages = [user("a"), assistant("b"), user("c")];
    const first = buildDeepSeekSessionLog({
      sessionId: "sess-1",
      messages: messages.slice(0, 2),
      watermark: undefined,
      maxBytes: MAX_BYTES,
    });
    expect(first).toBeDefined();
    const watermark: DeepSeekSessionLogWatermark = first!.watermark;
    expect(watermark.messageCount).toBe(2);
    const second = buildDeepSeekSessionLog({
      sessionId: "sess-1",
      messages,
      watermark,
      maxBytes: MAX_BYTES,
    });
    expect(second).toBeDefined();
    expect(second?.value.afterSeq).toBe(watermark.throughSeq);
    expect(second?.value.events.map((event) => event.type)).toEqual(["user/message"]);
  });

  it("指纹失配(compact/rewind):从 0 全量重发", () => {
    const watermark: DeepSeekSessionLogWatermark = {
      messageCount: 5,
      chainHash: 12345,
      throughSeq: 4,
      createdAt: 1,
    };
    const built = buildDeepSeekSessionLog({
      sessionId: "sess-1",
      messages: [user("compacted summary")],
      watermark,
      maxBytes: MAX_BYTES,
    });
    expect(built).toBeDefined();
    expect(built?.value.afterSeq).toBe(0);
    expect(built?.value.events.length).toBe(1);
  });

  it("无新增事件:返回 undefined(请求不携带字段)", () => {
    const messages = [user("a")];
    const first = buildDeepSeekSessionLog({
      sessionId: "sess-1",
      messages,
      watermark: undefined,
      maxBytes: MAX_BYTES,
    });
    expect(first).toBeDefined();
    const again = buildDeepSeekSessionLog({
      sessionId: "sess-1",
      messages,
      watermark: first!.watermark,
      maxBytes: MAX_BYTES,
    });
    expect(again).toBeUndefined();
  });
});
