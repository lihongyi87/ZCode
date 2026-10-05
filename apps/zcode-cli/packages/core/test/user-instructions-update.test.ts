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
  // 注入后基线已更新：后续为轻量指针（防遗忘），非全文非 null
  const after = await buildUserInstructionsUpdateBody({ runtime, fileSystem: fs, sourcePaths: [AGENTS] });
  assert.ok(after !== null && !after.includes("新增约定"), "后续是指针不是全文");
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
  // 两个源都删：跳过不注入全文，但历史变更指针仍在（changedSources 记忆）
  delete files[user];
  delete files[ws];
  const afterDelete = await buildUserInstructionsUpdateBody({ runtime, fileSystem: fs, sourcePaths: [user, ws] });
  assert.ok(afterDelete === null || afterDelete.length < 400, "删除后不注全文");
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

test("变更后持续注入轻量指针（防遗忘/防压缩丢失），直到再次变更覆盖", async () => {
  const AGENTS2 = "W:\proj2\AGENTS.md";
  const files = { [AGENTS2]: { mtimeMs: 1, content: "# v1" } };
  const fs = fsWith(files);
  const runtime = {};
  await buildUserInstructionsUpdateBody({ runtime, fileSystem: fs, sourcePaths: [AGENTS2] }); // 基线
  files[AGENTS2] = { mtimeMs: 2, content: "# v2" };
  const full = await buildUserInstructionsUpdateBody({ runtime, fileSystem: fs, sourcePaths: [AGENTS2] });
  assert.ok(full?.includes("# v2"), "变更当轮注全文");
  const pointer1 = await buildUserInstructionsUpdateBody({ runtime, fileSystem: fs, sourcePaths: [AGENTS2] });
  assert.ok(pointer1?.includes("已过时"), "后续 turn 注指针");
  assert.ok(!pointer1?.includes("# v2"), "指针不重复全文");
  assert.ok(pointer1!.length < 400, "指针保持轻量");
  const pointer2 = await buildUserInstructionsUpdateBody({ runtime, fileSystem: fs, sourcePaths: [AGENTS2] });
  assert.ok(pointer2?.includes(AGENTS2), "指针持续存在");
});
