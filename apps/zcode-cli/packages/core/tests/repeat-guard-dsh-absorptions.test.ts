import { describe, expect, it } from "vitest";
import { detectRepeatedToolCallWarnings } from "../src/runtime/helpers/model-anomaly.js";
import type { ModelToolCall } from "../deps.js";

/** spec 150:DSH guard 家族(repeat-tool-reminder)同构实现的 streak 检测单测。 */
function call(id: string, name: string, input: unknown): ModelToolCall {
  return { id, name, input } as ModelToolCall;
}

function sameCall(name: string, input: unknown, n: number): ModelToolCall[] {
  return Array.from({ length: n }, (_, index) => call(`call-${index}`, name, input));
}

const CONFIG = { repeatedToolCallWarningThreshold: 3, maxBudgetWarningsPerTurn: 3 };

describe("repeat guard streak detection (spec 150, DSH guard 同构检视)", () => {
  it("stays silent below the threshold", () => {
    const state = {
      anomalyWarningsInjected: 0,
      repeatedToolCallStreakCount: 0,
    };
    const observations = detectRepeatedToolCallWarnings(
      sameCall("Bash", { command: "ls" }, 2),
      state,
      CONFIG,
    );

    expect(observations).toEqual([]);
    expect(state.repeatedToolCallStreakCount).toBe(2);
  });

  it("fires exactly at the threshold with an injected advisory", () => {
    const state = {
      anomalyWarningsInjected: 0,
      repeatedToolCallStreakCount: 0,
    };
    const observations = detectRepeatedToolCallWarnings(
      sameCall("Bash", { command: "ls" }, 3),
      state,
      CONFIG,
    );

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      observedCount: 3,
      threshold: 3,
      warningInjected: true,
    });
    expect(state.anomalyWarningsInjected).toBe(1);
  });

  it("keeps firing past the threshold but stops counting toward the injection budget", () => {
    const state = {
      anomalyWarningsInjected: 3,
      repeatedToolCallStreakCount: 0,
    };
    // 同一次序列走到阈值:第 3 个同签名触发观察,但注入预算已耗尽→warningInjected=false
    const observations = detectRepeatedToolCallWarnings(
      sameCall("Bash", { command: "ls" }, 3),
      state,
      CONFIG,
    );

    expect(observations).toHaveLength(1);
    expect(observations[0]?.observedCount).toBe(3);
    expect(observations[0]?.warningInjected).toBe(false);
    expect(state.anomalyWarningsInjected).toBe(3);
  });

  it("resets the streak when a different signature interleaves", () => {
    const state = {
      anomalyWarningsInjected: 0,
      repeatedToolCallStreakCount: 0,
    };
    const calls = [
      ...sameCall("Bash", { command: "ls" }, 2),
      call("divert", "Read", { path: "x" }),
      ...sameCall("Bash", { command: "ls" }, 2),
    ];
    const observations = detectRepeatedToolCallWarnings(calls, state, CONFIG);

    // 异签名把 streak 重置为 1,后续两次同签名只到 2——全程不触发。
    expect(observations).toEqual([]);
    expect(state.repeatedToolCallStreakCount).toBe(2);
  });

  it("disables itself when the threshold is zero or negative", () => {
    const state = {
      anomalyWarningsInjected: 0,
      repeatedToolCallStreakCount: 0,
    };
    const observations = detectRepeatedToolCallWarnings(
      sameCall("Bash", { command: "ls" }, 5),
      state,
      { repeatedToolCallWarningThreshold: 0 },
    );

    expect(observations).toEqual([]);
  });
});
