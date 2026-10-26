import { describe, expect, it } from "vitest";
import {
  packDeepSeekSessionLog,
  type DeepSeekSessionLogPendingEvent,
} from "../src/deepseek/session-log-wire.js";

/** spec 157:dsh_session_log 增量打包纯函数(语义对齐 DSH session-log-deepseek)。 */

const HEADER = {
  version: 1,
  id: "sess-1",
  createdAt: 1_700_000_000_000,
  cwd: "/workspace",
};

const pendingWire = (
  seq: number,
  type = "user/message",
  data: unknown = { text: `msg-${seq}` },
): DeepSeekSessionLogPendingEvent => ({
  seq,
  wire: { type, seq, time: seq * 1000, data },
});

describe("packDeepSeekSessionLog", () => {
  it("水位之后的事件全量打包,throughSeq=最后一条 seq", () => {
    const result = packDeepSeekSessionLog({
      session: HEADER,
      sessionFormatVersion: 1,
      afterSeq: 2,
      pending: [pendingWire(3), pendingWire(4), pendingWire(5)],
      maxBytes: 8 * 1024 * 1024,
    });
    expect(result.packed).toBe(true);
    if (result.packed) {
      expect(result.throughSeq).toBe(5);
      expect(result.eventCount).toBe(3);
      expect(result.value.afterSeq).toBe(2);
      expect(result.value.version).toBe(1);
      expect(result.value.session.id).toBe("sess-1");
    }
  });

  it("maxBytes 装不下时截断到可容纳的最长前缀", () => {
    const result = packDeepSeekSessionLog({
      session: HEADER,
      sessionFormatVersion: 1,
      afterSeq: 0,
      pending: [pendingWire(1), pendingWire(2, "assistant/message", { text: "x".repeat(6000) })],
      maxBytes: 2048,
    });
    expect(result.packed).toBe(true);
    if (result.packed) {
      expect(result.eventCount).toBe(1);
      expect(result.throughSeq).toBe(1);
    }
  });

  it("首个事件单独超限:字段省略并报 blockedAtSeq(DSH 同语义)", () => {
    const result = packDeepSeekSessionLog({
      session: HEADER,
      sessionFormatVersion: 1,
      afterSeq: 0,
      pending: [pendingWire(1, "user/message", { text: "x".repeat(9000) })],
      maxBytes: 2048,
    });
    expect(result.packed).toBe(false);
    if (!result.packed) {
      expect(result.blockedAtSeq).toBe(1);
      expect(result.neededBytes).toBeGreaterThan(2048);
    }
  });

  it("首个待传事件 seq 落后水位:明确报错(调用方 fold 缺陷,不静默)", () => {
    expect(() =>
      packDeepSeekSessionLog({
        session: HEADER,
        sessionFormatVersion: 1,
        afterSeq: 5,
        pending: [pendingWire(3)],
        maxBytes: 8 * 1024 * 1024,
      }),
    ).toThrow(/behind watermark/);
  });

  it("序列化失败的事件计 Infinity(阻止该前缀,与 DSH 同语义)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = packDeepSeekSessionLog({
      session: HEADER,
      sessionFormatVersion: 1,
      afterSeq: 0,
      pending: [pendingWire(1, "user/message", circular)],
      maxBytes: 8 * 1024 * 1024,
    });
    expect(result.packed).toBe(false);
  });
});
