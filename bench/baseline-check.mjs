#!/usr/bin/env node
// bench 基线对比——把「改完有没有变差」变成一条命令。
//
// 用法：
//   node bench/baseline-check.mjs <result.json> [<result2.json> ...]
//     把新跑的 bench 结果（attention-depth / attention-fidelity / cua 任一组合）
//     与 baseline.json 对比，任何一项得分下降即报回归（exit 1）。
//   node bench/baseline-check.mjs --update <result.json>
//     用新结果覆盖基线（确认非回归后手动执行）。
//
// 基线内容（bench/baseline.json）：
//   attention-depth   六档深度×三针位+推理命中率（v1 探针）
//   attention-fidelity 三细粒度×三深度（聚合/干扰/规则演变，v2 探针）
//   cua               10 任务校准（passed/total）

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = dirname(fileURLToPath(import.meta.url));
const baselinePath = resolve(benchDir, "baseline.json");
const args = process.argv.slice(2);
const update = args.includes("--update");
const resultFiles = args.filter((a) => !a.startsWith("--"));

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** 各类结果 → 统一得分行：{ kind, key, score (0-100), detail }。分数下降即回归。 */
function scoreResult(file, data) {
  if (data.passed !== undefined && data.total !== undefined && data.results) {
    // CUA bench（packages/zcode-cua/bench/result.json）
    return {
      kind: "cua",
      key: `cua:${data.model ?? "driver"}`,
      score: Math.round((data.passed / data.total) * 100),
      detail: `${data.passed}/${data.total} tasks`,
    };
  }
  if (Array.isArray(data.curve) && data.curve.length > 0) {
    // attention-depth（行含数值命中率）与 attention-fidelity（行含 aggPct 等字符串百分比）。
    const rates = [];
    for (const row of data.curve) {
      for (const key of ["headHit", "midHit", "tailHit", "reasoningHit"]) {
        if (typeof row[key] === "number") rates.push(row[key]);
      }
      for (const key of ["aggPct", "dPct", "ePct"]) {
        if (typeof row[key] === "string") rates.push(Number.parseFloat(row[key]) / 100);
      }
    }
    const kind = data.curve.some((row) => "aggPct" in row)
      ? "attention-fidelity"
      : "attention-depth";
    const avg = rates.length > 0 ? rates.reduce((s, v) => s + v, 0) / rates.length : null;
    return {
      kind,
      key: `${kind}:${data.model ?? "model"}`,
      score: avg === null ? null : Math.round(avg * 100),
      detail: `${data.curve.length} 档深度平均命中`,
    };
  }
  return null;
}

if (resultFiles.length === 0) {
  console.error("用法: node baseline-check.mjs [--update] <result.json> [...]");
  process.exit(2);
}

const baseline = loadJson(baselinePath);
let regressions = 0;
const nextBaseline = { ...baseline };

for (const file of resultFiles) {
  const data = loadJson(file);
  const scored = scoreResult(file, data);
  if (!scored) {
    console.log(`? ${file}: 无法识别的结果格式，跳过`);
    continue;
  }
  const kind = scored.kind;
  const baselineScore = baseline.entries?.[kind]?.score ?? null;
  const verdict =
    baselineScore === null
      ? "新基线"
      : scored.score >= baselineScore
        ? "OK"
        : `回归 (${baselineScore} → ${scored.score})`;
  if (verdict !== "OK" && verdict !== "新基线") regressions += 1;
  console.log(`${kind}: ${scored.score}% (${scored.detail}) — ${verdict}`);
  if (!baseline.entries) baseline.entries = {};
  baseline.entries[kind] = {
    score: scored.score,
    detail: scored.detail,
    updatedAt: new Date().toISOString(),
    source: file,
  };
  nextBaseline.entries = baseline.entries;
}

if (regressions > 0) {
  console.error(`\n检测到 ${regressions} 项回归——先归因再提交。`);
  process.exit(1);
}
if (update) {
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`基线已更新: ${baselinePath}`);
}
console.log("无回归。");
