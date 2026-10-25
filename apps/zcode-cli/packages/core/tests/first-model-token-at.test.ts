import { describe, expect, it } from "vitest";
import { SessionEventType } from "@zcode/contracts";
import { firstModelTokenAt } from "../src/runtime/methods/usage-observability.js";

/**
 * 首 token 时间口径（与 DSH `isTokenDelta` 对齐）。
 *
 * 背景：用户实测显示 497 tok/s。decode 速度 = outputTokens / (完成时刻 - 首 token)。
 * 旧口径只认 text/reasoning 增量——但 DSH 把「工具调用参数增量」也视为模型产出 token。
 * 两边口径不一致时，工具调用步的 token 与时间基准会错配。
 */

let clock = 0;
function streaming(kind: string, payload: Record<string, unknown> = {}) {
  clock += 100;
  return {
    type: SessionEventType.ModelStreaming,
    timestamp: new Date(clock),
    payload: { kind, ...payload },
  };
}

function resetClock() {
  clock = 1_700_000_000_000;
}

describe("firstModelTokenAt", () => {
  it("文本增量作为首 token", () => {
    resetClock();
    const events = [streaming("text_delta", { delta: "你" })];
    expect(firstModelTokenAt(events as never, 0)).toBe(events[0].timestamp.getTime());
  });

  it("推理增量同样作为首 token", () => {
    resetClock();
    const events = [streaming("reasoning_delta", { delta: "想" })];
    expect(firstModelTokenAt(events as never, 0)).toBe(events[0].timestamp.getTime());
  });

  it("工具调用参数增量作为首 token（对齐 DSH isTokenDelta）", () => {
    resetClock();
    const events = [streaming("tool_input_delta", { delta: '{"path"', toolCallId: "c1" })];
    expect(firstModelTokenAt(events as never, 0)).toBe(events[0].timestamp.getTime());
  });

  it("带名字的 tool_call 起始不算首 token（本仓工具参数缓冲后 flush，该事件贴近步完成）", () => {
    resetClock();
    const events = [streaming("tool_call", { toolName: "Bash", toolCallId: "c1" })];
    expect(firstModelTokenAt(events as never, 0)).toBeUndefined();
  });

  it("空 delta 与生命周期事件不算首 token", () => {
    resetClock();
    const events = [
      streaming("start"),
      streaming("text_start"),
      streaming("text_delta", { delta: "" }),
      streaming("reasoning_start"),
      streaming("tool_input_delta", { delta: "" }),
      streaming("tool_call", { toolCallId: "c1" }),
      streaming("finish"),
    ];
    expect(firstModelTokenAt(events as never, 0)).toBeUndefined();
  });

  it("只扫描 startIndex 之后的事件（跨 try 取最早，不取历史步）", () => {
    resetClock();
    const history = [streaming("text_delta", { delta: "上一步" })];
    const fresh = [streaming("text_delta", { delta: "本步" })];
    const events = [...history, ...fresh];
    expect(firstModelTokenAt(events as never, history.length)).toBe(fresh[0].timestamp.getTime());
  });

  it("非 ModelStreaming 事件被跳过", () => {
    resetClock();
    const events = [
      { type: SessionEventType.ModelRequest, timestamp: new Date(clock), payload: {} },
      streaming("text_delta", { delta: "答" }),
    ];
    expect(firstModelTokenAt(events as never, 0)).toBe(events[1].timestamp.getTime());
  });
});
