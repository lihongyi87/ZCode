import {
  createConfiguredHookRunner,
  createInMemoryHookRunner,
  createSessionMailboxHookRegistrations,
  createToolExecutor,
  getCurrentTraceContext,
  registerBuiltInTools,
  traceContextToLogContext,
} from "../deps.js";
import type { HookRunner, SessionId, ToolExecutor, TraceContext } from "../deps.js";
import type { KbSearchInput } from "@zcode/contracts";
import type { SessionSearchInput, SessionSearchOutput } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeDeps } from "../types.js";
import { resolveRuntimeEmbeddedSearchEnabled } from "../methods/embedded-search-branch.js";
import { searchAndActivateDeferredTools } from "./tool-deferral.js";
import { searchKbCorpus } from "../methods/kb-search.js";
import { getSessionShellSelectionFromConfig } from "../methods/session-shell-environment.js";
import { createRuntimeSessionModePort } from "../session-mode-port.js";
import { shouldSuppressSealedSubagentBashNotification } from "../../runtime-task/notification-policy.js";
import {
  resolveBuiltInToolAllowlist,
  resolveRuntimeDisallowedTools,
  resolveRuntimeDynamicWorkflowToolsIncluded,
} from "./tool-allowlist.js";
import { isStaleBranchRuntimeTaskEvent } from "../methods/runtime-command-generation.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";
import { sessionHasLoadedSkill } from "../../agent/loaded-skills.js";

import type { TurnId } from "@zcode/contracts";

/**
 * 任务消息唤醒深度状态(spec 149)。
 *
 * 记录「当前 turn 是被 depth=N 的任务消息唤醒/注入」这一事实,发送侧据此递增:
 * 被唤醒 turn 内的再发送 depth=N+1;人驱动 turn 的发送 depth=0。
 * 以 turnId 绑定:guide steer 注入与当前 turn 同 id(可计);Stop 唤醒产生的新 turn
 * id 不同(计 0)——宁可少计不可多计,护栏只允许被低估。
 */
export interface TaskMessageWakeState {
  turnId: TurnId | undefined;
  depth: number;
}

const wakeDepthByRuntime = new WeakMap<object, TaskMessageWakeState>();

/** drain 注入成功后记录;同一 turn 内多条取最大深度。 */
export function recordTaskMessageWakeDepth(
  runtime: object,
  turnId: TurnId | undefined,
  depth: number,
): void {
  const existing = wakeDepthByRuntime.get(runtime);
  const merged =
    existing && existing.turnId === turnId ? Math.max(existing.depth, depth) : depth;
  wakeDepthByRuntime.set(runtime, { turnId, depth: merged });
}

/** 发送侧取当前 turn 的唤醒深度;非唤醒 turn(人驱动)返回 undefined → 发送 depth=0。 */
export function resolveOutgoingTaskMessageDepth(
  runtime: object,
  activeTurnId: TurnId | undefined,
): number | undefined {
  const state = wakeDepthByRuntime.get(runtime);
  if (!state || activeTurnId === undefined || state.turnId !== activeTurnId) {
    return undefined;
  }
  return state.depth;
}

const DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS = 3_600_000;
const EMPTY_RUNTIME_HOOK_CONFIG = {
  enabled: false,
  events: {},
  maxOutputBytes: 32_768,
  timeoutMs: 60_000,
} as const;

export function initializeRuntimeTooling(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  sessionId: SessionId,
): { executor: ToolExecutor; hookRunner?: HookRunner } {
  registerRuntimeBuiltInTools(runtime, deps);
  const hookRunner = createRuntimeHookRunner(runtime, deps, sessionId);
  return {
    executor: deps.toolExecutor ?? createRuntimeToolExecutor(runtime, deps, hookRunner),
    hookRunner,
  };
}

function registerRuntimeBuiltInTools(runtime: AgentRuntimeInternal, deps: AgentRuntimeDeps): void {
  const nodeReplEnabled = runtime.config.runtimeFeatures?.nodeRepl === true;
  const browserUseEnabled = resolveRuntimeBrowserUseEnabled(runtime, deps);
  registerBuiltInTools(runtime.registry, {
    bashTimeoutPolicy: runtime.config.bashTimeoutPolicy,
    includeSkill: Boolean(runtime.skillPort),
    includeAgent: Boolean(runtime.subagentPort),
    includeLsp: Boolean(runtime.lspPort?.availableLanguages().length),
    includeSendMessage: runtime.subagentPort?.sendMessage !== undefined,
    includeRespondToCoordinator:
      runtime.config.taskType === "subagent_child" && Boolean(deps.coordinatorResponsePort),
    // submit_result 只在注入了 workflowSubmitPort 的 workflow actor 会话注册。以端口存在为门，
    // 与 taskType 无关：workflow actor 是 workflow_child，其 runtimeScope 目前是 "main"。
    includeSubmitResult: Boolean(deps.workflowSubmitPort),
    // mono 子代理：typed 声明。门仍是端口。
    ...(deps.workflowSubmitSchema === undefined
      ? {}
      : { submitResultSchema: deps.workflowSubmitSchema }),
    // escalate 与 submit_result 同门同理由：端口在场即注册（不做 opt-in：最可能撞墙的 actor 恰是作者没标记的那个）。
    includeEscalate: Boolean(deps.workflowEscalatePort),
    includeWorkflow: Boolean(deps.workflowPort),
    includeAutomation: Boolean(deps.automationPort) && runtime.config.taskType !== "subagent_child",
    // offPeakPort 只在 host 下发 offPeakToolEnabled 时注入（灰度/远程门在 host 端），
    // 端口存在即代表曝光允许；subagent 子会话与 automation 同规则不暴露。
    includeOffPeak: Boolean(deps.offPeakPort) && runtime.config.taskType !== "subagent_child",
    // 动态工作流灰度门：与 off-peak 相反，
    // 这里不能用端口在场做判据——十个工具的端口在任何 CLI 里都装配齐全，灰度是 Host 的决定。
    // 取值收在 tool-allowlist.ts，与分支刷新那个入口共用同一个推导。
    includeDynamicWorkflow: resolveRuntimeDynamicWorkflowToolsIncluded(runtime),
    // 修复原因：browserControlPort 只是宿主能力，不应隐式暴露高权限 node_repl。
    // node_repl/browser-use 由 ZCode 官方 browser-use 插件启停推导出的 runtimeFeatures 控制。
    includeNodeRepl: nodeReplEnabled,
    includeBrowserUse: browserUseEnabled,
    // KbSearch 需要文件系统（语料索引与卡目录）；无文件系统的受限 runtime 不暴露。
    includeKbSearch: Boolean(deps.fileSystemPort),
    embeddedSearchEnabled: resolveRuntimeEmbeddedSearchEnabled(runtime),
    allowedTools: resolveBuiltInToolAllowlist(runtime.config),
    // workflow_child 的结构性禁用（CreateWorkflow/SaveWorkflow 因 alwaysAsk 隐形挂起；
    // ResumeWorkflowRun 已免确认但因「child 内不得再编排」仍在列）在 helper
    // 里与 turn 级名单合并，见 tool-allowlist.ts 的根因注释。
    disallowedTools: resolveRuntimeDisallowedTools(runtime.config),
  });
}

function createRuntimeHookRunner(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  sessionId: SessionId,
): HookRunner | undefined {
  let hookRunner =
    deps.hookRunner ??
    ((runtime.config.hooks?.enabled || deps.workspaceHookSnapshot) && deps.executionPort
      ? createConfiguredHookRunner({
          config: runtime.config.hooks ?? EMPTY_RUNTIME_HOOK_CONFIG,
          emitEvent: async (event) => {
            await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
          },
          executionPort: deps.executionPort,
          getWorkingDirectory: () => runtime.workingDirectory,
          logger: runtime.logger,
          workspaceHookAdmission: deps.workspaceHookAdmission,
          workspaceHookSnapshot: deps.workspaceHookSnapshot,
        })
      : undefined);

  if (!deps.sessionMailboxPort) {
    return hookRunner;
  }

  hookRunner ??= createInMemoryHookRunner({
    emitEvent: async (event) => {
      if (isStaleBranchRuntimeTaskEvent(runtime, event)) return;
      await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
    },
    logger: runtime.logger,
  });
  for (const hook of createSessionMailboxHookRegistrations({
    enqueuePendingInput: async (input, traceContext, meta) => {
      const result = await runtime.steerTurn({
        delivery: "guide",
        expectedTurnId: traceContext.turnId,
        input,
        // spec 149:信箱消息经 steer 注入时携带来源,投影层据此打 task_message 徽标。
        ...(meta?.steerSource && meta.fromSessionId
          ? {
              source: meta.steerSource,
              taskMessageOrigin: {
                fromSessionId: meta.fromSessionId,
                ...(meta.senderLabel !== undefined ? { senderLabel: meta.senderLabel } : {}),
                ...(meta.wakeDepth !== undefined ? { depth: meta.wakeDepth } : {}),
              },
            }
          : {}),
        traceContext,
      });
      if (result.kind === "rejected") {
        runtime.logger?.warn("Session mailbox input was not queued", {
          ...traceContextToLogContext(traceContext),
          event: "session.mailbox.queue_rejected",
          module: "core.runtime",
          reason: result.reason,
          status: "completed",
        });
        return;
      }
      // 注入成功即记录本 turn 的唤醒深度:该 turn 内的再发送 depth=N+1(spec 149)。
      if (meta?.wakeDepth !== undefined) {
        recordTaskMessageWakeDepth(runtime, traceContext.turnId, meta.wakeDepth);
      }
    },
    mailbox: deps.sessionMailboxPort,
    sessionId,
  })) {
    if ("register" in hookRunner && typeof hookRunner.register === "function") {
      hookRunner.register(hook);
    }
  }
  return hookRunner;
}

function createRuntimeToolExecutor(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  hookRunner: HookRunner | undefined,
): ToolExecutor {
  const browserUseEnabled = resolveRuntimeBrowserUseEnabled(runtime, deps);
  return createToolExecutor({
    agentTelemetry: runtime.agentTelemetry.port,
    agentTelemetryActorKind: runtime.agentTelemetry.actorKind,
    registry: runtime.registry,
    permissionService: runtime.permissionService,
    permissionBroker: runtime.permissionBroker,
    emitEvent: async (event) => {
      await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
    },
    enqueueBackgroundTaskNotification: (notification) => {
      runtime.enqueueBackgroundTaskNotification(notification);
    },
    shouldEnqueueBackgroundTaskNotification: (input) =>
      shouldEnqueueRuntimeBackgroundTaskNotification(runtime, input),
    logger: runtime.logger,
    backgroundTaskControlPort: {
      stopBackgroundTask: runtime.stopBackgroundTask.bind(runtime),
    },
    toolSearchControlPort: {
      search: async (query: string, limit?: number) =>
        searchAndActivateDeferredTools(runtime, query, limit),
    },
    // SessionSearch（spec 162）：跨会话只读检索。生产装配的 SqliteSessionStore 带
    // searchSessionContent；内存测试 store 没有该方法则端口缺席，handler 诚实报
    // 「能力不可用」。不进 SessionStorePort，避免全体实现者跟随。
    ...(runtime.sessionStore &&
    typeof (runtime.sessionStore as { searchSessionContent?: unknown }).searchSessionContent === "function"
      ? {
          sessionHistorySearchPort: {
            search: (
              request: SessionSearchInput,
              context: { currentSessionId?: string; currentDirectory: string },
            ) =>
              (runtime.sessionStore as unknown as {
                searchSessionContent: (
                  request: SessionSearchInput,
                  context: { currentSessionId?: string; currentDirectory: string },
                ) => Promise<SessionSearchOutput>;
              }).searchSessionContent(request, {
                ...context,
                currentSessionId: context.currentSessionId ?? runtime.sessionId,
              }),
          },
        }
      : {}),
    // KbSearch（140 §P1-5）：与每轮 kb_recall 共用索引与召回缓存；文件系统缺席时
    // 不装配端口，handler 诚实报「能力不可用」。
    ...(deps.fileSystemPort
      ? {
          kbSearchControlPort: {
            search: (request: KbSearchInput) =>
              searchKbCorpus({
                runtime,
                fileSystem: deps.fileSystemPort!,
                workingDirectory: runtime.workingDirectory,
                request,
              }),
          },
        }
      : {}),
    executionPort: deps.executionPort,
    browserControlPort: browserUseEnabled ? deps.browserControlPort : undefined,
    browserDocumentationRoot: browserUseEnabled
      ? runtime.config.runtimeFeatures?.browserDocumentationRoot
      : undefined,
    fileSystemPort: deps.fileSystemPort,
    httpClientPort: deps.httpClientPort,
    imageProcessorPort: deps.imageProcessorPort,
    // 合并删除旧模型连接时曾漏掉此端口；Read 分页渲染与整份 PDF 页数检查仍依赖宿主注入。
    pdfDocumentPort: deps.pdfDocumentPort,
    embeddedSearchBackend: runtime.config.embeddedSearchBackend,
    nativeSearchEnhancementsEnabled: runtime.config.nativeSearchEnhancementsEnabled,
    // 工具策略：以前只存在于 settings 与 executor 类型里，装配点没传 ⇒ 设置页永不生效。
    dangerousCommandPolicy: runtime.config.dangerousCommandPolicy,
    skillPort: deps.skillPort,
    subagentPort: runtime.subagentPort,
    lspPort: runtime.lspPort,
    coordinatorResponsePort: deps.coordinatorResponsePort,
    workflowSubmitPort: deps.workflowSubmitPort,
    workflowEscalatePort: deps.workflowEscalatePort,
    artifactStore: deps.artifactStore,
    automationPort: deps.automationPort,
    offPeakPort: deps.offPeakPort,
    topicResourcePort: deps.topicResourcePort,
    sessionStore: deps.sessionStore,
    sessionModePort: createRuntimeSessionModePort(runtime),
    workflowPort: deps.workflowPort,
    dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort,
    dynamicWorkflowSnippetPort: deps.dynamicWorkflowSnippetPort,
    modelCatalogPort: deps.modelCatalogPort,
    runtimeTaskRegistry: runtime.runtimeTaskRegistry,
    readFileState: runtime.readFileState,
    // 工作流创作工具的技能门（tool/handlers/workflow-skill-gate.ts）：按模型此刻看得见的历史回答
    // 「读过技能没有」。只在会话真有 Skill 工具时给探针——没有 skillPort 的会话装不上那个技能，
    // 门若仍然在场就成了一道谁也过不去的墙。
    ...(deps.skillPort === undefined
      ? {}
      : {
          hasLoadedSkill: (skillName: string) =>
            sessionHasLoadedSkill(runtime.messageHistory.borrowReadOnlyRuntimeEntries(), skillName),
        }),
    subagentBackgroundBashMaxMs:
      runtime.config.taskType === "subagent_child"
        ? normalizeSubagentBackgroundBashMaxMs(runtime.config.subagents?.backgroundBashMaxMs)
        : undefined,
    getBashShellSelection: () => getSessionShellSelectionFromConfig(runtime.config),
    hookRunner,
    getWorkingDirectory: () => runtime.workingDirectory,
    setWorkingDirectory: runtime.setWorkingDirectory.bind(runtime),
    getWorkspaceRoot: () => runtime.workspaceRoot,
    workspaceIdentity: runtime.config.workspaceIdentity?.toString(),
    remoteSessionId: runtime.config.remoteSessionId,
    clientMode: runtime.config.clientMode,
    deliveryKind: runtime.config.deliveryKind,
    getMemoryRoot: () =>
      deps.memoryRoot ?? resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot),
    runtimeScope: runtime.config.taskType === "subagent_child" ? "subagent" : "main",
    permissionTimeoutMs: runtime.config.permissionTimeoutMs,
    sessionId: runtime.sessionId,
    traceContext: runtime.rootTraceContext,
    getMode: () => runtime.config.mode ?? "build",
    maxConcurrency: runtime.config.toolConcurrency?.maxConcurrency,
  });
}

function resolveRuntimeBrowserUseEnabled(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
): boolean {
  return (
    runtime.config.runtimeFeatures?.browserUse === true && deps.browserControlPort !== undefined
  );
}

function shouldEnqueueRuntimeBackgroundTaskNotification(
  runtime: AgentRuntimeInternal,
  input: {
    status: string;
    taskId: string;
    toolName: string;
    traceContext: TraceContext;
  },
): boolean {
  if (runtime.shuttingDown) {
    runtime.logger?.info?.("Suppressed background task notification during runtime shutdown", {
      ...traceContextToLogContext(input.traceContext),
      event: "runtime.background_task_notification.shutdown_suppressed",
      module: "core.runtime",
      taskId: input.taskId,
      taskStatus: input.status,
      toolName: input.toolName,
    });
    return false;
  }
  const registryTask = runtime.runtimeTaskRegistry.get(input.taskId);
  if (
    !shouldSuppressSealedSubagentBashNotification({
      isSubagentChildRuntime: runtime.config.taskType === "subagent_child",
      notificationSealed: runtime.backgroundTaskNotificationsSealed,
      registryTask,
      toolName: input.toolName,
    })
  ) {
    return true;
  }
  runtime.logger?.info?.("Suppressed sealed subagent background Bash notification", {
    ...traceContextToLogContext(input.traceContext),
    event: "runtime.background_task_notification.suppressed",
    module: "core.runtime",
    reason: runtime.backgroundTaskNotificationSealReason,
    taskId: input.taskId,
    taskStatus: input.status,
    toolName: input.toolName,
  });
  return false;
}

function normalizeSubagentBackgroundBashMaxMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS;
  }
  return Math.trunc(value);
}
