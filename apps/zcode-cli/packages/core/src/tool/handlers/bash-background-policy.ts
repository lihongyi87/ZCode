import type { BashInput } from "@zcode/contracts";

export function isBashAutoBackgroundEligible(input: BashInput): boolean {
  if (input.run_in_background === true) return false;
  const command = input.command.trim();
  if (command.length === 0) return false;
  const firstToken = command.split(/\s+/u)[0];
  return firstToken !== "sleep";
}

/**
 * 纯等待命令(spec 156)自动转后台的时长下限:sleep 的唯一作用是消耗时间,
 * 有效时长达到该值就不再前台死等,直接走显式后台路径把控制权还给模型。
 */
export const PURE_WAIT_AUTO_BACKGROUND_MIN_SECONDS = 60;

const PURE_WAIT_SLEEP_PATTERN = /^sleep\s+(\d+(?:\.\d+)?)([smh]?)$/u;
const PURE_WAIT_UNIT_MULTIPLIER: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600 };

/**
 * 整条命令是否「只做等待」:单个 `sleep N[s|m|h]`(允许小数),无任何其他语义。
 * `sleep 30 && curl …`、`timeout 5 sleep 60` 这类复合命令不命中——它们有非等待
 * 部分,自动转后台会改变其失败语义;`sleep 45` 等常规轮询间隔保持前台。
 */
export function isPureWaitBashCommand(command: string): boolean {
  const normalized = command.trim();
  if (normalized.length === 0) return false;
  const match = PURE_WAIT_SLEEP_PATTERN.exec(normalized);
  if (!match) return false;
  const multiplier = PURE_WAIT_UNIT_MULTIPLIER[match[2]];
  if (multiplier === undefined) return false;
  const seconds = Number(match[1]) * multiplier;
  return (
    Number.isFinite(seconds) && seconds >= PURE_WAIT_AUTO_BACKGROUND_MIN_SECONDS
  );
}
