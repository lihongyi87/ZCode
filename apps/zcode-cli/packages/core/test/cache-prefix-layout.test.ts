import assert from "node:assert/strict";
import test from "node:test";
import { ContextBuilder } from "../src/context/builder.js";
import { buildIdentitySection } from "../src/context/sections/identity.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";
import { systemReminderAttachmentEntry } from "../src/agent/message-history.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import type { ContextBuilderConfig } from "../src/context/types.js";

/**
 * 缓存前缀布局回归测试（cache breakpoints + identity 归位）。
 *
 * 断言两条不变量：
 * 1. identity 段归 dynamic 桶且只出现在最后一条 system——主代理与子代理的
 *    system 前缀得以共享到 identity 之前（跨 agent provider KV 缓存）。
 * 2. 第四断点落在 meta-user 边界（context_prefix 附件尾部 = AGENTS.md 块尾），
 *    cli-prefix 不再单独占断点；skipCacheWrite（compact）时不新增写断点。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/cache-prefix-layout.test.ts
 */

const envInfo = {
  cwd: "F:\\repo",
  platform: "win32",
  shell: "bash",
  osVersion: "10.0",
  nodeVersion: "24.14.0",
  isGitRepository: false,
  gitStatus: "not_repo" as const,
};

const baseConfig: ContextBuilderConfig = {
  workingDirectory: "F:\\repo",
  envInfo,
  presentationSurface: "terminal",
};

test("identity 段归 dynamic 桶（跨 agent 共享前提）", () => {
  assert.equal(buildIdentitySection().cacheHint, "dynamic");
});

test("默认体系：identity 只出现在最后一条 system，且在共享段之后", () => {
  // desktop 面板才有 stable body（desktop 段）；terminal 面板 stable 桶为空。
  const result = new ContextBuilder({
    ...baseConfig,
    presentationSurface: "zcode_desktop",
  }).build();
  const systemMessages = result.systemMessages;
  assert.ok(systemMessages.length >= 2, "至少 cli-prefix + dynamic 两条 system");
  const identityText = buildIdentitySection().content.slice(0, 60);

  for (let i = 0; i < systemMessages.length - 1; i += 1) {
    assert.ok(
      !systemMessages[i]!.content.includes(identityText),
      `system[${i}] 不得包含 identity（identity 之前的 system 前缀必须跨 agent 共享）`,
    );
  }
  const dynamicBody = systemMessages[systemMessages.length - 1]!.content;
  const identityAt = dynamicBody.indexOf(identityText);
  assert.ok(identityAt >= 0, "identity 应在最后一条 system（dynamic body）内");
  // 共享段锚点必须在 identity 之前。
  for (const anchor of ["git status", "Is a git repository", "Context Management"]) {
    const anchorAt = dynamicBody.indexOf(anchor);
    if (anchorAt >= 0) {
      assert.ok(anchorAt < identityAt, `共享段「${anchor}」必须在 identity 之前`);
    }
  }
});

test("cli-prefix 消息不再单独占缓存断点", () => {
  const result = new ContextBuilder({ ...baseConfig }).build();
  const cliPrefix = result.systemMessages[0];
  assert.ok(cliPrefix);
  assert.equal(
    cliPrefix.cacheControl,
    undefined,
    "cli-prefix 断点被 stable body 断点覆盖，单独标记浪费配额",
  );
  // 最后一条 system（dynamic body）仍保有断点。
  assert.ok(result.systemMessages.at(-1)?.cacheControl);
});

// ── 第四断点（meta-user 边界）──

// 真实形态：AGENTS.md/context_prefix 是 system-reminder 附件（RuntimeMessageSource
// 里的 shared_context 走 message 形态，不经过 attachment 渲染路径）。
const contextPrefixAttachment = systemReminderAttachmentEntry(
  "context_prefix",
  "# agentsMd\n用户全局指令内容。",
);
const skillsAttachment = systemReminderAttachmentEntry(
  "skills_listing",
  "The following skills are available...",
);
const realUser: RuntimeMessageEntry = {
  kind: "message",
  message: { role: "user", content: [{ type: "text", text: "开始干活" }] },
  metadata: { source: "real_user" },
};
const assistantMsg: RuntimeMessageEntry = {
  kind: "message",
  message: { role: "assistant", content: "好的" },
};

test("第四断点落在 meta-user 边界（context_prefix），尾断点在滚动位", () => {
  const result = buildProviderRequestMessages({
    entries: [skillsAttachment, contextPrefixAttachment, realUser, assistantMsg],
    applyCacheControl: true,
  });
  const boundary = result.diagnostics.metaUserBoundaryIndex;
  assert.ok(boundary !== undefined, "context_prefix 附件必须给出边界下标");
  const boundaryMessage = result.messages[boundary!];
  assert.equal(boundaryMessage?.role, "user");
  assert.deepEqual(boundaryMessage?.cacheControl, { type: "ephemeral" });

  const tailIndex = result.diagnostics.cacheControlIndex;
  assert.ok(tailIndex !== undefined);
  assert.notEqual(tailIndex, boundary, "尾断点与边界断点是两个不同位置");
  assert.deepEqual(result.messages[tailIndex!]?.cacheControl, { type: "ephemeral" });
  // 边界断在 context_prefix（AGENTS.md）上而不是 skills_listing 上。
  assert.ok(String(boundaryMessage?.content ?? "").includes("agentsMd"));
});

test("skipCacheWrite（compact 请求）：不新增边界写断点", () => {
  const result = buildProviderRequestMessages({
    entries: [skillsAttachment, contextPrefixAttachment, realUser, assistantMsg],
    applyCacheControl: true,
    skipCacheWrite: true,
  });
  const boundary = result.diagnostics.metaUserBoundaryIndex;
  // compact 语义：只保留前移的尾断点，边界不写。
  assert.equal(result.messages[boundary ?? -1]?.cacheControl, undefined);
});

test("无 context_prefix 时无边界断点（行为退化为原三断点布局）", () => {
  const result = buildProviderRequestMessages({
    entries: [realUser, assistantMsg],
    applyCacheControl: true,
  });
  assert.equal(result.diagnostics.metaUserBoundaryIndex, undefined);
});
