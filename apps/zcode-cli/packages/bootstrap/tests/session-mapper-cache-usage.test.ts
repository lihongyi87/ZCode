import { describe, expect, it } from "vitest";
import type { MessageWithParts } from "@zcode/core";
import {
  contextCacheUsageFromMessages,
  lastCompactionBoundaryIndex,
} from "../src/zcode-protocol/session-mapper.js";

function assistantMessage(id: string, tokens: { input: number; read: number; write: number }) {
  return {
    info: {
      id,
      role: "assistant" as const,
      summary: false,
      tokens: {
        total: tokens.input + tokens.read,
        input: tokens.input,
        output: 10,
        reasoning: 0,
        cache: { read: tokens.read, write: tokens.write },
      },
    },
    parts: [],
  } as unknown as MessageWithParts;
}

function compactionSummaryMessage(id: string) {
  return {
    info: {
      id,
      role: "user" as const,
      summary: true,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ type: "compaction" as const, compactBoundary: { postCompactTokenCount: 1000 } }],
  } as unknown as MessageWithParts;
}

describe("contextCacheUsageFromMessages（缓存命中率口径）", () => {
  it("无 compact 边界：全部 assistant 轮次入册", () => {
    const messages = [
      assistantMessage("a1", { input: 1000, read: 900, write: 0 }),
      assistantMessage("a2", { input: 2000, read: 1600, write: 0 }),
    ];
    expect(lastCompactionBoundaryIndex(messages)).toBe(-1);
    const usage = contextCacheUsageFromMessages(messages);
    expect(usage?.hitRateRequestCount).toBe(2);
    expect(usage?.totalInputTokens).toBe(3000);
    expect(usage?.totalCacheReadTokens).toBe(2500);
    expect(usage?.hitRate).toBeCloseTo(2500 / 3000, 12);
  });

  it("有 compact 边界：只统计边界之后的轮次（与 core 活跃上下文过滤同口径）", () => {
    const messages = [
      assistantMessage("pre-1", { input: 8000, read: 2000, write: 0 }),
      compactionSummaryMessage("boundary"),
      assistantMessage("post-1", { input: 1000, read: 900, write: 0 }),
    ];
    expect(lastCompactionBoundaryIndex(messages)).toBe(1);
    const usage = contextCacheUsageFromMessages(messages);
    expect(usage?.hitRateRequestCount).toBe(1);
    expect(usage?.hitRate).toBeCloseTo(0.9, 12);
  });

  it("只有边界前的轮次时返回 undefined（不把压缩前缓存挂到压缩后水位）", () => {
    const messages = [
      assistantMessage("pre-1", { input: 8000, read: 2000, write: 0 }),
      compactionSummaryMessage("boundary"),
    ];
    expect(contextCacheUsageFromMessages(messages)).toBeUndefined();
  });

  it("多次 compact 取最后一次边界", () => {
    const messages = [
      assistantMessage("old", { input: 5000, read: 1000, write: 0 }),
      compactionSummaryMessage("boundary-1"),
      assistantMessage("mid", { input: 3000, read: 600, write: 0 }),
      compactionSummaryMessage("boundary-2"),
      assistantMessage("new", { input: 1000, read: 950, write: 0 }),
    ];
    const usage = contextCacheUsageFromMessages(messages);
    expect(usage?.hitRateRequestCount).toBe(1);
    expect(usage?.hitRate).toBeCloseTo(0.95, 12);
  });
});
