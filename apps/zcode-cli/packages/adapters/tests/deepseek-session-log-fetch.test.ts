import { describe, expect, it } from "vitest";
import { createDeepSeekSessionLogFetch } from "../src/model/deepseek-session-log-fetch.js";
import type { DeepSeekSessionLogRequestTransaction } from "@zcode/contracts";

/** spec 157:fetch 注入——顶层字段、2xx accept、非 2xx 不 accept、fail-closed body。 */

const transaction = (acceptCalls: string[] = []): DeepSeekSessionLogRequestTransaction => ({
  value: {
    version: 1,
    sessionFormatVersion: 1,
    session: { version: 1, id: "sess-1", createdAt: 1 },
    afterSeq: 0,
    throughSeq: 1,
    events: [{ type: "user/message", seq: 0, time: 1, data: { text: "hi" }, surfaceOp: "append" }],
  },
  throughSeq: 1,
  accept: () => {
    acceptCalls.push("accept");
  },
});

const jsonResponse = (status: number): Response =>
  new Response("{}", { status, headers: { "content-type": "application/json" } });

describe("createDeepSeekSessionLogFetch", () => {
  it("init.body 字符串路径:顶层注入字段并 2xx accept 一次", async () => {
    const calls: string[] = [];
    const tx = transaction(calls);
    const seen: Array<Record<string, unknown>> = [];
    const fetchImpl = createDeepSeekSessionLogFetch({
      fetch: async (_input, init) => {
        seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse(200);
      },
      transaction: tx,
    });
    await fetchImpl("https://api.deepseek.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-chat", messages: [] }),
    });
    expect(seen[0].dsh_session_log).toEqual(tx.value);
    expect(seen[0].model).toBe("deepseek-chat");
    expect(calls).toEqual(["accept"]);
  });

  it("非 2xx:不 accept(水印不推进,下次重发)", async () => {
    const calls: string[] = [];
    const fetchImpl = createDeepSeekSessionLogFetch({
      fetch: async () => jsonResponse(500),
      transaction: transaction(calls),
    });
    const response = await fetchImpl("https://api.deepseek.com/chat/completions", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(500);
    expect(calls).toEqual([]);
  });

  it("同一 transaction 的多次 2xx:accept 幂等(只一次)", async () => {
    const calls: string[] = [];
    const fetchImpl = createDeepSeekSessionLogFetch({
      fetch: async () => jsonResponse(200),
      transaction: transaction(calls),
    });
    for (let index = 0; index < 3; index += 1) {
      await fetchImpl("https://api.deepseek.com/chat/completions", {
        method: "POST",
        body: "{}",
      });
    }
    expect(calls).toEqual(["accept"]);
  });

  it("Request 对象路径:clone 读 body 注入后原状态码返回", async () => {
    const calls: string[] = [];
    const seen: Array<Record<string, unknown>> = [];
    const fetchImpl = createDeepSeekSessionLogFetch({
      fetch: async (input) => {
        const request = input as Request;
        seen.push(JSON.parse(await request.text()) as Record<string, unknown>);
        return jsonResponse(200);
      },
      transaction: transaction(calls),
    });
    await fetchImpl(
      new Request("https://api.deepseek.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "deepseek-chat" }),
      }),
    );
    expect(seen[0].dsh_session_log).toBeDefined();
    expect(calls).toEqual(["accept"]);
  });

  it("非 JSON body:透传主请求不阻断", async () => {
    const calls: string[] = [];
    const fetchImpl = createDeepSeekSessionLogFetch({
      fetch: async () => jsonResponse(200),
      transaction: transaction(calls),
    });
    const response = await fetchImpl("https://api.deepseek.com/chat/completions", {
      method: "POST",
      body: "not-json{",
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([]);
  });
});
