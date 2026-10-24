import { parseGoalTimeBudgetFlag } from "@zcode/contracts";
import type { TuiSubmitPromptResult } from "@zcode/tui";
import { attachCurrentSessionMetadata } from "../metadata.js";
import { buildTargetReplaceSelection } from "../selections.js";
import type {
  CommandCenterApp,
  CommandCenterDeps,
  CommandCenterTarget,
  TuiSubmitOptions,
} from "../types.js";
import { splitArgs } from "../utils.js";

const PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE =
  "Plan mode 下已记录 goal，但不会自动继续。";

export async function handleTargetCommand(
  args: string,
  deps: CommandCenterDeps,
  options: TuiSubmitOptions,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  const trimmed = args.trim();

  if (!app.readTarget || !app.setTarget || !app.updateTargetStatus || !app.clearTarget) {
    return {
      mode: deps.getMode?.(),
      response: "Goal management is not available in this client.",
    };
  }

  if (trimmed.length === 0) {
    return {
      mode: deps.getMode?.(),
      response: formatTargetSummary(await app.readTarget()),
    };
  }

  const [action] = splitArgs(trimmed);
  if (action === "time") {
    // `/goal time` 显示当前预算与剩余；`/goal time <dur>` 更新；`/goal time off` 清除。
    const rest = trimmed.slice(action.length).trim();
    if (!rest) {
      const target = await app.readTarget();
      if (!target) {
        return { mode: deps.getMode?.(), response: "No goal is set." };
      }
      return {
        mode: deps.getMode?.(),
        response: formatTargetChanged("Goal time budget", target),
      };
    }
    if (!app.updateTimeBudget) {
      return {
        mode: deps.getMode?.(),
        response: "Goal time budget management is not available in this client.",
      };
    }
    let seconds: number | null;
    if (/^(off|none)$/i.test(rest)) {
      seconds = null;
    } else {
      const durationMatch = rest.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
      const totalSeconds =
        Number(durationMatch?.[1] ?? 0) * 3600 +
        Number(durationMatch?.[2] ?? 0) * 60 +
        Number(durationMatch?.[3] ?? 0);
      if (!durationMatch || totalSeconds <= 0) {
        return {
          mode: deps.getMode?.(),
          response: "Usage: /goal time <duration|off> with duration like 4h, 90m, 2h30m, 45s.",
        };
      }
      seconds = totalSeconds;
    }
    const target = await app.updateTimeBudget(seconds);
    if (!target) {
      return {
        mode: deps.getMode?.(),
        response: "No goal to configure. Use /goal <objective> first.",
      };
    }
    return {
      mode: deps.getMode?.(),
      response: formatTargetChanged("Goal time budget updated", target),
    };
  }

  if (action === "pause") {
    const target = await app.updateTargetStatus("paused");
    return {
      mode: deps.getMode?.(),
      response: target ? formatTargetChanged("Goal paused", target) : "No goal to pause.",
    };
  }

  if (action === "resume") {
    const target = await app.updateTargetStatus("active");
    if (!target) {
      return {
        mode: deps.getMode?.(),
        response: "No goal to resume.",
      };
    }
    return continueTargetAfterChange("Goal resumed", target, app, deps, options);
  }

  if (action === "clear") {
    const cleared = await app.clearTarget();
    return {
      mode: deps.getMode?.(),
      response: cleared ? "Goal cleared." : "No goal to clear.",
    };
  }

  const forceReplace = action === "replace";
  const objective = forceReplace ? trimmed.replace(/^replace\s*/i, "").trim() : trimmed;
  if (forceReplace && objective.length === 0) {
    return {
      mode: deps.getMode?.(),
      response: "Usage: /goal replace <objective>",
    };
  }

  if (!forceReplace) {
    const existing = await app.readTarget();
    if (existing) {
      return {
        mode: deps.getMode?.(),
        response: "A goal already exists. Confirm replacement to overwrite it.",
        selection: buildTargetReplaceSelection(existing, objective),
      };
    }
  }

  // `/goal <objective> --time 4h` 一步带上时间预算；解析失败给 usage 提示而非静默丢弃。
  let timeBudget: number | null | undefined;
  let finalObjective = objective;
  try {
    const parsed = parseGoalTimeBudgetFlag(objective);
    finalObjective = parsed.objective;
    timeBudget = parsed.timeBudgetSeconds;
  } catch (error) {
    return {
      mode: deps.getMode?.(),
      response: error instanceof Error ? error.message : String(error),
    };
  }

  const target = await app.setTarget({
    objective: finalObjective,
    status: "active",
    timeBudget,
  });
  return continueTargetAfterChange("Goal active", target, app, deps, options);
}

async function continueTargetAfterChange(
  title: string,
  target: CommandCenterTarget,
  app: CommandCenterApp,
  deps: CommandCenterDeps,
  options: TuiSubmitOptions,
): Promise<TuiSubmitPromptResult> {
  if (!app.continueActiveTarget) {
    return {
      mode: deps.getMode?.(),
      response: formatTargetChanged(title, target),
    };
  }

  const continuation = await app.continueActiveTarget({
    abortSignal: options.abortSignal,
    onEvent: options.onEvent,
  });
  const response = formatTargetChanged(title, target);
  return continuation
    ? attachCurrentSessionMetadata(continuation, deps, app)
    : {
        mode: deps.getMode?.(),
        response: appendPlanModeGoalContinuationNote(response, deps.getMode?.()),
      };
}

function appendPlanModeGoalContinuationNote(response: string, mode: string | undefined): string {
  return mode === "plan"
    ? `${response}\n\n${PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE}`
    : response;
}

function formatTargetSummary(target: CommandCenterTarget | null): string {
  if (!target) {
    return "No goal is set. Use /goal <objective> to set one.";
  }

  return formatTargetChanged(`Goal ${target.status}`, target);
}

function formatTargetChanged(title: string, target: CommandCenterTarget): string {
  const lines = [title, `Objective: ${target.objective}`];
  if (target.tokensUsed !== undefined || target.tokenBudget !== undefined) {
    const budget = target.tokenBudget === null || target.tokenBudget === undefined
      ? "none"
      : target.tokenBudget.toString();
    lines.push(`Usage: ${target.tokensUsed ?? 0} tokens / ${budget}`);
  }
  if (target.timeUsedSeconds !== undefined || target.timeBudget !== undefined) {
    const timeBudget =
      target.timeBudget === null || target.timeBudget === undefined
        ? "none"
        : target.timeBudget.toString();
    const remaining =
      target.timeBudget === null || target.timeBudget === undefined
        ? undefined
        : Math.max(0, target.timeBudget - (target.timeUsedSeconds ?? 0));
    lines.push(
      `Time: ${target.timeUsedSeconds ?? 0} / ${timeBudget} seconds${
        remaining === undefined ? "" : ` (${remaining} seconds remaining)`
      }`,
    );
  }
  return lines.join("\n");
}
