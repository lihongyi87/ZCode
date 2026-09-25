import assert from "node:assert/strict";
import test from "node:test";
import { resolveBashInlineBudgetBytes } from "../src/tool/handlers/bash.js";

/**
 * 压力感知 Bash 输出预算测试（Plan ②）：
 * 压力未报告 → 全量 30K；>0.6 → 减半；>0.8 → 四分之一；越界值收敛到 0-1。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/bash-pressure-budget.test.ts
 */

test("未报告压力：全量预算", () => {
  assert.equal(resolveBashInlineBudgetBytes(undefined), 30_000);
  assert.equal(resolveBashInlineBudgetBytes(Number.NaN), 30_000);
});

test("低压力（≤0.6）：全量预算", () => {
  assert.equal(resolveBashInlineBudgetBytes(0), 30_000);
  assert.equal(resolveBashInlineBudgetBytes(0.5), 30_000);
  assert.equal(resolveBashInlineBudgetBytes(0.6), 30_000);
});

test("中压力（>0.6 且 ≤0.8）：减半", () => {
  assert.equal(resolveBashInlineBudgetBytes(0.61), 15_000);
  assert.equal(resolveBashInlineBudgetBytes(0.8), 15_000);
});

test("高压力（>0.8）：四分之一", () => {
  assert.equal(resolveBashInlineBudgetBytes(0.81), 7_500);
  assert.equal(resolveBashInlineBudgetBytes(1), 7_500);
});

test("越界压力收敛到 0-1", () => {
  assert.equal(resolveBashInlineBudgetBytes(-5), 30_000);
  assert.equal(resolveBashInlineBudgetBytes(99), 7_500);
});
