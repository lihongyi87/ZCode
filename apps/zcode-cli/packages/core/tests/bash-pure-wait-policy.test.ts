import { describe, expect, it } from "vitest";
import {
  isPureWaitBashCommand,
  PURE_WAIT_AUTO_BACKGROUND_MIN_SECONDS,
} from "../src/tool/handlers/bash-background-policy.js";

/**
 * spec 156:纯等待命令识别。sleep 的唯一作用是消耗时间,有效时长 ≥ 阈值时
 * handler 会在入口改写为 run_in_background;识别必须收窄到"只做等待"的命令,
 * 有非等待部分的复合命令一律不命中(转后台会改变其失败语义)。
 */

describe("isPureWaitBashCommand", () => {
  it("阈值:达到 60s 才命中", () => {
    expect(PURE_WAIT_AUTO_BACKGROUND_MIN_SECONDS).toBe(60);
    expect(isPureWaitBashCommand("sleep 60")).toBe(true);
    expect(isPureWaitBashCommand("sleep 59")).toBe(false);
  });

  it.each([
    ["sleep 240", 240],
    ["sleep 240s", 240],
    ["sleep 2m", 120],
    ["sleep 1.5m", 90],
    ["sleep 0.5h", 1800],
  ])("%s 命中(%is)", (command) => {
    expect(isPureWaitBashCommand(command)).toBe(true);
  });

  it("短 sleep 与非 sleep 命令不命中", () => {
    expect(isPureWaitBashCommand("sleep 45")).toBe(false);
    expect(isPureWaitBashCommand("sleep")).toBe(false);
    expect(isPureWaitBashCommand("echo hi")).toBe(false);
    expect(isPureWaitBashCommand("")).toBe(false);
  });

  it("带非等待语义的复合命令不命中", () => {
    expect(isPureWaitBashCommand("sleep 30 && sleep 40")).toBe(false);
    expect(isPureWaitBashCommand("sleep 30; curl example.com")).toBe(false);
    expect(isPureWaitBashCommand("timeout 5 sleep 60")).toBe(false);
    expect(isPureWaitBashCommand("echo waiting && sleep 60")).toBe(false);
  });

  it("前后空白不影响判定", () => {
    expect(isPureWaitBashCommand("  sleep 120  ")).toBe(true);
  });
});
