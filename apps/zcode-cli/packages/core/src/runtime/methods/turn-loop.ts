import { getTurnTools } from "./turn-tool-visibility.js";
import { appendRuntimeAgentListing } from "../helpers/agent-listing.js";
import { beginLocalTurnPreparation } from "@zcode/contracts";
import {
  CompactPhase,
  CompactReason,
  createMessageId,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import {
  buildRuntimeModeReminderBody,
  buildPlanModeExitReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildTodoReminderBody,
  buildRuntimeProviderRequestMessages,
  createCompactRapidRefillError,
  throwIfTurnAborted,
  shouldBuildTodoReminder,
} from "../helpers/index.js";
import {
  systemReminderAttachmentEntry,
  todoReminderRuntimeMetadata,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { runModelBackedTurnStep } from "./turn-model-step.js";
import {
  evaluateRapidRefill,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  recordCompactHistoryRound,
  recordCompactSuccess,
} from "./turn-loop-state.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { consumeSettledProjectMemoryRecall } from "../helpers/project-memory-recall.js";
// 重植（3.15.1 升级冲掉 turn-loop 接线）：CE 记忆召回提醒——按本轮用户输入对
// .zcode 记忆语料做 embedding+词法融合排序，注入 top-K 记忆锚点。官方 3.15.1 的
// 语义召回分支（startProjectMemoryRecallPrefetch）当前被
// project-memory-retrieval-branch.ts 关在 "default-index"（只改系统提示词文案），
// 这条链是唯一在跑的动态记忆召回。
import { buildMemoryRecallReminderBody } from "./memory-recall-reminder.js";
import { buildKbRecallReminderBody } from "./kb-recall-reminder.js";
import { buildFollowupDueReminderBody } from "./followup-due-reminder.js";
import { buildCaliberGuardReminderBody } from "./caliber-guard-reminder.js";
import { buildUserInstructionsUpdateBody } from "./user-instructions-update-reminder.js";
import { buildTaskReanchorReminderBody, shouldReanchorAtStep } from "./task-reanchor-reminder.js";
import { consumePendingProjectMemoryUpdate } from "../helpers/project-memory-dream.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../../memory/project-memory-retrieval-branch.js";
import {
  appendTurnRequestEntries,
  commitTurnRequestEntries,
  filterOutputTokenContinuationEntries,
} from "./turn-output-token-continuation.js";

export async function runRegularTurnLoop(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<void> {
  // 记忆召回 / kb 召回 / 用户指令热更新按"每次用户 turn 一次"门控（跨 while 迭代——
  // 多步 turn 的后续模型步不重复注入）。
  let memoryRecallAttempted = false;
  let kbRecallAttempted = false;
  let userInstructionsUpdateAttempted = false;
  let kbRecallBodyForCaliber: string | null = null;
  while (true) {
    throwIfTurnAborted(state.turnAbortSignal);
    const outputTokenRecoveryActive = state.turnRequestState.outputTokenContinuationCount > 0;
    // guide 只允许由完整 tool result batch 设置这个一次性诊断；普通 queue 不在
    // model roundtrip 起点消费，避免把未来 turn 错并入当前 product turn。
    const drainedSteerForNextRequest = state.drainedSteerForNextRequest;
    state.drainedSteerForNextRequest = undefined;

    if (state.modelStepCount > 0 && !outputTokenRecoveryActive) {
      const drainedRuntimeCommands = await this.drainPendingRuntimeCommandsForActiveLoop();
      state.backgroundSubagentResultConsumed ||=
        drainedRuntimeCommands.backgroundSubagentResultConsumed;
      state.workflowResultConsumed ||= drainedRuntimeCommands.workflowResultConsumed;
      appendTurnRequestEntries(state.turnRequestState, drainedRuntimeCommands.runtimeEntries);
      if (drainedRuntimeCommands.drained > 0) {
        state.repeatedToolCallSignature = undefined;
        state.repeatedToolCallStreakCount = 0;
      }
    }

    if (state.completedRealToolResultBatch && !outputTokenRecoveryActive) {
      state.completedRealToolResultBatch = false;
      const recallEntry = consumeSettledProjectMemoryRecall(
        this,
        ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
      );
      appendTurnRequestEntries(state.turnRequestState, recallEntry ? [recallEntry] : []);
    }

    const compactPhase =
      state.modelStepCount === 0 ? CompactPhase.PreRequest : CompactPhase.MidTurn;
    await this.microcompactIfNeeded(state.turnTraceContext, state.events, state.turnAbortSignal, {
      model: state.model,
      modelStepIndex: state.modelStepCount,
      phase: compactPhase,
      turnRequestState: state.turnRequestState,
    });
    throwIfTurnAborted(state.turnAbortSignal);

    const rapidRefill = evaluateRapidRefill(state.compactTracking);
    const autoCompactOutcome = await this.autoCompactIfNeeded(
      state.turnTraceContext,
      state.events,
      state.turnAbortSignal,
      {
        getAgentListingTools: () => getTurnTools(this, state),
        compactReason: CompactReason.ContextLimit,
        modelStepIndex: state.modelStepCount,
        phase: compactPhase,
        rapidRefill,
        model: state.model,
        turnRequestState: state.turnRequestState,
      },
    );
    if (autoCompactOutcome === "rapid_refill_blocked") {
      throw createCompactRapidRefillError({
        consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
        maxConsecutiveRapidRefills: MAX_CONSECUTIVE_RAPID_REFILLS,
        toolTurnThreshold: RAPID_REFILL_TOOL_TURN_THRESHOLD,
        toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
      });
    }
    if (autoCompactOutcome === "compacted") {
      recordCompactSuccess(state, rapidRefill);
      recordCompactHistoryRound(state);
    }
    throwIfTurnAborted(state.turnAbortSignal);

    const finishMcp = beginLocalTurnPreparation(state.turnTraceContext, "mcp");
    await this.initializeMcp(state.turnTraceContext);
    // tools/list_changed 只在回合开始前生效。
    await this.refreshMcpToolsIfChanged(state.turnTraceContext);
    finishMcp();
    throwIfTurnAborted(state.turnAbortSignal);
    const finishTools = beginLocalTurnPreparation(state.turnTraceContext, "tools");
    const tools = getTurnTools(this, state);
    finishTools();
    if (!outputTokenRecoveryActive) {
      await appendRuntimeAgentListing(this, state.turnRequestState, tools, state.turnTraceContext);
    }
    if (!outputTokenRecoveryActive && this.needsPlanModeExitReminder) {
      this.needsPlanModeExitReminder = false;
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("plan_mode_exit", buildPlanModeExitReminderBody()),
      ]);
    }
    const runtimeModeReminderBody = outputTokenRecoveryActive
      ? null
      : buildRuntimeModeReminderBody(
          state.turnRequestState.entries,
          this.getMode(),
          this.getPlanEnabled(),
        );
    if (runtimeModeReminderBody) {
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("runtime_mode", runtimeModeReminderBody),
      ]);
    }
    if (
      !outputTokenRecoveryActive &&
      tools.some((tool) => tool.name === "TodoWrite") &&
      shouldBuildTodoReminder(state.turnRequestState.entries)
    ) {
      const currentTodos = await this.readSessionTodosForContext(state.turnTraceContext);
      const reminderBody = buildTodoReminderBody(currentTodos);
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("todo_reminder", reminderBody),
      ]);
      await this.persistSyntheticUserNoticeForSession({
        messageID: createMessageId(),
        metadata: { runtimeMessage: todoReminderRuntimeMetadata() },
        sessionId: this.sessionId,
        source: "todo_reminder",
        text: reminderBody,
        traceContext: state.turnTraceContext,
      });
    }
    const outputStyleReminderBody =
      state.modelStepCount === 0
        ? buildRuntimeOutputStyleReminderBody(state.turnOutputStyle)
        : null;
    if (outputStyleReminderBody) {
      // output_style 是 provider-visible 的当前 turn runtime attachment，
      // 需要进入内存历史参与后续 request 的增量轨迹；但不把它落 session。
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("output_style", outputStyleReminderBody),
      ]);
    }
    // ② 用户指令热更新：AGENTS.md 等中途修改逐 turn stat 检查，变更才注入
    // 新版全文（前缀不动保缓存）。未变更零成本静默。
    if (
      !userInstructionsUpdateAttempted &&
      this.fileSystemPort &&
      this.contextSourceSnapshot?.userInstructions
    ) {
      userInstructionsUpdateAttempted = true;
      const sourcePaths = [
        ...(this.contextSourceSnapshot.userInstructions.sources ?? []).map((s) => s.filePath),
        ...(this.contextSourceSnapshot.userInstructions.sources?.length
          ? []
          : [this.contextSourceSnapshot.userInstructions.filePath]),
      ];
      const instructionsUpdateBody = await buildUserInstructionsUpdateBody({
        runtime: this,
        fileSystem: this.fileSystemPort,
        sourcePaths,
      });
      if (instructionsUpdateBody) {
        commitTurnRequestEntries(this, state.turnRequestState, [
          systemReminderAttachmentEntry("user_instructions_update", instructionsUpdateBody),
        ]);
        this.logger?.info("[user-instructions-update] 指令文件已变更，新版已注入本轮请求", {
          ...traceContextToLogContext(state.turnTraceContext),
        });
      }
    }
    // 记忆召回提醒（重植）：按本轮用户输入对 memoryRoot 语料做 embedding×0.6+词法×0.4
    // 融合排序，注入 top-K 记忆锚点（bench/memory-recall-probe 实测 hit@5 100%/33%）。
    // 无 memoryRoot 或无命中静默跳过。
    if (!memoryRecallAttempted && this.fileSystemPort && this.memoryRoot) {
      memoryRecallAttempted = true;
      const memoryRecallBody = await buildMemoryRecallReminderBody({
        runtime: this,
        fileSystem: this.fileSystemPort,
        memoryRoot: this.memoryRoot,
        entries: state.turnRequestState.entries,
      });
      if (memoryRecallBody) {
        commitTurnRequestEntries(this, state.turnRequestState, [
          systemReminderAttachmentEntry("memory_recall", memoryRecallBody),
        ]);
        this.logger?.info("[memory-recall] 相关记忆清单已注入本轮请求", {
          ...traceContextToLogContext(state.turnTraceContext),
        });
      }
    }
    // P1 知识卡召回：对 .zcode/kb-cards 语料同源排序，注入 top-K 源锚点——
    // 长会话里技能规则被压缩/微压缩吃掉后，这是模型找回断卦铁律的主通道。
    if (!kbRecallAttempted && this.fileSystemPort && this.workingDirectory) {
      kbRecallAttempted = true;
      const kbRecallBody = await buildKbRecallReminderBody({
        runtime: this,
        fileSystem: this.fileSystemPort,
        workingDirectory: this.workingDirectory,
        entries: state.turnRequestState.entries,
      });
      if (kbRecallBody) {
        kbRecallBodyForCaliber = kbRecallBody;
        commitTurnRequestEntries(this, state.turnRequestState, [
          systemReminderAttachmentEntry("kb_recall", kbRecallBody),
        ]);
        this.logger?.info("[kb-recall] 知识锚点已注入本轮请求", {
          ...traceContextToLogContext(state.turnTraceContext),
        });
      }
    }
    // P5 预测回填闭环：会话首 turn 注入已到期/临期的预测登记（builder 内部
    // 按 runtime 一次性触发；未登记/无到期项静默跳过）。
    if (this.workingDirectory && this.fileSystemPort) {
      const followupBody = await buildFollowupDueReminderBody({
        runtime: this,
        fileSystem: this.fileSystemPort,
        workingDirectory: this.workingDirectory,
      });
      if (followupBody) {
        commitTurnRequestEntries(this, state.turnRequestState, [
          systemReminderAttachmentEntry("followup_due", followupBody),
        ]);
        this.logger?.info("[followup-due] 到期预测登记已注入本轮请求", {
          ...traceContextToLogContext(state.turnTraceContext),
        });
      }
    }
    // P2 口径裁决护栏：本轮输入/已召回内容命中已裁决口径注册表时注入
    // 权威源指引（复合键 AND 匹配，防翻案）。未登记/无命中静默。
    if (this.workingDirectory && this.fileSystemPort) {
      const caliberBody = await buildCaliberGuardReminderBody({
        runtime: this,
        fileSystem: this.fileSystemPort,
        workingDirectory: this.workingDirectory,
        entries: state.turnRequestState.entries,
        recalledText: kbRecallBodyForCaliber,
      });
      if (caliberBody) {
        commitTurnRequestEntries(this, state.turnRequestState, [
          systemReminderAttachmentEntry("caliber_guard", caliberBody),
        ]);
        this.logger?.info("[caliber-guard] 已裁决口径护栏已注入本轮请求", {
          ...traceContextToLogContext(state.turnTraceContext),
        });
      }
    }
    // spec 165（吸收 OpenCode runner/max-steps）：maxTurns 步数上限软着陆——达到上限时
    // 不硬断，注入一次「只准文本总结」提醒并关闭本轮工具面（tools 不进 provider 请求，
    // 模型物理上无法再调工具），产出已完成/未完成/建议的收尾后自然 break。
    // undefined = 不限制（子代理历史默认 4 从未生效过，本字段自本版起才真正有读者）。
    const stepLimit = this.config.maxTurns;
    const stepLimitReached =
      stepLimit !== undefined &&
      !outputTokenRecoveryActive &&
      state.modelStepCount >= stepLimit;
    if (stepLimitReached && state.stepLimitNotified !== true) {
      state.stepLimitNotified = true;
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry(
          "max_turns_reached",
          [
            "步骤预算已用完。本轮禁止调用任何工具（工具已对你关闭）。",
            "请只用文本总结：已完成什么、还有什么没做、下一步建议是什么。",
          ].join(""),
        ),
      ]);
      this.logger?.info("[max-turns] 步数上限软着陆：工具面已关闭，等待文本收尾", {
        ...traceContextToLogContext(state.turnTraceContext),
        modelStep: state.modelStepCount,
        maxTurns: stepLimit,
      });
    }
    // 任务再锚定：每 15 个模型步在尾部重申最初任务（防长会话漂移）。
    if (
      !outputTokenRecoveryActive &&
      shouldReanchorAtStep(state.modelStepCount) &&
      state.turnRequestState.entries.some(
        (entry) => "message" in entry && entry.metadata?.source === "real_user",
      )
    ) {
      const reanchorBody = buildTaskReanchorReminderBody(state.turnRequestState.entries);
      if (reanchorBody) {
        commitTurnRequestEntries(this, state.turnRequestState, [
          systemReminderAttachmentEntry("task_reanchor", reanchorBody),
        ]);
        this.logger?.info("[task-reanchor] 已在尾部重申最初任务", {
          ...traceContextToLogContext(state.turnTraceContext),
          modelStep: state.modelStepCount,
        });
      }
    }
    // （2026-09-12）：原"回合开始注入 plugin_ui_state reminder"已删除，插件给模型的信息
    // 一律走 ui/update-model-context。
    const providerEntries = [...state.turnRequestState.entries];
    // Dream 可能在同一 turn 的首个模型请求期间完成；每次 attachment collection 都检查，
    // 才能把一次性更新放进紧随其后的模型请求，而不是延迟到下一次用户输入。
    const memoryUpdate = outputTokenRecoveryActive
      ? undefined
      : consumePendingProjectMemoryUpdate(this);
    const requestEntries = memoryUpdate ? [...providerEntries, memoryUpdate] : providerEntries;
    // 修复原因：provider-visible user ordering projection 会改变最终 latest user 落点，
    // cache-control 必须在 projection 后统一设置，避免 raw synthetic entry 抢占缓存锚点。
    const providerProjection = buildRuntimeProviderRequestMessages(this, {
      entries: requestEntries,
      applyCacheControl: true,
      model: state.model,
    });
    const { messages } = providerProjection;
    const recordableEntries = filterOutputTokenContinuationEntries(requestEntries);
    const recordableProjection =
      recordableEntries === requestEntries
        ? providerProjection
        : buildRuntimeProviderRequestMessages(this, {
            entries: recordableEntries,
            applyCacheControl: true,
            model: state.model,
          });
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.startModelRequest(
        `${state.model.providerId}/${state.model.modelId}`,
        recordableProjection.messages,
      ),
    );

    // 生产包需要知道 Turn 是否已经跨过 provider 边界；这里只记录请求元数据，
    // 不记录 prompt、消息内容或 streaming chunk，避免泄露内容并控制日志量。
    this.logger?.info("Model request started", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "model.request.started",
      module: "core.runtime",
      status: "started",
      messageCount: messages.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    });

    const result = await runModelBackedTurnStep.call(this, state, {
      drainedSteerForNextRequest,
      latestRealUserMessageIndex: providerProjection.diagnostics.latestRealUserMessageIndex,
      messages,
      sourceEntries: providerProjection.sourceEntries,
      requestEntries,
      recordedMessages: recordableProjection.messages,
      // 软着陆轮工具面置空：工具声明不进 provider 请求，模型物理上无法再调工具。
      tools: stepLimitReached ? [] : tools,
    });

    if (result === "break") {
      break;
    }
  }
}
