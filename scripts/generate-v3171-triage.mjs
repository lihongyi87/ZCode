// 生成 v3.17.1 合并的「上游删除文件甄别清单」(spec/upstream-sync.md v3.17.1 节的执行第 1 步)。
// 输出分类:CE 特有(保留候选) / 上游测试面(跟随迁移) / 其他,供逐域裁决。
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const BASE = "3c5b2276";
const UPSTREAM = "official/main";

const deleted = execSync(`git diff --diff-filter=D --name-only ${BASE} ${UPSTREAM}`, {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter(Boolean);

// CE 特征关键词:命中即标记「保留候选」(须人工确认)
const CE_MARKERS = [
  /qimen/i,
  /liuren/i,
  /deepseek/i,
  /proactive/i,
  /session-target/i,
  /skill-manage/i,
  /skillManage/i,
  /goal/i,
  /spec-?1[5-6]\d/i,
  /toolCallProgress/i,
  /codemode/i,
  /nodeRepl/i,
  /memory-?recall/i,
  /adaptive/i,
  /highspeed/i,
  /bcode/i,
  /web-service/i,
  /mailbox/i,
  /off-?peak/i,
  /cacheHitRatio/i,
  /waitVisibility/i,
  /automations?/i,
];

const rows = deleted.map((f) => {
  const isTest = /\.(test|spec)\.[jt]sx?$|\/test\/|\/tests\//.test(f);
  const ceHits = CE_MARKERS.filter((re) => re.test(f));
  const category = ceHits.length > 0 ? "CE-候选保留" : isTest ? "上游测试面" : "其他";
  return { file: f, category, ceHits: ceHits.map((r) => r.source).join(",") };
});

const byCat = {};
for (const row of rows) byCat[row.category] = (byCat[row.category] ?? 0) + 1;

let out = "# v3.17.1 合并甄别清单（自动生成，2026-10-30）\n\n";
out += `上游删除文件总数：${deleted.length}\n分类：${JSON.stringify(byCat)}\n\n`;
out += "## CE 候选保留（命中 CE 特征词，逐个人工确认）\n\n";
for (const row of rows.filter((r) => r.category === "CE-候选保留")) {
  out += `- ${row.file} （命中：${row.ceHits}）\n`;
}
out += "\n## 上游测试面（默认跟随迁移；与 CE 交叠时人工复核）\n\n";
for (const row of rows.filter((r) => r.category === "上游测试面")) {
  out += `- ${row.file}\n`;
}
out += "\n## 其他（逐个快扫）\n\n";
for (const row of rows.filter((r) => r.category === "其他")) {
  out += `- ${row.file}\n`;
}
writeFileSync("docs/development/v3171-deletion-triage.md", out);
console.log("total:", deleted.length, "byCat:", JSON.stringify(byCat));
console.log("written: docs/development/v3171-deletion-triage.md");
