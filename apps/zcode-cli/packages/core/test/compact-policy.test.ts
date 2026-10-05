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
