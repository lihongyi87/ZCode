/**
 * DeepSeek `dsh_session_log` 顶层字段注入(spec 157)。
 *
 * 放在 provider fetch 链最外层:读 SDK 序列化后的最终 JSON body,把 value 挂到
 * `dsh_session_log` 顶层(与 model-input 字段平级,不进 messages),HTTP 2xx 即视为
 * 投递成功并调用 accept() 推进水印(语义移植 @deepseek-ai/dsh-session-log-deepseek,
 * Apache-2.0;at-least-once,幂等由 transaction 侧保证)。
 *
 * body 读取与 option-map 同款 fail-closed:SDK 若改成非文本 body,必须显式报错而不是
 * 静默丢字段——静默丢字段会让增量会话日志悄悄断流且无任何信号。
 */

import type { DeepSeekSessionLogRequestTransaction } from "@zcode/contracts";

type ProviderFetch = typeof globalThis.fetch;

export const DSH_SESSION_LOG_FIELD_NAME = "dsh_session_log";

export function createDeepSeekSessionLogFetch(input: {
  readonly fetch: ProviderFetch;
  readonly transaction: DeepSeekSessionLogRequestTransaction;
}): ProviderFetch {
  let accepted = false;
  return async (request, init) => {
    const bodyText = await readRequestBody(request, init);
    if (bodyText === undefined) return input.fetch(request, init);
    let patchedBody: string;
    try {
      const body = JSON.parse(bodyText) as Record<string, unknown>;
      body[DSH_SESSION_LOG_FIELD_NAME] = input.transaction.value;
      patchedBody = JSON.stringify(body);
    } catch {
      // body 非 JSON(异常路径)时原样透传,不因附加字段失败而阻断主请求。
      return input.fetch(request, init);
    }
    const response =
      request instanceof Request
        ? await input.fetch(new Request(request, { ...init, body: patchedBody }))
        : await input.fetch(request, { ...init, body: patchedBody });
    if (response.ok && !accepted) {
      accepted = true;
      input.transaction.accept();
    }
    return response;
  };
}

async function readRequestBody(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | undefined> {
  if (typeof init?.body === "string") return init.body;
  if (init?.body !== undefined && init.body !== null) {
    throw new Error("DeepSeek session log requires a JSON text request body.");
  }
  if (request instanceof Request) return request.clone().text();
  return undefined;
}
