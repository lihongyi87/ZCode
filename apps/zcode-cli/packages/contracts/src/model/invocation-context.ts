import type { RequestVerificationReason } from "@zcode/shared";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import type { ModelApiCallObservation } from "../telemetry/index.js";
import type { TraceContext } from "../tracing/tracer.js";
import type {
  ModelRequestAdmission,
  ModelRequestSessionType,
  ModelRetryBudget,
  ModelStatusSink,
  ModelStreamRecoveryStatus,
} from "./index.js";

/**
 * 会话用过的能力标签，adapter 写入归因 header `x-zcode-session-features`
 * （docs/design/v2/model/session-features-header.md）。
 * 词表只追加、不改名；废弃的标签保留常量，不复用名字。值必须是小写 snake_case。
 */
export const ModelRequestSessionFeature = {
  /** 模型代码经 node_repl 调用了浏览器运行时，不论成败；旧路径（core 内置 js 工具）不打。 */
  BrowserUse: "browser_use",
  /** 模型代码经 node_repl 调用了 Computer Use 运行时，或调用了旧版 computer-use MCP 工具，不论成败。 */
  ComputerUse: "computer_use",
  /** 模型调用 ToolSearch（local 模式下名为 LocalToolSearch）且执行成功。 */
  ToolSearchCalled: "tool_search_called",
  /** 主循环请求的 ToolSearch 实际生效模式为 local。 */
  ToolSearchLocal: "tool_search_local",
  /** 主循环请求的 ToolSearch 实际生效模式为 native。 */
  ToolSearchNative: "tool_search_native",
  /** 模型调用 CreateWorkflow 成功启动了后台 run。 */
  WorkflowAuto: "workflow_auto",
  /** 用户输入的内置 `/workflow` 命令被展开为工作流模板。 */
  WorkflowCmd: "workflow_cmd",
} as const;

export type ModelRequestSessionFeature =
  (typeof ModelRequestSessionFeature)[keyof typeof ModelRequestSessionFeature];

const MODEL_REQUEST_SESSION_FEATURE_VALUES: ReadonlySet<string> = new Set(
  Object.values(ModelRequestSessionFeature),
);

export function isModelRequestSessionFeature(value: unknown): value is ModelRequestSessionFeature {
  return typeof value === "string" && MODEL_REQUEST_SESSION_FEATURE_VALUES.has(value);
}

/**
 * Runtime 与 Adapter 之间的调用级执行信息。
 *
 * 它不属于业务 ModelRequest，也不允许普通调用方据此改变 Provider 或模型身份。
 * Runtime 只在统一模型调用边界设置，Adapter 在同一异步调用链内读取。
 */
export interface ModelInvocationContext {
  metadata?: Record<string, unknown>;
  modelCall?: ModelApiCallObservation;
  modelRequestSessionType?: ModelRequestSessionType;
  /**
   * 本会话已用能力标签；runtime 层在每次调用时读取 owner 的当前集合。Adapter 写入受控归因
   * header，不允许 provider 静态 headers 覆盖；缺省或空集合时不发送。
   */
  modelRequestSessionFeatures?: readonly ModelRequestSessionFeature[];
  /** 重试预算档位；runtime 按 taskType 决定，adapter 据此放宽瞬态失败的放弃条件。 */
  modelRetryBudget?: ModelRetryBudget;
  /** 准入端口；runtime 从 deps 带入，adapter 每次尝试先 acquire。 */
  modelRequestAdmission?: ModelRequestAdmission;
  statusSink?: ModelStatusSink;
  traceContext?: TraceContext;
  streamIdleTimeoutRetryNumber?: number;
  streamRecovery?: ModelStreamRecoveryStatus;
  preserveProviderStreamBoundaries?: boolean;
  refreshRuntimeHeadersBeforeAttempt?: (input: {
    accountAccess?: ZCodeProviderAccountAccess;
    expectedAccountScope?: string;
    rejectedProjectTokenFingerprint?: string;
    attempt: number;
    reason?: ProviderRuntimeHeadersRequestReason;
    abortSignal?: AbortSignal;
    providerId: string;
    modelId: string;
    traceContext?: TraceContext;
  }) => Promise<{
    headersApplied: boolean;
    requestAuth?: ModelRequestAuth;
  }>;
}

/**
 * 模型请求 attempt 发送前刷新运行时请求头（provider runtime headers）的原因。
 *
 * - `model-request`：常规模型请求，含 adapter 内部重试的每一次 attempt。
 * - `captcha-retry`：start-plan 渠道收到网关的 3007 验证码挑战后触发的单次重试；
 *   渲染层据此重新求解验证码并回传新 token（对齐官方 `CaptchaRequestRetry.takeReason()`，
 *   见 docs/development/126-start-plan-3007-root-cause.md §2.1）。
 *
 * 抽成具名类型而不是在各处散落字面量联合：该值跨 adapter / core / bootstrap / 协议四处传递，
 * 任一处的字面量漂移都会让 `captcha-retry` 在链路中静默退化成普通请求（渲染层不重新求解）。
 */
export type ProviderRuntimeHeadersRequestReason = "model-request" | "captcha-retry";

/** Adapter 为单个物理请求 attempt 使用的动态鉴权材料。 */
export interface ModelRequestAuth {
  accountScope?: string;
  apiKey?: string;
  apiKeyId?: string;
  headers?: Record<string, string>;
}

export interface ModelRequestAuthSourceInput {
  attempt: number;
  abortSignal?: AbortSignal;
  providerId: string;
  modelId: string;
  traceContext?: TraceContext;
}

/** Model 创建时绑定、在每个物理请求 attempt 前解析的执行作用域鉴权来源。 */
export interface ModelRequestAuthSource {
  resolve(input: ModelRequestAuthSourceInput): Promise<ModelRequestAuth | undefined>;
}

export interface ModelRequestDependencies {
  /** 属性存在表示当前 Model 必须取得请求级鉴权；Source 缺失同样 fail-closed。 */
  requestAuth?: {
    source?: ModelRequestAuthSource;
  };
}

const modelInvocationStorage = new AsyncLocalStorage<ModelInvocationContext>();

export function getCurrentModelInvocationContext(): ModelInvocationContext | undefined {
  return modelInvocationStorage.getStore();
}

export function runWithModelInvocationContext<T>(context: ModelInvocationContext, run: () => T): T {
  const result = modelInvocationStorage.run(context, run);
  if (!isAsyncIterable(result)) return result;

  const source = result;
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      return {
        next: (value?: unknown) =>
          modelInvocationStorage.run(context, () => iterator.next(value as never)),
        return: (value?: unknown) =>
          modelInvocationStorage.run(context, () =>
            iterator.return
              ? iterator.return(value as never)
              : Promise.resolve({ done: true, value }),
          ),
        throw: (error?: unknown) =>
          modelInvocationStorage.run(context, () =>
            iterator.throw ? iterator.throw(error) : Promise.reject(error),
          ),
      };
    },
  } as T;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}
