import { describe, expect, it } from "vitest";
import {
  formatGoalStateForModel,
  goalMinimumTimeRemaining,
  parseGoalDurationPhrases,
  parseGoalTimeBudgetFlag,
} from "../src/tools/target.js";
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

describe("parseGoalDurationPhrases", () => {
  it("中文下限短语 → minTimeSeconds（用户说「至少做4个小时」）", () => {
    expect(parseGoalDurationPhrases("重构认证模块，要求至少做4个小时")).toEqual({
      minTimeSeconds: 14400,
    });
    expect(parseGoalDurationPhrases("压测服务，做满一个半小时再停")).toEqual({
      minTimeSeconds: 5400,
    });
    expect(parseGoalDurationPhrases("监控日志，至少运行90分钟")).toEqual({
      minTimeSeconds: 5400,
    });
  });

  it("中文上限短语 → timeBudgetSeconds", () => {
    expect(parseGoalDurationPhrases("清理构建缓存，不超过2小时")).toEqual({
      timeBudgetSeconds: 7200,
    });
    expect(parseGoalDurationPhrases("全量回归，限时3小时")).toEqual({
      timeBudgetSeconds: 10800,
    });
    expect(parseGoalDurationPhrases("观察内存曲线4小时以内")).toEqual({
      timeBudgetSeconds: 14400,
    });
  });

  it("上下限同设（至少X且不超过Y）", () => {
    expect(
      parseGoalDurationPhrases("烧 soak 测试：至少运行2小时，不超过6小时"),
    ).toEqual({ minTimeSeconds: 7200, timeBudgetSeconds: 21600 });
  });

  it("英文短语", () => {
    expect(parseGoalDurationPhrases("soak the server for at least 4 hours")).toEqual({
      minTimeSeconds: 14400,
    });
    expect(parseGoalDurationPhrases("finish the migration within 90 minutes")).toEqual({
      timeBudgetSeconds: 5400,
    });
  });

  it("裸时长（无意图关键词）忽略——漏识别安全，错识别会把「至少」当上限反着停", () => {
    expect(parseGoalDurationPhrases("跑一个 4 小时的压测并写报告")).toEqual({});
  });

  it("十一以上中文数词保守不支持（漏识别安全）", () => {
    expect(parseGoalDurationPhrases("至少做十五个小时")).toEqual({});
  });
});

describe("goalMinimumTimeRemaining", () => {
  it("无下限或已达标返回 null", () => {
    expect(goalMinimumTimeRemaining({ minTimeSeconds: null, timeUsedSeconds: 10 })).toBeNull();
    expect(goalMinimumTimeRemaining({ minTimeSeconds: undefined, timeUsedSeconds: 0 })).toBeNull();
    expect(goalMinimumTimeRemaining({ minTimeSeconds: 60, timeUsedSeconds: 60 })).toBeNull();
  });

  it("未到下限返回剩余秒数", () => {
    expect(goalMinimumTimeRemaining({ minTimeSeconds: 14400, timeUsedSeconds: 90 })).toBe(14310);
  });
});
