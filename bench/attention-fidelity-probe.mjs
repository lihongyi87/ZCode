#!/usr/bin/env node
// 注意力保真度探针 v2——细粒度测量：聚合 / 干扰 / 规则演变。
// v1（attention-depth-probe）已证明：显眼单针检索+两事实规则在 900K 全绿。
// 本探针测更接近真实断盘失败模式的三种细粒度能力：
//   C 聚合：10 枚暗码散布在 10%~90% 深度，结尾要求按序全部报出——测持续注意力。
//   D 干扰：真针旁埋 3 枚近似假码（同格式差一字符），只问真码——测精度。
//   E 规则演变：头部规则 v1，中部更新为 v2，尾部按最新规则断——测状态追踪。
//
// 用法：node bench/attention-fidelity-probe.mjs [--depths 100,500,900] [--runs 2] [--model glm-5.2]
// 产物：bench/attention-fidelity-result.json

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const argOf = (n, f) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : f;
};
const DEPTHS = argOf("--depths", "100,500,900").split(",").map(Number);
const RUNS = Number(argOf("--runs", "2"));
const MODEL = argOf("--model", "glm-5.2");

const providers = JSON.parse(
  readFileSync(new URL("../.dev-data/.zcode/v2/model-providers.json", import.meta.url), "utf8"),
);
const bm = providers.find((p) => p.id === "builtin:bigmodel");

const FILLER = readFileSync("F:/智能体/大六壬/知识库/大六壬知识库.md", "utf8").replace(/\s+/g, " ");
function* chunks() {
  let off = 0;
  while (true) {
    const c = FILLER.slice(off, off + 2000);
    if (c.length < 2000) off = 0;
    else off += 2000;
    yield `【课体章 ${off}】${c}\n`;
  }
}

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = () => Array.from({ length: 4 }, () => ALPHA[Math.floor(Math.random() * 32)]).join("");
const mutate = (c) => {
  const i = Math.floor(Math.random() * 4);
  let ch = ALPHA[Math.floor(Math.random() * 32)];
  while (ch === c[i]) ch = ALPHA[Math.floor(Math.random() * 32)];
  return c.slice(0, i) + ch + c.slice(i + 1);
};

async function call(body, retries = 4) {
  for (let a = 1; a <= retries; a++) {
    const res = await fetch(`${bm.endpoints.anthropic}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": bm.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (res.status === 200) return { json: await res.json() };
    const t = await res.text();
    if ((res.status === 529 || res.status === 429) && a < retries) {
      await new Promise((r) => setTimeout(r, 15000 * a));
      continue;
    }
    return { error: t.slice(0, 200), status: res.status };
  }
}
const textOf = (j) =>
  (j?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" / ");

// ── C 聚合：10 针按深度百分比散布 ──
function buildC(targetTokens, cpt, codes) {
  const targetChars = Math.round(targetTokens * cpt);
  const gen = chunks();
  const parts = [];
  let used = 0;
  let nextNeedle = 0;
  while (used < targetChars) {
    const c = gen.next().value;
    parts.push(c);
    used += c.length;
    const pct = used / targetChars;
    if (nextNeedle < 10 && pct >= (nextNeedle + 1) / 11) {
      parts.push(`【巡检标记 ${nextNeedle + 1}】暗码 ${codes[nextNeedle]}。\n`);
      nextNeedle++;
    }
  }
  parts.push(
    `\n以上资料散布着10枚巡检标记。请按编号1~10逐行报出暗码，格式：1=xxxx 2=xxxx … 10=xxxx，不要解释。`,
  );
  return parts.join("");
}

// ── D 干扰：真针 + 每针 3 近似假码紧邻 ──
function buildD(targetTokens, cpt, real, decoys) {
  const targetChars = Math.round(targetTokens * cpt);
  const gen = chunks();
  const parts = [];
  let used = 0;
  const midPoint = targetChars / 2;
  while (used < targetChars) {
    const c = gen.next().value;
    if (used < midPoint && used + c.length >= midPoint) {
      parts.push(`【校验标记 甲】暗码 ${decoys[0]}。\n`);
      parts.push(`【校验标记 乙】暗码 ${decoys[1]}。\n`);
      parts.push(`【正本标记】暗码 ${real}。\n`);
      parts.push(`【校验标记 丙】暗码 ${decoys[2]}。\n`);
      used += 160;
    }
    parts.push(c);
    used += c.length;
  }
  parts.push(
    `\n资料中有一个【正本标记】和三个【校验标记】。请只报出【正本标记】的暗码，格式：正本=xxxx，不要解释。`,
  );
  return parts.join("");
}

// ── E 规则演变：v1 规则在头部，v2 更新在中部 ──
function buildE(targetTokens, cpt) {
  const targetChars = Math.round(targetTokens * cpt);
  const gen = chunks();
  const parts = [];
  parts.push(
    `【命例】乾造丁卯年、甲辰月、辛亥日。\n【断语规则 v1】丁卯年命见辛亥日主，结论为「禄贵交驰」。\n`,
  );
  let used = 200;
  const midPoint = targetChars / 2;
  while (used < targetChars) {
    const c = gen.next().value;
    if (used < midPoint && used + c.length >= midPoint) {
      parts.push(
        `\n【规则勘误 v2】前述 v1 规则作废。修正后：丁卯年命见辛亥日主且月令甲辰者，结论为「杀印相生」；仅丁卯见辛亥而无甲辰者仍为「禄贵交驰」。\n`,
      );
      used += 130;
    }
    parts.push(c);
    used += c.length;
  }
  parts.push(
    `\n请依据资料中【最新有效】的断语规则判断该命例（丁卯年、甲辰月、辛亥日）的结论。只答四个字，不要解释。`,
  );
  return parts.join("");
}

async function main() {
  console.log(`== 注意力保真度探针 v2 ==\n模型:${MODEL} 深度:${DEPTHS.join("/")}K 轮数:${RUNS}`);
  // 复用 v1 标定比率（同语料同模型）：~0.585 字/token（51K→29.8M字符？直接重标定更稳）
  const calReq = await call({
    model: MODEL,
    max_tokens: 16,
    system: "你是测试助手。",
    messages: [
      { role: "user", content: [{ type: "text", text: FILLER.slice(0, 60000) + "\n只回复：OK" }] },
    ],
  });
  const cpt = 60000 / calReq.json.usage.input_tokens;
  console.log(`标定: 1 token ≈ ${cpt.toFixed(3)} 字符\n`);

  const rows = [];
  for (const depth of DEPTHS) {
    for (let run = 1; run <= RUNS; run++) {
      // C 聚合
      const codes = Array.from({ length: 10 }, code);
      const rC = await call({
        model: MODEL,
        max_tokens: 512,
        system: "你是测试助手，严格按要求格式作答。",
        messages: [
          { role: "user", content: [{ type: "text", text: buildC(depth * 1000, cpt, codes) }] },
        ],
      });
      const ansC = textOf(rC.json);
      const found = codes.filter((c) => ansC.toUpperCase().includes(c)).length;
      // D 干扰
      const real = code();
      const decoys = [mutate(real), mutate(real), mutate(real)];
      const rD = await call({
        model: MODEL,
        max_tokens: 512,
        system: "你是测试助手，严格按要求格式作答。",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: buildD(depth * 1000, cpt, real, decoys) }],
          },
        ],
      });
      const ansD = textOf(rD.json).toUpperCase();
      const dCorrect = ansD.includes(real) && !decoys.some((d) => ansD.includes(d));
      // E 演变
      const rE = await call({
        model: MODEL,
        max_tokens: 512,
        system: "你是测试助手，严格按要求格式作答。",
        messages: [{ role: "user", content: [{ type: "text", text: buildE(depth * 1000, cpt) }] }],
      });
      const ansE = textOf(rE.json);
      const eCorrect = ansE.includes("杀印相生");

      rows.push({
        depthK: depth,
        run,
        usage: rC.json?.usage?.input_tokens,
        aggFound: found,
        aggTotal: 10,
        distractorCorrect: dCorrect,
        ruleEvolutionCorrect: eCorrect,
        ansE: ansE.trim().slice(0, 12),
        ...(rC.error ? { errC: rC.error } : {}),
        ...(rD.error ? { errD: rD.error } : {}),
        ...(rE.error ? { errE: rE.error } : {}),
      });
      console.log(
        `[${depth}K #${run}] tokens=${rC.json?.usage?.input_tokens ?? "?"} 聚合=${found}/10 干扰=${dCorrect ? 1 : 0} 演变=${eCorrect ? 1 : 0}${eCorrect ? "" : ` (${rows.at(-1).ansE})`}`,
      );
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  const curve = DEPTHHS_AGG(rows);
  console.log(`\n== 保真度曲线 ==`);
  console.log("深度    tokens   聚合   干扰   规则演变");
  for (const c of curve) {
    console.log(
      `${String(c.depthK).padStart(4)}K ${String(c.tokens).padStart(8)}  ${c.aggPct.padStart(5)}  ${c.dPct.padStart(4)}  ${c.ePct.padStart(4)}`,
    );
  }
  writeFileSync(
    new URL("./attention-fidelity-result.json", import.meta.url),
    JSON.stringify({ model: MODEL, ranAt: new Date().toISOString(), curve, rows }, null, 2),
  );
  console.log("已写 bench/attention-fidelity-result.json");
}
function DEPTHHS_AGG(rows) {
  return [...new Set(rows.map((r) => r.depthK))].map((d) => {
    const rs = rows.filter((r) => r.depthK === d);
    const agg = rs.reduce((s, r) => s + r.aggFound, 0) / rs.reduce((s, r) => s + r.aggTotal, 0);
    return {
      depthK: d,
      tokens: Math.round(rs.reduce((s, r) => s + (r.usage ?? 0), 0) / rs.length),
      aggPct: `${Math.round(agg * 100)}%`,
      dPct: `${Math.round((rs.filter((r) => r.distractorCorrect).length / rs.length) * 100)}%`,
      ePct: `${Math.round((rs.filter((r) => r.ruleEvolutionCorrect).length / rs.length) * 100)}%`,
    };
  });
}
main().catch((e) => {
  console.error("v2 probe 异常:", e.message);
  process.exit(1);
});
