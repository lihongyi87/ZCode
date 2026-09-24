#!/usr/bin/env node
// 注意力深度探针（attention depth probe）——测量 GLM 长上下文的注意力衰减曲线。
//
// 动机：用户体感「超过 ~500K 注意力下降」，但无测量。本探针把体感变成数据：
// 六档深度 × 三处针位（检索任务）+ 跨距离推理任务，填充物用真实命理知识库
// 语料（衰减对内容类型敏感，不用合成文本）。走 ZCode 同款 anthropic 端点，
// 结论直接适用于 ZCode 会话。
//
// 任务设计：
//  A 检索（lost-in-the-middle）：三枚暗码标记分别埋在头/中/尾，结尾只问暗码。
//  B 推理（跨距离多跳）：头部两条排盘风格事实+一条规则，尾部问结论。
//
// 用法：node bench/attention-depth-probe.mjs [--depths 50,100,300,500,700,900] [--runs 2]
// 产物：bench/attention-depth-result.json + 控制台曲线
//
// 成本提示：默认配置总输入约 6-10M token，GLM 输入价按量计费，量级在个位数元。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const DEPTHS = argOf("--depths", "50,100,300,500,700,900").split(",").map(Number);
const RUNS = Number(argOf("--runs", "2"));
const MODEL = argOf("--model", "glm-5.2[1m]");

// ── 端点与密钥（复用 dev-data 的 bigmodel 直连配置）──
const providers = JSON.parse(
  readFileSync(new URL("../.dev-data/.zcode/v2/model-providers.json", import.meta.url), "utf8"),
);
const bigmodel = providers.find((p) => p.id === "builtin:bigmodel");
const BASE = bigmodel.endpoints.anthropic;
const KEY = bigmodel.apiKey;

// ── 填充语料：真实命理知识库 ──
const FILLER_SOURCE = readFileSync("F:/智能体/大六壬/知识库/大六壬知识库.md", "utf8").replace(
  /\s+/g,
  " ",
);
const CHUNK = 2000; // 字符/段，段间换行保留一点结构感

function* fillerChunks() {
  let offset = 0;
  while (true) {
    const chunk = FILLER_SOURCE.slice(offset, offset + CHUNK);
    if (chunk.length < CHUNK) offset = 0;
    else offset += CHUNK;
    yield `【课体章 ${offset}】${chunk}\n`;
  }
}

// ── 针（每档每轮随机生成，防记忆）──
const code = () =>
  Array.from(
    { length: 4 },
    () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)],
  ).join("");

async function callAnthropic(body, retries = 4) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (res.status === 200) return { json: await res.json(), status: 200 };
    const text = await res.text();
    if ((res.status === 529 || res.status === 429) && attempt < retries) {
      await new Promise((r) => setTimeout(r, 15000 * attempt));
      continue;
    }
    return { error: text.slice(0, 300), status: res.status };
  }
}

// token 估算：先用一次小请求标定 chars/token 比率
async function calibrate() {
  const probeChars = 60000;
  const filler = [];
  const gen = fillerChunks();
  let n = 0;
  while (n < probeChars) {
    const c = gen.next().value;
    filler.push(c);
    n += c.length;
  }
  const r = await callAnthropic({
    model: MODEL,
    max_tokens: 16,
    system: "你是测试助手。",
    messages: [
      { role: "user", content: [{ type: "text", text: filler.join("") + "\n只回复：OK" }] },
    ],
  });
  if (!r.json) throw new Error(`标定失败: ${r.error}`);
  const inputTokens = r.json.usage.input_tokens;
  return { charsPerToken: probeChars / inputTokens, inputTokens };
}

function buildTaskA(targetTokens, charsPerToken, needles) {
  const targetChars = Math.round(targetTokens * charsPerToken);
  const gen = fillerChunks();
  const parts = [];
  let used = 0;
  parts.push(`【探针标记 HEAD】此标记的暗码是 ${needles.head}。\n`);
  const midPoint = targetChars / 2;
  while (used < targetChars) {
    const c = gen.next().value;
    if (used < midPoint && used + c.length >= midPoint) {
      parts.push(`【探针标记 MID】此标记的暗码是 ${needles.mid}。\n`);
      used += 40;
    }
    parts.push(c);
    used += c.length;
  }
  parts.push(`\n【探针标记 TAIL】此标记的暗码是 ${needles.tail}。\n`);
  parts.push(
    `\n以上资料包含三枚探针标记。请只按格式回答三处暗码，不要解释：HEAD=xxxx MID=xxxx TAIL=xxxx`,
  );
  return parts.join("");
}

function buildTaskB(targetTokens, charsPerToken) {
  const targetChars = Math.round(targetTokens * charsPerToken);
  const gen = fillerChunks();
  const head = [
    `【命例事实】乾造：丁卯年、甲辰月、辛亥日、癸巳时。`,
    `【断语规则】凡丁卯年命见辛亥日主，且月令甲辰者，结论为「禄贵交驰」；其余一律为「寻常格局」。`,
    `【补充事实】该命例实际生于公历1987年5月2日巳时。\n`,
  ].join("\n");
  const parts = [head];
  let used = head.length;
  while (used < targetChars) {
    const c = gen.next().value;
    parts.push(c);
    used += c.length;
  }
  parts.push(`\n请依据资料开头处的命例事实与断语规则，判断该命例的结论。只答四个字，不要解释。`);
  return parts.join("");
}

const parseA = (text, needles) => {
  const t = text.toUpperCase();
  return {
    head: t.includes(needles.head),
    mid: t.includes(needles.mid),
    tail: t.includes(needles.tail),
  };
};

async function main() {
  console.log(
    `== 注意力深度探针 ==\n模型: ${MODEL}  深度: ${DEPTHS.join("/")}K  每档轮数: ${RUNS}`,
  );
  const cal = await calibrate();
  console.log(
    `标定: 1 token ≈ ${cal.charsPerToken.toFixed(2)} 字符（probe ${cal.inputTokens} tokens）\n`,
  );

  const results = [];
  for (const depth of DEPTHS) {
    for (let run = 1; run <= RUNS; run++) {
      const needles = { head: code(), mid: code(), tail: code() };
      const bodyA = {
        model: MODEL,
        max_tokens: 512,
        system: "你是测试助手，严格按要求的格式作答。",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: buildTaskA(depth * 1000, cal.charsPerToken, needles) }],
          },
        ],
      };
      const rA = await callAnthropic(bodyA);
      const textOf = (j) =>
        (j?.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join(" / ");
      const answerA = textOf(rA.json);
      const scoreA = rA.json
        ? parseA(answerA, needles)
        : { head: false, mid: false, tail: false, error: rA.status };

      await new Promise((r) => setTimeout(r, 3000));
      const bodyB = {
        model: MODEL,
        max_tokens: 512,
        system: "你是测试助手，严格按要求的格式作答。",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: buildTaskB(depth * 1000, cal.charsPerToken) }],
          },
        ],
      };
      const rB = await callAnthropic(bodyB);
      const answerB = textOf(rB.json);
      const scoreB = rB.json ? answerB.includes("禄贵交驰") : false;

      const row = {
        depthK: depth,
        run,
        usageA: rA.json?.usage?.input_tokens,
        usageB: rB.json?.usage?.input_tokens,
        retrieval: scoreA,
        reasoning: scoreB,
        answerA: answerA.trim().slice(0, 60),
        answerB: answerB.trim().slice(0, 20),
        ...(rA.error ? { errorA: rA.error } : {}),
        ...(rB.error || (!rB.json && rB.status) ? { errorB: rB.error ?? `HTTP ${rB.status}` } : {}),
      };
      results.push(row);
      console.log(
        `[${depth}K #${run}] tokens=${row.usageA ?? "?"} 检索 H/M/T=${scoreA.head ? 1 : 0}${scoreA.mid ? 1 : 0}${scoreA.tail ? 1 : 0} 推理=${scoreB ? 1 : 0} ${scoreB ? "" : `(${row.answerB})`}`,
      );
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  // 聚合曲线
  const curve = DEPTHS.map((depth) => {
    const rows = results.filter((r) => r.depthK === depth);
    const avg = (fn) => rows.filter(fn).length / rows.length;
    return {
      depthK: depth,
      avgTokens: Math.round(rows.reduce((s, r) => s + (r.usageA ?? 0), 0) / rows.length),
      headHit: avg((r) => r.retrieval.head === true),
      midHit: avg((r) => r.retrieval.mid === true),
      tailHit: avg((r) => r.retrieval.tail === true),
      reasoningHit: avg((r) => r.reasoning === true),
    };
  });
  console.log(`\n== 衰减曲线 ==`);
  console.log("深度    tokens   头部   中部   尾部   推理");
  for (const c of curve) {
    console.log(
      `${String(c.depthK).padStart(4)}K ${String(c.avgTokens).padStart(8)}  ${pct(c.headHit)}  ${pct(c.midHit)}  ${pct(c.tailHit)}  ${pct(c.reasoningHit)}`,
    );
  }
  const out = {
    model: MODEL,
    ranAt: new Date().toISOString(),
    calibration: cal,
    curve,
    runs: results,
  };
  mkdirSync(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), {
    recursive: true,
  });
  writeFileSync(
    new URL("./attention-depth-result.json", import.meta.url),
    JSON.stringify(out, null, 2),
  );
  console.log(`\n已写 bench/attention-depth-result.json`);
}
function pct(v) {
  return `${Math.round(v * 100)}%`.padStart(4);
}
main().catch((e) => {
  console.error("probe 异常:", e.message);
  process.exit(1);
});
