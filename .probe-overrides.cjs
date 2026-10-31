// 探测 override 清单中每个包当前是否可解析(require resolution),输出 stale 列表。
const fs = require("node:fs");
const overrides = JSON.parse(fs.readFileSync("third-party/npm-overrides.json", "utf8"));
const packages = Array.isArray(overrides) ? overrides : (overrides.packages ?? []);
const results = [];
for (const item of packages) {
  const full = item.package ?? "";
  if (!full) continue;
  const at = full.indexOf("@", 1);
  const name = at > 0 ? full.slice(0, at) : full;
  let status = "MISSING";
  try {
    status = require(`${name}/package.json`).version;
  } catch {
    try {
      status = require.resolve(name);
    } catch {
      /* keep MISSING */
    }
  }
  results.push({ full, status });
}
const stale = results.filter((r) => r.status === "MISSING");
console.log("total:", results.length, "missing:", stale.length);
for (const s of stale) console.log(" -", s.full);
fs.writeFileSync(".stale-overrides.txt", stale.map((s) => s.full).join("\n"));
