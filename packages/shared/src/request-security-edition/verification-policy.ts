export type RequestVerificationConfig = Readonly<Record<string, unknown>>;
export type RequestVerificationProof = Record<never, never>;
export type RequestVerificationClientConfig = Record<never, never>;
// 重植（3.15.1 升级冲掉）：`captcha-retry` 是 start-plan 的 3007 验证码挑战触发单次
// 重试时 agent 重新请求运行时鉴权材料的 reason（adapters captcha-retry.ts takeReason），
// 渲染层据此重新求解验证码并回传新 token。官方版枚举只留 model-request 会让 CLI 侧
// captcha 重试在 wire 校验（zcodeProviderRuntimeHeadersRequestReasonSchema = z.enum(本表)）
// 被拒——main 版 zcode-protocol/index.ts 该枚举本就含两个值。
export const requestVerificationReasons = ["model-request", "captcha-retry"] as const;
export type RequestVerificationReason = (typeof requestVerificationReasons)[number];
export const requestVerificationTimeoutMessage =
  "Provider runtime headers request timed out. Please send your message again.";
export const REQUEST_VERIFICATION_REQUIRED = "request_verification_unavailable";
export function readRequestVerificationConfig(
  _configs: RequestVerificationClientConfig | null | undefined,
): RequestVerificationConfig | null {
  return null;
}
export function readValidatedRequestVerificationConfig(
  _configs: RequestVerificationClientConfig | null | undefined,
): RequestVerificationConfig | null {
  return null;
}
export function requestVerificationClaimHeaders(
  _proof: RequestVerificationProof,
): Record<string, string> {
  return {};
}
export function withoutRequestVerificationHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return { ...headers };
}
export function allowRequestVerificationHeaders(
  _headers: Record<string, string>,
): Record<string, string> {
  return {};
}

/**
 * CE 版（spec 130，docs/development/130-start-plan-captcha-spec.md）：start-plan 的
 * 验证码挑战需要渲染层交互（host 不得短路自答），其余账号形态零交互。
 * 官方开源版为恒 false（不启用该链路）；两版测试按此判据分支。
 * 上游 v3.17.1 为该函数加了 config 第二参数（当前恒 false 版未消费），此处按
 * 兼容签名保留，语义不变。
 */
export function requiresRequestVerification(
  access: { mode: string } | undefined,
  _config?: RequestVerificationConfig | null,
): boolean {
  return access?.mode === "start-plan";
}
export function isRequestVerificationMessage(_message: string): boolean {
  return false;
}
export function summarizeRequestVerificationHeaders(
  _headers: Record<string, string>,
): Record<string, unknown> {
  return {};
}
export function requestVerificationDiagnostics(
  _input: Record<string, unknown>,
): Record<string, unknown> {
  return {};
}

export const requestVerificationInteractionAvailable = false;
