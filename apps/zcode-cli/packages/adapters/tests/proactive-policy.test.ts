import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROACTIVE_POLL_INTERVAL_MS,
  resolveProactiveOrchestrationPolicy,
} from "../src/proactive/policy.js";

/**
 * spec 154：主动编排的同意闸门。
 *
 * 这是「防意外自动执行」的最后一道边界——会话在没有用户同意时不能自己动起来。
 * 因此默认值必须是关闭，且总开关关时任何工作区都不算允许（双重闸门）。
 */
describe("resolveProactiveOrchestrationPolicy", () => {
  it("未配置时默认关闭", () => {
    const policy = resolveProactiveOrchestrationPolicy(undefined);
    expect(policy.enabled).toBe(false);
    expect(policy.isWorkspaceAllowed("any-workspace")).toBe(false);
    expect(policy.pollIntervalMs).toBe(DEFAULT_PROACTIVE_POLL_INTERVAL_MS);
  });

  it("显式 enabled=false 即使列了工作区也全部拒绝", () => {
    const policy = resolveProactiveOrchestrationPolicy({
      enabled: false,
      allowedWorkspaceKeys: ["ws-1"],
    });
    expect(policy.enabled).toBe(false);
    expect(policy.isWorkspaceAllowed("ws-1")).toBe(false);
  });

  it("开启但没有列任何工作区时，全部拒绝（等于没同意任何地方）", () => {
    const policy = resolveProactiveOrchestrationPolicy({ enabled: true });
    expect(policy.enabled).toBe(true);
    expect(policy.isWorkspaceAllowed("ws-1")).toBe(false);
  });

  it("开启且列入名单的工作区才允许", () => {
    const policy = resolveProactiveOrchestrationPolicy({
      enabled: true,
      allowedWorkspaceKeys: ["ws-1"],
    });
    expect(policy.isWorkspaceAllowed("ws-1")).toBe(true);
    expect(policy.isWorkspaceAllowed("ws-2")).toBe(false);
  });

  it("非法轮询间隔回退到默认值", () => {
    expect(
      resolveProactiveOrchestrationPolicy({ enabled: true, pollIntervalMs: 0 }).pollIntervalMs,
    ).toBe(DEFAULT_PROACTIVE_POLL_INTERVAL_MS);
    expect(
      resolveProactiveOrchestrationPolicy({ enabled: true, pollIntervalMs: -5 }).pollIntervalMs,
    ).toBe(DEFAULT_PROACTIVE_POLL_INTERVAL_MS);
  });

  it("合法轮询间隔被采用", () => {
    expect(
      resolveProactiveOrchestrationPolicy({ enabled: true, pollIntervalMs: 1_000 }).pollIntervalMs,
    ).toBe(1_000);
  });
});
