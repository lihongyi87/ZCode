import { afterAll, describe, expect, it } from "vitest";
import {
  createDeepSeekSessionLogTransaction,
  isDeepSeekSessionLogEnabled,
  isDeepSeekSessionLogProvider,
  peekDeepSeekSessionLogWatermark,
} from "../src/deepseek/session-log.js";
import type { ModelInputMessage } from "@zcode/contracts";

/** spec 157:运行时装配——开关短路、provider 判定、accept 幂等推进水印。 */

const messages: ModelInputMessage[] = [
  { role: "user", content: "a" },
  { role: "assistant", content: "b" },
];

const ENV_KEYS = ["ZCODE_DEEPSEEK_SESSION_LOG", "ZCODE_DEEPSEEK_SESSION_LOG_MAX_BYTES"] as const;
const savedEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const);

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function enableSessionLog(): void {
  process.env.ZCODE_DEEPSEEK_SESSION_LOG = "1";
}

describe("createDeepSeekSessionLogTransaction", () => {
  it("开关默认关:不构造 transaction(零开销短路)", () => {
    delete process.env.ZCODE_DEEPSEEK_SESSION_LOG;
    expect(isDeepSeekSessionLogEnabled()).toBe(false);
    expect(
      createDeepSeekSessionLogTransaction({ sessionId: "s1", providerId: "deepseek", messages }),
    ).toBeUndefined();
  });

  it("非 DeepSeek provider:不构造(其他 provider 不受影响)", () => {
    enableSessionLog();
    expect(
      createDeepSeekSessionLogTransaction({ sessionId: "s1", providerId: "zhipu-coding-plan", messages }),
    ).toBeUndefined();
    expect(isDeepSeekSessionLogProvider("DeepSeek")).toBe(true);
    expect(isDeepSeekSessionLogProvider("openrouter")).toBe(false);
  });

  it("构造后 accept 幂等推进水印;水印支撑下轮增量", () => {
    enableSessionLog();
    const tx = createDeepSeekSessionLogTransaction({
      sessionId: "s2",
      providerId: "deepseek",
      messages,
    });
    expect(tx).toBeDefined();
    expect(tx?.value.events.length).toBe(2);
    tx?.accept();
    tx?.accept();
    const watermark = peekDeepSeekSessionLogWatermark("s2");
    expect(watermark?.throughSeq).toBe(tx?.throughSeq);

    const next = createDeepSeekSessionLogTransaction({
      sessionId: "s2",
      providerId: "deepseek",
      messages: [...messages, { role: "user", content: "c" }],
    });
    expect(next).toBeDefined();
    expect(next?.value.afterSeq).toBe(tx?.throughSeq);
    expect(next?.value.events.length).toBe(1);
  });

  it("无新增事件:undefined(请求不携带字段)", () => {
    enableSessionLog();
    expect(
      createDeepSeekSessionLogTransaction({ sessionId: "s3", providerId: "deepseek", messages: [] }),
    ).toBeUndefined();
  });
});
