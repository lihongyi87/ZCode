import type {
  JsonSchema,
  ModelInputMessage,
  ModelId,
  ModelProviderId,
  ModelStreamEvent,
  ModelTextResult,
  ModelToolContract,
} from "./index.js";
import { modelSelectionSchema, type ModelSelection } from "@zcode/shared/model-selection";
import type { ModelPropertiesData, ModelOptionSpecsData } from "@zcode/shared/model-config";
import type { ToolSearchCapability } from "../tools/tool-search.js";

export type { ModelSelection } from "@zcode/shared/model-selection";

// 仅保留 CLI 公共类型名，字段来自同一数据 Schema，不复制 Provider 配置定义。
export type {
  ModelInputFormatData as ModelInputFormat,
  ModelOutputFormatData as ModelOutputFormat,
  EnumOptionSpecData as EnumOptionSpec,
  LimitOptionSpecData as LimitOptionSpec,
} from "@zcode/shared/model-config";
import type { DeepSeekSessionLogRequestTransaction } from "../deepseek/session-log-fold.js";

export type ModelOptionSpecs = ModelOptionSpecsData;
export type ModelProperties = ModelPropertiesData;
export type ModelPropertiesInput = ModelProperties;

export interface ModelOptions {
  reasoningLevel?: string;
  maxOutputTokens?: number;
}

export interface ModelRequest {
  toolSearchEnabled?: boolean;
  messages: ModelInputMessage[];
  tools?: ModelToolContract[];
  responseJsonSchema?: JsonSchema;
  options?: ModelOptions;
  abortSignal?: AbortSignal;
  /**
   * Runtime-only 的 DeepSeek `dsh_session_log` 传递对象(spec 157)。runner 仅对
   * DeepSeek provider 把 value 注入 HTTP body 顶层字段,2xx 后调用 accept() 推进水印;
   * 非 DeepSeek provider 忽略。不可序列化,不进 JSON schema。
   */
  deepSeekSessionLog?: DeepSeekSessionLogRequestTransaction;
}

// 第一阶段沿用已经完成 Provider SDK 归一化的结果和流事件字段；
// 旧名字只保留在 Adapter 兼容边界，业务调用统一使用下面两个名字。
export type ModelResult = ModelTextResult;
export type ModelEvent = ModelStreamEvent;

export interface Model {
  readonly requestCapabilities?: { readonly toolSearch?: ToolSearchCapability };
  readonly providerId: ModelProviderId;
  readonly modelId: ModelId;
  readonly displayName?: string;
  readonly properties: ModelProperties;
  readonly optionSpecs: ModelOptionSpecs;
  readonly options: ModelOptions;

  bind(options?: ModelOptions): Model;
  generateText(request: ModelRequest): Promise<ModelResult>;
  streamText(request: ModelRequest): AsyncIterable<ModelEvent>;
}

/** 校验当前 ModelSelection 值；旧数据库格式只在版本化 migration 转换，不在普通读取时兜底。 */
export function parseModelSelectionValue(value: unknown): ModelSelection | undefined {
  const parsed = modelSelectionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
