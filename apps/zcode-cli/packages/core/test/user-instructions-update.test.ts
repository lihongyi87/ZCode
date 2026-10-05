import assert from "node:assert/strict";
import test from "node:test";

import { buildUserInstructionsUpdateBody } from "../src/runtime/methods/user-instructions-update-reminder.js";
import type { FileSystemPort } from "@zcode/contracts";

/**
 * ② 用户指令（AGENTS.md）热更新：首 turn 建基线不注入；mtime/size 变更后
 * 注入新版全文；未变更静默；文件被删不注入。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/user-instructions-update.test.ts
 */

function fsWith(files: Record<string, { mtimeMs: number; content: string }>): FileSystemPort {
  return {
    async stat({ path }) {
      const f = files[path];
      if (!f) throw new Error(`ENOENT: ${path}`);
      return { path, kind: "file", sizeBytes: f.content.length, mtimeMs: f.mtimeMs };
    },
    async readTextFile({ path }) {
      const f = files[path];
      if (!f) throw new Error(`ENOENT: ${path}`);
      return { path, content: f.content, encoding: "utf8", bytesRead: f.content.length, sizeBytes: f.content.length, truncated: false };
    },
  } as unknown as FileSystemPort;
}

const AGENTS = "W:\\proj\\AGENTS.md";

test("首 turn 建基线不注入；同签名静默；变更后注入新版", async () => {
  const files = { [AGENTS]: { mtimeMs: 100, content: "# 原版指令" } };
  const fs = fsWith(files);
  const runtime = {};
  // 首 turn：建基线，null
  assert.equal(await buildUserInstructionsUpdateBody({ runtime, fileSystem: fs, sourcePaths: [AGENTS] }), null);
  // 未变更：静默
  assert.equal(await buildUserInstructionsUpdateBody({ runtime, fileSystem: fs, sourcePaths: [AGENTS] }), null);
  // 变更（mtime+内容）：注入新版
  files[AGENTS] = { mtimeMs: 200, content: "# 原版指令\n\n## 新增约定：预测登记" };
  const body = await buildUserInstructionsUpdateBody({ runtime, fileSystem: fs, sourcePaths: [AGENTS] });
  assert.ok(body?.includes("新增约定：预测登记"), `应含新版内容，实际: ${body}`);
  assert.ok(body?.includes("优先于系统前缀"), "应声明新版优先");
  // 注入后基线已更新：再次静默
  assert.equal(await buildUserInstructionsUpdateBody({ runtime, fileSystem: fs, sourcePaths: [AGENTS] }), null);
});

test("多源（user+workspace）：任一变更注入该源；文件被删跳过不注入", async () => {
  const user = "C:\\Users\\u\\.zcode\\AGENTS.md";
  const ws = "W:\\proj\\AGENTS.md";
  const files = {
    [user]: { mtimeMs: 10, content: "# 全局" },
    [ws]: { mtimeMs: 20, content: "# 项目" },
  };
  const fs = fsWith(files);
  const runtime = {};
  await buildUserInstructionsUpdateBody({ runtime, fileSystem: fs, sourcePaths: [user, ws] });
  // 只改 workspace 源
  files[ws] = { mtimeMs: 99, content: "# 项目（改）" };
  const body = await buildUserInstructionsUpdateBody({ runtime, fileSystem: fs, sourcePaths: [user, ws] });
  assert.ok(body?.includes("# 项目（改）"), "变更源注入");
  assert.ok(!body?.includes("# 全局"), "未变源不重复注入");
  // 两个源都删：current 空 → unchanged? current.size(0) vs slot.size(2) → changed 为空 → null
  delete files[user];
  delete files[ws];
  assert.equal(await buildUserInstructionsUpdateBody({ runtime, fileSystem: fs, sourcePaths: [user, ws] }), null);
});

test("超大文件截尾到 32K 并带截断标记", async () => {
  const big = "W:\\proj\\AGENTS.md";
  const files = { [big]: { mtimeMs: 1, content: "x".repeat(100) } };
  const fs = fsWith(files);
  const runtime = {};
  await buildUserInstructionsUpdateBody({ runtime, fileSystem: fs, sourcePaths: [big] });
  files[big] = { mtimeMs: 2, content: "y".repeat(40_000) };
  const body = await buildUserInstructionsUpdateBody({ runtime, fileSystem: fs, sourcePaths: [big] });
  assert.ok((body?.length ?? 0) < 34_000, "截尾生效");
  assert.ok(body?.includes("[…truncated…]"), "截断标记");
});
