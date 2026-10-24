import { describe, expect, it } from "vitest";
import { formatGoalStateForModel, parseGoalTimeBudgetFlag } from "../src/tools/target.js";
import type { SessionGoal } from "../src/tools/target.js";

function goal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    sessionID: "s-1" as SessionGoal["sessionID"],
    targetID: "target_1",
    objective: "Do the thing",
    summaryTitle: null,
    status: "active",
    tokenBudget: null,
    timeBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    time: { created: 1, updated: 1 },
    ...overrides,
  };
}

describe("parseGoalTimeBudgetFlag", () => {
  it("无 --time 标记时原样返回 objective 且不设置预算", () => {
    expect(parseGoalTimeBudgetFlag("Ship the release")).toEqual({
      objective: "Ship the release",
      timeBudgetSeconds: undefined,
    });
  });

  it("解析 h/m/s 与组合时长，并把标记从 objective 中剥掉", () => {
    expect(parseGoalTimeBudgetFlag("Do it --time 4h")).toEqual({
      objective: "Do it",
      timeBudgetSeconds: 14400,
    });
    expect(parseGoalTimeBudgetFlag("Do it --time 90m")).toEqual({
      objective: "Do it",
      timeBudgetSeconds: 5400,
    });
    expect(parseGoalTimeBudgetFlag("Do it --time 2h30m")).toEqual({
      objective: "Do it",
      timeBudgetSeconds: 9000,
    });
    expect(parseGoalTimeBudgetFlag("Do it --time 45s")).toEqual({
      objective: "Do it",
      timeBudgetSeconds: 45,
    });
    expect(parseGoalTimeBudgetFlag("Do it --time=1h")).toEqual({
      objective: "Do it",
      timeBudgetSeconds: 3600,
    });
  });

  it("off / none 清除预算；缺 objective 报错", () => {
    expect(parseGoalTimeBudgetFlag("Do it --time off")).toEqual({
      objective: "Do it",
      timeBudgetSeconds: null,
    });
    expect(parseGoalTimeBudgetFlag("Do it --time none")).toEqual({
      objective: "Do it",
      timeBudgetSeconds: null,
    });
    expect(() => parseGoalTimeBudgetFlag("--time off")).toThrow();
  });

  it("非法时长或缺 objective 给 usage 错误，不静默", () => {
    expect(() => parseGoalTimeBudgetFlag("Do it --time 0h")).toThrow();
    expect(() => parseGoalTimeBudgetFlag("Do it --time later")).toThrow();
    expect(() => parseGoalTimeBudgetFlag("--time 4h")).toThrow();
  });
});

describe("formatGoalStateForModel time budget", () => {
  it("无预算显示 none", () => {
    const text = formatGoalStateForModel(goal());
    expect(text).toContain("Time budget: none seconds");
  });

  it("有预算显示秒数", () => {
    const text = formatGoalStateForModel(goal({ timeBudget: 14400, timeUsedSeconds: 90 }));
    expect(text).toContain("Time used: 90 seconds");
    expect(text).toContain("Time budget: 14400 seconds");
  });
});
