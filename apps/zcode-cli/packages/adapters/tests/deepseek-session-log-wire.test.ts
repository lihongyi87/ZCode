import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeepSeekSessionLogRequestTransaction } from "@zcode/contracts";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parseModelConfig,
  parseProviderConfig,
} from "@zcode/provider";
import { AiSdkModelAdapter } from "../src/model/runner.js";
import { createTestModelProperties } from "./test-model-format.js";

/**
 * spec 157 全链 wire:core 装配的 deepSeekSessionLog transaction 经
 * runner → resolveForRequest → createFactory → kindFetch,最终出现在
 * DeepSeek provider 的 HTTP body 顶层;非 DeepSeek provider 不注入。
 */

const MAX_OUTPUT_TOKENS = 4096;

function chatCompletion(modelId: string): Response {
  return Response.json({
    id: "fixture",
    object: "chat.completion",
    created: 1,
    model: modelId,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

async function captureWire(input: {
  providerId: string;
  transaction: DeepSeekSessionLogRequestTransaction | undefined;
}): Promise<{ body: Record<string, unknown>; acceptCalls: number }> {
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "fixture-key" },
      api: { type: "openai-chat-completions", baseUrl: "https://api.deepseek.com" },
    }),
  );
  const config = createRegistryModelConfig(
    parseModelConfig({
      enabled: true,
      properties: createTestModelProperties(),
      optionSpecs: {
        reasoningLevel: { values: ["disabled"], map: "{}" },
        maxOutputTokens: { max: MAX_OUTPUT_TOKENS, map: '{"max_tokens": maxOutputTokens}' },
      },
    }),
  );
  if (!provider.ok || !config.ok) throw new Error("Invalid model fixture config");

  let body: Record<string, unknown> | undefined;
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return chatCompletion("deepseek-chat");
  });
  try {
    const adapter = new AiSdkModelAdapter({ env: { ZCODE_RUNTIME_ENV: "test" }, retry: { maxAttempts: 1 } });
    const model = adapter.createModel({
      providerId: input.providerId,
      modelId: "deepseek-chat",
      providerConfig: provider.config,
      modelConfig: config.config,
      options: { maxOutputTokens: MAX_OUTPUT_TOKENS, reasoningLevel: "disabled" },
    });
    await model.generateText({
      messages: [{ role: "user", content: "hi" }],
      deepSeekSessionLog: input.transaction,
    });
    if (!body) throw new Error("request body was not captured");
    return { body, acceptCalls: 0 };
  } finally {
    vi.unstubAllGlobals();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeek session log wire (spec 157)", () => {
  it("DeepSeek provider:transaction.value 注入 body 顶层 dsh_session_log,2xx 后 accept", async () => {
    const accepts: number[] = [];
    const transaction: DeepSeekSessionLogRequestTransaction = {
      value: {
        version: 1,
        sessionFormatVersion: 1,
        session: { version: 1, id: "sess-wire", createdAt: 1 },
        afterSeq: 0,
        throughSeq: 1,
        events: [
          { type: "user/message", seq: 0, time: 1, data: { text: "hi" }, surfaceOp: "append" },
        ],
      },
      throughSeq: 1,
      accept: () => {
        accepts.push(1);
      },
    };
    const { body } = await captureWire({ providerId: "deepseek-fixture", transaction });
    expect(body.dsh_session_log).toEqual(transaction.value);
    expect(body.model).toBe("deepseek-chat");
    expect(accepts).toEqual([1]);
  });

  it("非 DeepSeek provider:同请求不注入也不 accept", async () => {
    const accepts: number[] = [];
    const transaction: DeepSeekSessionLogRequestTransaction = {
      value: {
        version: 1,
        sessionFormatVersion: 1,
        session: { version: 1, id: "sess-wire", createdAt: 1 },
        afterSeq: 0,
        throughSeq: 0,
        events: [],
      },
      throughSeq: 0,
      accept: () => {
        accepts.push(1);
      },
    };
    const { body } = await captureWire({ providerId: "plain-fixture", transaction });
    expect(body.dsh_session_log).toBeUndefined();
    expect(accepts).toEqual([]);
  });
});
