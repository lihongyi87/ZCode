import { describe, expect, it } from "vitest";
import {
  AUTOCOMPACT_PRECOMPUTE_PERCENT,
  shouldAutoCompact,
  shouldPrecomputeCompact,
  type AutoCompactDecision,
} from "../src/compact/policy.js";
import {
  compactEntriesChainHash,
} from "../src/runtime/methods/compact-precompute.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";

/** spec 166:预热判定与快照指纹(纯函数层)。 */

const BASE_CONFIG = {
  contextWindow: 100_000,
  maxOutputTokens: 20_000,
} as const;

function decisionOf(tokenCount: number): AutoCompactDecision {
  const full = shouldAutoCompact({
    messages: [{ content: "x".repeat(tokenCount * 4), role: "user" }],
    config: BASE_CONFIG,
  });
  return full;
}

describe("shouldPrecomputeCompact (spec 166)", () => {
  it("默认预热线 85%;低于不预热,越过而未达压缩面则预热", () => {
    expect(AUTOCOMPACT_PRECOMPUTE_PERCENT).toBe(0.85);
    const low = decisionOf(1_000);
    expect(shouldPrecomputeCompact(low)).toBeUndefined();
  });

  it("precomputePercent=0 关闭预热", () => {
    const high = decisionOf(70_000);
    expect(shouldPrecomputeCompact(high, { ...BASE_CONFIG, precomputePercent: 0 })).toBeUndefined();
  });

  it("已达压缩面(above_threshold)不预热——直接走同步压缩", () => {
    const over = shouldAutoCompact({
      messages: [{ content: "x".repeat(320_000), role: "user" }],
      config: BASE_CONFIG,
    });
    if (over.shouldCompact) {
      expect(shouldPrecomputeCompact(over)).toBeUndefined();
    }
  });
});

describe("compactEntriesChainHash (spec 166 快照校验)", () => {
  const msg = (text: string, role = "user"): RuntimeMessageEntry => ({
    kind: "message",
    message: { content: text, role: role as "user" },
    metadata: { source: "real_user" },
  });

  it("前缀一致 → hash 匹配;前缀变异 → 不匹配", () => {
    const a = [msg("one"), msg("two"), msg("three")];
    const prefixHash = compactEntriesChainHash(a.slice(0, 2));
    const same = [msg("one"), msg("two"), msg("three"), msg("four")];
    // 追加新消息不影响旧前缀指纹
    expect(compactEntriesChainHash(same.slice(0, 2))).toBe(prefixHash);
    // 前缀内容变异 → hash 变化
    const mutated = [msg("one"), msg("TWO-changed"), msg("three")];
    expect(compactEntriesChainHash(mutated.slice(0, 2))).not.toBe(prefixHash);
  });

  it("attachment 条目参与指纹", () => {
    const attachment: RuntimeMessageEntry = {
      kind: "attachment",
      content: "data",
      metadata: { source: "shared_context" },
    };
    const entries = [msg("one"), attachment];
    expect(compactEntriesChainHash(entries)).not.toBe(compactEntriesChainHash([msg("one")]));
  });
});
