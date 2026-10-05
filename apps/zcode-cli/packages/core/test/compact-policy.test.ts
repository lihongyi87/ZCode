import assert from "node:assert/strict";
import test from "node:test";

import { mergeCompactInstructions } from "../src/compact/policy.js";

/**
 * P4 压缩域包合并语义：项目级 compact.domainInstructions 与运行时 /compact
 * 参数叠加（域包在前、空行分隔、空值不产生空段）。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/compact-policy.test.ts
 */

test("P4 压缩域包合并：域包在前、运行时参数在后、空值不产生空段", () => {
  // 两者都有 → 域包在前以空行分隔
  assert.equal(
    mergeCompactInstructions("域包：保留知识锚点与口径", "重点看测试输出"),
    "域包：保留知识锚点与口径\n\n重点看测试输出",
  );
  // 只有域包（自动压缩的常态——无 /compact 参数）
  assert.equal(mergeCompactInstructions("域包", undefined), "域包");
  // 只有运行时参数（未配置域包的仓库行为不变）
  assert.equal(mergeCompactInstructions(undefined, "参数"), "参数");
  // 都空 / 纯空白 → undefined（不注入 Additional Instructions 段）
  assert.equal(mergeCompactInstructions(undefined, undefined), undefined);
  assert.equal(mergeCompactInstructions("  ", " \n "), undefined);
});

// ── ⑤ BodyAfterPrefix 触发口径（吸收 codex AutoCompactTokenLimitScope） ──

test("⑤ 大前缀不占压缩预算：body 不足阈值不压缩（旧行为会压）", async () => {
  const { shouldAutoCompact } = await import("../src/compact/policy.js");
  // 20K 前缀（system）+ 30K body；窗口 200K，阈值≈window-buffer。
  const messages = [
    { role: "system", content: "S".repeat(80_000) }, // ~20K tokens (4B/token)
    ...Array.from({ length: 30 }, (_, i) => [
        { role: "user", content: `B${i} ` + "x".repeat(3_900) },
        { role: "assistant", content: "ok" },
      ]).flat(),
  ];
  const decision = shouldAutoCompact({ messages, config: { contextWindow: 200_000 } });
  assert.equal(decision.scope, "body-after-prefix");
  assert.equal(decision.shouldCompact, false, "body(~30K) < 阈值(~178K) → 不压缩");
  assert.ok(decision.prefixTokens > 15_000, `前缀 token 应被识别，实际 ${decision.prefixTokens}`);
});

test("⑤ body 达阈值即压缩；全量 95% 硬顶与口径无关", async () => {
  const { shouldAutoCompact } = await import("../src/compact/policy.js");
  const big = [
    { role: "system", content: "S".repeat(80_000) },
    ...Array.from({ length: 160 }, (_, i) => [
        { role: "user", content: `B${i} ` + "x".repeat(3_900) },
        { role: "assistant", content: "ok" },
      ]).flat(),
  ];
  const byBody = shouldAutoCompact({ messages: big, config: { contextWindow: 200_000 } });
  assert.equal(byBody.shouldCompact, true, "body(~160K) 越阈值 → 压缩");
  assert.ok(
    byBody.reason === "above_threshold" || byBody.reason === "hard_cap",
    `reason 应为触发类，实际 ${byBody.reason}`,
  );
  // 全量逼近窗口：即使 body 口径未到（前缀巨大），硬顶兜底触发
  const nearFull = [
    { role: "system", content: "S".repeat(300_000) }, // ~75K tokens 前缀
    ...Array.from({ length: 100 }, (_, i) => [
        { role: "user", content: `B${i} ` + "x".repeat(3_900) },
        { role: "assistant", content: "ok" },
      ]).flat(),
  ];
  const hardCap = shouldAutoCompact({ messages: nearFull, config: { contextWindow: 200_000 } });
  assert.equal(hardCap.shouldCompact, true, "全量 ≥95% 硬顶必须触发");
  assert.equal(hardCap.reason, "hard_cap");
});

test("⑤ scope=total 保旧口径：前缀计入触发", async () => {
  const { shouldAutoCompact } = await import("../src/compact/policy.js");
  const messages = [
    { role: "system", content: "S".repeat(600_000) }, // ~150K tokens 前缀
    { role: "user", content: "x".repeat(200) },
    { role: "assistant", content: "ok" },
    { role: "user", content: "y".repeat(200) },
    { role: "assistant", content: "ok" },
  ];
  const decision = shouldAutoCompact({
    messages,
    config: { contextWindow: 200_000, autoCompactScope: "total" },
  });
  assert.equal(decision.scope, "total");
  assert.equal(decision.shouldCompact, true, "total 口径：150K 前缀即已越阈值");
});

test("⑧ 多次压缩降准警告：首次无警告，第二次起附警告", async () => {
  const { buildCompactSummaryMessage } = await import("../src/compact/prompt.js");
  const first = buildCompactSummaryMessage("summary body", { suppressFollowup: true, compactionCount: 1 });
  assert.ok(!first.includes("Heads-up"), "首次压缩不打扰");
  const second = buildCompactSummaryMessage("summary body", { suppressFollowup: true, compactionCount: 2 });
  assert.ok(second.includes("compacted 2 times"), "第二次起附警告");
  assert.ok(second.includes("start a new session"), "建议开新会话");
});
