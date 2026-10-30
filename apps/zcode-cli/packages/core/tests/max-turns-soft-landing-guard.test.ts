import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * spec 165:maxTurns 生效点护栏。
 *
 * 历史事故：`AgentRuntimeConfig.maxTurns` 曾是死字段——子代理装配写入 `?? 4` 默认、
 * 全仓无读者，「4 轮上限」从未生效。本批补生效点（turn-loop 软着陆）并移除默认值。
 * 两道护栏防止回归：①子代理默认不得再写死 4；②turn-loop 必须消费 config.maxTurns
 * 且软着陆轮关闭工具面。
 */

const SUBAGENT_SRC = new URL(
  "../src/runtime/methods/subagent.ts",
  import.meta.url,
);
const TURN_LOOP_SRC = new URL("../src/runtime/methods/turn-loop.ts", import.meta.url);

describe("maxTurns 生效点护栏（spec 165）", () => {
  it("子代理装配不得写死 4 轮默认（undefined = 不限制）", async () => {
    const source = await readFile(SUBAGENT_SRC, "utf8");
    expect(source).not.toMatch(/maxTurns:\s*request\.maxTurns\s*\?\?\s*[^;\n]*\?\?\s*4/);
  });

  it("turn-loop 消费 config.maxTurns 并在软着陆轮关闭工具面", async () => {
    const source = await readFile(TURN_LOOP_SRC, "utf8");
    expect(source).toContain("this.config.maxTurns");
    expect(source).toContain("stepLimitReached");
    expect(source).toContain("tools: stepLimitReached ? [] : tools");
    expect(source).toContain("max_turns_reached");
  });

  it("reminder 源注册表包含 max_turns_reached（per-request 语义）", async () => {
    const source = await readFile(
      new URL("../src/system-reminder/source.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('"max_turns_reached"');
  });
});
