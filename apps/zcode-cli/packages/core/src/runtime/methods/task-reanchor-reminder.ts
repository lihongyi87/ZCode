import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { modelMessageContentToText } from "../deps.js";

/**
 * 任务再锚定提醒（长会话防漂移）。
 *
 * 注意力探针证明了静态文档检索在 900K 不衰减，但测不到 agent 会话的任务漂移：
 * 多步工具循环里，最初的任务目标在历史深处被后续输出稀释，模型可能悄悄偏题。
 * 对策不是改模型，是在尾部（注意力最强位）按里程碑重申「本轮最初的任务是什么」
 * + 长会话纪律。每 N 个模型步注入一次，增量追加——不改写历史前缀，缓存不受影响。
 */

/** 注入里程碑：每 N 个模型步一次。 */
export const TASK_REANCHOR_STEP_INTERVAL = 15;
/** 原始任务文本进提醒的最大长度。 */
export const TASK_REANCHOR_MAX_CHARS = 500;

export function firstRealUserText(entries: readonly RuntimeMessageEntry[]): string | null {
  for (const entry of entries) {
    if (entry?.kind === "message" && entry.metadata?.source === "real_user") {
      const text = modelMessageContentToText(entry.message.content).trim();
      if (text) return text;
    }
  }
  return null;
}

/** 返回提醒正文；无真实用户输入时返回 null。 */
export function buildTaskReanchorReminderBody(
  entries: readonly RuntimeMessageEntry[],
): string | null {
  const task = firstRealUserText(entries);
  if (!task) return null;
  const excerpt =
    task.length > TASK_REANCHOR_MAX_CHARS ? `${task.slice(0, TASK_REANCHOR_MAX_CHARS)}…` : task;
  return [
    "任务再锚定（长会话防漂移）：",
    `本轮最初的任务是：「${excerpt}」`,
    "长会话纪律：引用事实先查记忆或重读对应文件（被清理的输出留有锚点可重取），勿凭模糊印象继续；对照上面的待办确认当前工作仍服务于最初任务。",
  ].join("\n");
}

/** 是否到达注入里程碑（第 N、2N、3N…个模型步）。 */
export function shouldReanchorAtStep(modelStepCount: number): boolean {
  return modelStepCount > 0 && modelStepCount % TASK_REANCHOR_STEP_INTERVAL === 0;
}
