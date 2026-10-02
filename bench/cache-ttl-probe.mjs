#!/usr/bin/env node
// 缓存 TTL 探针 v2（openai 门）——v1 的「TTL<1min」结论是伪象，根因已定：
//   anthropic 门 /api/anthropic 对 cache_control 完全不受理（背靠背同体连发
//   cache_read 恒 0，user 块/system 块 marker、两把 key、stream 真假全试过）；
//   openai 门 /api/coding/paas/v4 隐式前缀缓存背靠背必中（cached_tokens>0），
//   生产会话 cacheReadTokens>0 且 cacheWriteTokens=0 也印证走的是隐式缓存。
// 因此本探针打 openai 门，并先做缓存写 sanity check（必须 HIT 才排 TTL 表），
// 防止再产出「未写缓存被误读为已过期」的假 TTL。
//
// 用法：node bench/cache-ttl-probe.mjs [--model glm-5.2] [--depth-tokens 100000]
//       [--schedule 1,3,5,7,9,11,13,15]
// 产物：bench/cache-ttl-result.json + stdout

import { readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";

const argOf = (n, f) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : f;
};
const MODEL = argOf("--model", "glm-5.2");
const DEPTH_TOKENS = Number(argOf("--depth-tokens", "100000"));
const SCHEDULE_MIN = argOf("--schedule", "1,3,5,7,9,11,13,15").split(",").map(Number);
const OUT = new URL("./cache-ttl-result.json", import.meta.url);
const CONFIRM_REPROBE_DELAY_MS = 30_000; // 单次 MISS 后 30s 复探一次，区分 LRU 抖动与真过期

const real = JSON.parse(readFileSync("C:/Users/lihongyi/.zcode/v2/model-providers.json", "utf8"));
const list = Array.isArray(real.providers ?? real) ? (real.providers ?? real) : Object.values(real);
const cp = list.find((p) => p.id === "builtin:bigmodel-coding-plan");
if (!cp) {
  console.error("未找到 builtin:bigmodel-coding-plan");
  process.exit(1);
}
const BASE = cp.endpoints.openai;
const HEADERS = { "content-type": "application/json", authorization: `Bearer ${cp.apiKey}` };

// 填充语料：真实命理知识库（确定性切片，保证每次请求字节一致）
const FILLER_SOURCE = readFileSync("F:/智能体/大六壬/知识库/大六壬知识库.md", "utf8").replace(
  /\s+/g,
  " ",
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once(tag, body) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  const u = j.usage ?? {};
  const row = {
    tag,
    wallMs: Date.now() - t0,
    promptTokens: u.prompt_tokens ?? null,
    cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
  };
  console.log(
    `[${tag}] wall=${row.wallMs}ms prompt=${row.promptTokens} cached=${row.cachedTokens}`,
  );
  return row;
}

async function main() {
  console.log(
    `== 缓存 TTL 探针 v2（openai 门）==\n模型: ${MODEL}  深度: ~${DEPTH_TOKENS} tokens  表: [${SCHEDULE_MIN}]min\n门: ${BASE}\n`,
  );
  // ~1.29 字符/token（此前标定值），字符数按此折算
  const targetChars = Math.round(DEPTH_TOKENS * 1.29);
  const nonce = crypto.randomBytes(8).toString("hex"); // 防与历史探针缓存撞车
  const filler = FILLER_SOURCE.slice(0, Math.max(0, targetChars - 200));
  const body = {
    model: MODEL,
    max_tokens: 8,
    stream: false,
    messages: [
      { role: "system", content: `【TTL探针 ${nonce}】你是测试助手。${filler}` },
      { role: "user", content: "只回复：OK" },
    ],
  };

  // ── sanity：缓存写必须成立，否则 TTL 无从谈起 ──
  const cold = await once("cold", body);
  const hot = await once("hot-0s", body);
  if (!(hot.cachedTokens > 0)) {
    console.error("\n[abort] 背靠背复请求未命中缓存——此形态/此门不写缓存，TTL 测量无意义。");
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          model: MODEL,
          ranAt: new Date().toISOString(),
          sanity: { cold, hot },
          aborted: "no-cache-write",
        },
        null,
        2,
      ),
    );
    process.exit(2);
  }
  const ttftColdVsHot = {
    coldMs: cold.wallMs,
    hotMs: hot.wallMs,
    savingPct: Math.round((1 - hot.wallMs / Math.max(1, cold.wallMs)) * 100),
  };
  console.log(
    `[sanity] 缓存写成立；同深度 TTFT 冷=${cold.wallMs}ms 热=${hot.wallMs}ms（省 ${ttftColdVsHot.savingPct}%）\n`,
  );

  // ── TTL 表 ──
  const t0 = Date.now();
  const rows = [hot];
  let lastHitMin = 0;
  let expiryWindow = null;
  for (const m of SCHEDULE_MIN) {
    const waitMs = t0 + m * 60_000 - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    let r;
    try {
      r = await once(`t=${m}min`, body);
    } catch (e) {
      console.log(`[t=${m}min] 请求失败: ${String(e.message).slice(0, 120)}`);
      continue;
    }
    r.probeMin = m;
    if (r.cachedTokens > 0) {
      lastHitMin = m;
      rows.push(r);
      continue;
    }
    // 单次 MISS：30s 后复探确认真过期（隐式缓存可能 LRU 抖动）
    await sleep(CONFIRM_REPROBE_DELAY_MS);
    const r2 = await once(`t=${m}min-confirm`, body);
    r2.probeMin = m + 0.5;
    rows.push(r2);
    if (r2.cachedTokens > 0) {
      lastHitMin = m + 0.5;
      console.log(`  ↳ 复探命中，判为抖动，继续表`);
    } else {
      expiryWindow = { after: lastHitMin, before: m };
      console.log(`  ↳ 复探仍未命中，判为过期`);
      break;
    }
  }

  const out = {
    model: MODEL,
    ranAt: new Date().toISOString(),
    depthTokens: DEPTH_TOKENS,
    door: "openai",
    ttftColdVsHot,
    rows,
    expiryWindow,
    lastHitMin,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(
    `\n结论：缓存至少存活 ${lastHitMin}min${expiryWindow ? `，过期窗口 (${expiryWindow.after}, ${expiryWindow.before})min` : "（表内未观测到过期）"}`,
  );
  console.log(`已写 ${OUT.pathname.replace(/^\/([A-Za-z]:)/, "$1")}`);
}

main().catch((e) => {
  console.error("probe 异常:", e);
  process.exit(1);
});
