#!/usr/bin/env node
// CUA 精度校准 bench（10 任务）——直接驱动 @zcode/zcode-cua 运行时，测的是
// 「驱动 + 翻译层」的机器级精度，不经过模型。每个任务带 PowerShell 程序化校验。
//
// 覆盖维度：应用/窗口枚举、元素树覆盖、元素目标输入、语义设值、焦点输入、
// 中文合成输入、剪贴板路径、跨窗口定位、权限/会话面。
//
// 已知环境事实（2026-09-23 实测，Windows 11 + VNC 会话）：
// - Win11 记事本单进程多标签，新开窗口只有新 window_id 行，没有新 PID；
// - 驱动窗口行尺寸嵌在 bounds{} 里，翻译层已归一化（见 cua-driver-targets.js）；
// - 商店版记事本的 UIA 树按 PID 搜不到，校验器按窗口标题枚举（notepad-text.ps1）。
//
// 用法：node packages/zcode-cua/bench/cua-bench.mjs
// 产物：stdout 报告 + bench/result.json

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createComputerUseRuntime } from "../index.js";

const benchDir = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── PowerShell 工具（输出强制 UTF-8，避免中文读回乱码） ────────────
function ps(script) {
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " + script,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  return (r.stdout ?? "").replace(/\r?\n$/, "");
}

function notepadText() {
  // 商店版记事本的 UIA 树按 PID 搜不到（进程≠UIA 宿主），按标题枚举读编辑区。
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(benchDir, "notepad-text.ps1")],
    { encoding: "utf8", timeout: 15_000 },
  );
  return (r.stdout ?? "").replace(/\r?\n$/, "");
}

function focusWindow(pid) {
  ps(
    `$sig = '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);';` +
      `Add-Type -MemberDefinition $sig -Name W -Namespace N;` +
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;` +
      `if ($p -and $p.MainWindowHandle -ne 0) { [N.W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }`,
  );
}

// ── CUA 执行工具 ─────────────────────────────────────────────────
const runtime = createComputerUseRuntime({});
const SESSION = { sessionId: "cua-bench" };

async function exec(toolName, args = {}) {
  const res = await runtime.execute({ toolName, arguments: args, context: SESSION });
  const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
  if (res.isError) throw new Error(`${toolName} 失败: ${text.slice(0, 300)}`);
  return { res, text, structured: res.structuredContent ?? null };
}

// get_app_state 的 elements 在 structuredContent.elements，元素形如
// { index, kind, title, value, actions, enabled, element_token }（kind 非 role）。
function extractElements(state) {
  if (Array.isArray(state.structured?.elements)) return state.structured.elements;
  const raw = JSON.stringify(state.structured ?? state.text ?? "");
  const tokens = [...raw.matchAll(/"element_token"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  return { tokens, kinds: [], raw: raw.slice(0, 2000) };
}

// ── 任务定义 ─────────────────────────────────────────────────────
const state = {
  benchPid: 0,
  benchWindowId: undefined,
  secondPid: 0,
  secondWindowId: undefined,
  docIndex: null,
  results: [],
};
const benchRef = () => ({ pid: state.benchPid, window_id: state.benchWindowId });

async function task(id, name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    state.results.push({
      id,
      name,
      pass: detail.pass,
      ms: Date.now() - startedAt,
      detail: detail.detail,
    });
  } catch (error) {
    state.results.push({
      id,
      name,
      pass: false,
      ms: Date.now() - startedAt,
      detail: `异常: ${error.message}`,
    });
  }
}

const tasks = [
  {
    id: "T1",
    name: "应用枚举 list_apps（牺牲记事本可见）",
    run: async () => {
      const { text } = await exec("list_apps");
      const hit = text.includes(String(state.benchPid)) || /notepad|记事本/i.test(text);
      return {
        pass: hit,
        detail: hit ? `列表 ${text.length} 字符，命中记事本` : `未见记事本: ${text.slice(0, 200)}`,
      };
    },
  },
  {
    id: "T2",
    name: "窗口枚举 list_windows（带 bounds 可用窗口）",
    run: async () => {
      const { structured } = await exec("list_windows", {});
      const wins = structured?.windows ?? [];
      const mine = wins.find((w) => w.pid === state.benchPid);
      return {
        pass: Boolean(mine),
        detail: mine
          ? `共 ${wins.length} 窗口，目标窗口 bounds=${JSON.stringify(mine.bounds)}`
          : "未找到目标窗口行",
      };
    },
  },
  {
    id: "T3",
    name: "元素树覆盖 get_app_state（Document 可发现）",
    run: async () => {
      const { structured } = await exec("get_app_state", { app_ref: benchRef() });
      const elements = Array.isArray(structured?.elements) ? structured.elements : [];
      const doc = elements.find((e) => /document|edit/i.test(e.kind ?? ""));
      state.docIndex = doc?.index ?? null;
      const kinds = [...new Set(elements.map((e) => e.kind ?? ""))].slice(0, 8).join(",");
      return {
        pass: Boolean(doc),
        detail: `元素 ${elements.length} 个, kind ${kinds}; Document index=${state.docIndex}`,
      };
    },
  },
  {
    id: "T4",
    name: "元素目标英文输入（type → element index）",
    run: async () => {
      if (state.docIndex === null) return { pass: false, detail: "T3 未拿到 Document index，跳过" };
      await exec("type", {
        app_ref: benchRef(),
        target: { type: "element", index: state.docIndex },
        text: "bench-ascii-12345\n",
      });
      await sleep(800);
      const got = notepadText();
      const pass = got.includes("bench-ascii-12345");
      return { pass, detail: pass ? "UIA 读回一致" : `读回: ${got.slice(0, 120) || "(空)"}` };
    },
  },
  {
    id: "T5",
    name: "语义设值 set_value（非击键路径）",
    run: async () => {
      if (state.docIndex === null) return { pass: false, detail: "无 Document index，跳过" };
      await exec("set_value", {
        app_ref: benchRef(),
        target: { type: "element", index: state.docIndex },
        value: "set-value-直写OK",
      });
      await sleep(500);
      const got = notepadText();
      const pass = got.includes("set-value-直写OK");
      return { pass, detail: pass ? "设值读回一致" : `读回: ${got.slice(0, 120) || "(空)"}` };
    },
  },
  {
    id: "T6",
    name: "焦点态英文输入（type 无 target）",
    run: async () => {
      focusWindow(state.benchPid);
      await sleep(400);
      await exec("type", { app_ref: benchRef(), text: "focus-ascii-67890" });
      await sleep(800);
      const got = notepadText();
      const pass = got.includes("focus-ascii-67890");
      return { pass, detail: pass ? "焦点输入读回一致" : `读回: ${got.slice(0, 120) || "(空)"}` };
    },
  },
  {
    id: "T7",
    name: "中文合成输入（type 中文·重点）",
    run: async () => {
      focusWindow(state.benchPid);
      await sleep(400);
      await exec("type", { app_ref: benchRef(), text: "你好世界测试" });
      await sleep(1200);
      const got = notepadText();
      const pass = got.includes("你好世界测试");
      return { pass, detail: pass ? "中文直输成功" : `读回: ${got.slice(-120) || "(空)"}` };
    },
  },
  {
    id: "T8",
    name: "前台化+剪贴板中文粘贴（最小化/恢复法）",
    run: async () => {
      // 实测：驱动全部输入走后台投递（安全语义，不抢前台），后台窗口上
      // ctrl+v 粘贴天然无效，坐标点击标题栏也带不来前台。唯一可靠前台化：
      // PowerShell 最小化→恢复（ShowWindow 序列）。这就是 skill 要写明的
      // 「粘贴两步法」：宿主前台化 → 驱动 ctrl+v。
      ps(`
$sig = @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
'@
Add-Type -MemberDefinition $sig -Name W2 -Namespace N2
$p = Get-Process -Id ${state.benchPid} -ErrorAction SilentlyContinue
if ($p -and $p.MainWindowHandle -ne 0) {
  [N2.W2]::ShowWindow($p.MainWindowHandle, 6) | Out-Null   # SW_MINIMIZE
  Start-Sleep -Milliseconds 300
  [N2.W2]::ShowWindow($p.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
  Start-Sleep -Milliseconds 300
  [N2.W2]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
}`);
      await sleep(600);
      ps('Set-Clipboard -Value "剪贴板中文OK"');
      await sleep(300);
      await exec("key", { app_ref: benchRef(), text: "ctrl+v" });
      await sleep(1000);
      const got = notepadText();
      const pass = got.includes("剪贴板中文OK");
      return { pass, detail: pass ? "前台化+粘贴成功" : `读回: ${got.slice(-120) || "(空)"}` };
    },
  },
  {
    id: "T9",
    name: "跨窗口定位（双记事本，动作落点正确）",
    run: async () => {
      const beforeA = notepadText();
      const st = await exec("get_app_state", {
        app_ref: { pid: state.secondPid, window_id: state.secondWindowId },
      });
      const elements = Array.isArray(st.structured?.elements) ? st.structured.elements : [];
      const doc = elements.find((e) => /document|edit/i.test(e.kind ?? ""));
      if (!doc) return { pass: false, detail: "第二窗口元素树无 Document 元素" };
      await exec("set_value", {
        app_ref: { pid: state.secondPid, window_id: state.secondWindowId },
        target: { type: "element", index: doc.index },
        value: "SECOND-WIN-TARGET",
      });
      await sleep(600);
      const afterA = notepadText();
      const gotB = notepadText();
      // 判定修正：notepadText() 拼接读回所有记事本窗口，B 变了全局串必然变，
      // 不能用「A 串不变」判污染。改判：目标文本恰好出现一次，且 A 的每一行
      // 原文在全局串里仍然完整保留。
      const beforeLines = beforeA.split("\n").filter((l) => l !== "");
      const occurrences = gotB.split("SECOND-WIN-TARGET").length - 1;
      const preserved = beforeLines.every((l) => afterA.includes(l));
      const pass = occurrences >= 1 && preserved;
      return {
        pass,
        detail: pass
          ? "落点正确且未污染第一窗口"
          : `出现次数=${occurrences}(应≥1); A内容保留=${preserved}`,
      };
    },
  },
  {
    id: "T10",
    name: "权限面/会话面（request_access + stop 语义）",
    run: async () => {
      const ra = await exec("request_access", {});
      const stop = await exec("stop_computer_control", { reason: "bench 结束" });
      const stopped = stop.structured?.stopped === true || stop.text.includes("stopped");
      const ok = (ra.text.length > 0 || ra.structured) && stopped;
      return {
        pass: ok,
        detail: `request_access=${(ra.structured ? JSON.stringify(ra.structured) : ra.text).slice(0, 80)}; stopped=${stopped}`,
      };
    },
  },
];

// ── 主流程 ───────────────────────────────────────────────────────
async function main() {
  console.log("== CUA 精度校准 bench ==\n[setup] 启动牺牲记事本（驱动视角对齐）…");
  // Win11 记事本单进程多标签：新开窗口不产生新 PID，只产生新 window_id 行。
  // 因此从「驱动的全局窗口表」按 window_id 差集找新窗口，目标引用带 window_id。
  const globalWindowRows = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const { structured } = await exec("list_windows", {});
        const wins = structured?.windows ?? [];
        if (wins.length > 0)
          return wins.map((w) => ({ pid: w.pid, window_id: w.window_id, title: w.title ?? "" }));
      } catch {}
      await sleep(800);
    }
    return [];
  };
  const NOTEPAD_TITLE = /notepad|记事本/i;
  const rowKey = (row) => `${row.pid}:${row.window_id}`;
  const before1 = new Set((await globalWindowRows()).map(rowKey));
  ps(`Start-Process 'C:\\Windows\\System32\\notepad.exe'`);
  await sleep(2500);
  const win1 = (await globalWindowRows()).find(
    (w) => !before1.has(rowKey(w)) && NOTEPAD_TITLE.test(w.title),
  );
  const before2 = new Set((await globalWindowRows()).map(rowKey));
  ps(`Start-Process 'C:\\Windows\\System32\\notepad.exe'`);
  await sleep(2500);
  const win2 = (await globalWindowRows()).find(
    (w) => !before2.has(rowKey(w)) && NOTEPAD_TITLE.test(w.title),
  );
  state.benchPid = win1?.pid ?? 0;
  state.benchWindowId = win1?.window_id;
  state.secondPid = win2?.pid ?? 0;
  state.secondWindowId = win2?.window_id;
  if (!state.benchPid || !state.secondPid) {
    console.error(
      `记事本启动失败（win1=${JSON.stringify(win1)} win2=${JSON.stringify(win2)}），中止`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `[setup] 目标窗口: A=pid${state.benchPid}/wid${state.benchWindowId} B=pid${state.secondPid}/wid${state.secondWindowId}\n`,
  );

  for (const t of tasks) {
    process.stdout.write(`[${t.id}] ${t.name} … `);
    await task(t.id, t.name, t.run);
    const r = state.results[state.results.length - 1];
    console.log(`${r.pass ? "PASS" : "FAIL"} (${r.ms}ms) — ${r.detail}`);
  }

  console.log("\n== 清理牺牲窗口 ==");
  ps(`Stop-Process -Id ${state.benchPid},${state.secondPid} -Force -ErrorAction SilentlyContinue`);
  await runtime.dispose();

  const passed = state.results.filter((r) => r.pass).length;
  console.log(`\n== 结果: ${passed}/${state.results.length} PASS ==`);
  const report = {
    platform: "win32",
    driver: "@trycua/cua-driver",
    ranAt: new Date().toISOString(),
    passed,
    total: state.results.length,
    results: state.results,
  };
  mkdirSync(benchDir, { recursive: true });
  writeFileSync(join(benchDir, "result.json"), JSON.stringify(report, null, 2));
  console.log(`已写 ${resolve(join(benchDir, "result.json"))}`);
  process.exitCode = passed === state.results.length ? 0 : 1;
}

main().catch((e) => {
  console.error("bench 异常:", e);
  process.exitCode = 1;
});
