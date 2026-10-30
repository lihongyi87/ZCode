// v3.17.1 UD 冲突最终裁决清单 v3:用「CE 提交触碰集合」判据——base 之后「非 merge
// 提交」触碰的文件(--no-merges 排除上游整版合并提交带入的上游文件,否则 3.16.2
// 合并的 first-parent diff 会把全部上游文件误判为 CE 触碰;也不含 3.16.1 时代全仓
// oxfmt 重排噪音——该提交在 base 之前)。
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const BASE = "3c5b2276";

// 排除纯格式化提交(oxfmt 全仓重排不是 CE 语义改动):按提交信息含 fmt/oxfmt/格式 判定。
const rawLog = execSync(`git log --no-merges --format="--%h--%s" --name-only ${BASE}..HEAD`, {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const ceTouched = new Set();
let skipping = false;
for (const line of rawLog.split("\n")) {
  if (line.startsWith("--")) {
    skipping = /fmt|oxfmt|格式/i.test(line);
    continue;
  }
  if (line && !skipping) ceTouched.add(line);
}

const udFiles = execSync("git status --porcelain", { encoding: "utf8" })
  .split("\n")
  .filter((l) => l.startsWith("UD "))
  .map((l) => l.slice(3).trim());

const keep = [];
const follow = [];
for (const file of udFiles) {
  if (ceTouched.has(file)) {
    keep.push(file);
  } else {
    follow.push(file);
  }
}

let out = "# v3.17.1 UD 冲突最终裁决清单 v2（自动生成，2026-10-30）\n\n";
out += `判据：CE 提交触碰集合（first-parent diff ${BASE}..HEAD）——不含 3.16.1 时代全仓 oxfmt 重排噪音。\n`;
out += `UD 总数：${udFiles.length}｜保留（CE 触碰过）：${keep.length}｜跟随删除（纯上游面）：${follow.length}\n\n`;
out += "## 保留（merge 时取我们版：git checkout --ours <file> && git add）\n\n";
for (const f of keep) out += `- ${f}\n`;
out += "\n## 跟随删除（git rm <file>）\n\n";
for (const f of follow) out += `- ${f}\n`;
writeFileSync("docs/development/v3171-ud-resolution.md", out);
console.log("UD:", udFiles.length, "keep:", keep.length, "follow-delete:", follow.length);
