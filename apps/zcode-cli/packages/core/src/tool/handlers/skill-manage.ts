import {
  CoreErrorType,
  SKILL_MANAGE_INPUT_SCHEMA,
  SKILL_MANAGE_TOOL_NAME,
  SkillManageInputJsonSchema,
  createCoreError,
} from "@zcode/contracts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_SKILL_BODY_CHARS = 32_768;
const MAX_DESCRIPTION_CHARS = 400;

const SKILL_MANAGE_PROVIDER_DESCRIPTION = [
  "# SkillManage",
  "",
  "Persist a reusable procedure as a personal skill so future sessions can invoke it",
  "with /<name>. Use it when: a multi-step workflow worked and is worth repeating; you",
  "hit errors or dead ends and found the working path; or the user corrected your",
  "approach. Lessons, not logs — store a generalizable rule plus one line of why.",
  "",
  "```json",
  '{"action": "create", "name": "deploy-checklist", "description": "Pre-deploy verification steps for this repo", "body": "## When to Use\\n...\\n## Procedure\\n...\\n## Pitfalls\\n...\\n## Verification\\n..."}',
  "```",
  "",
  "create writes ~/.zcode/skills/<name>/SKILL.md (system-generated frontmatter); an",
  "existing name is rejected — use action=patch with old_text/new_text instead. The",
  "body should use sections in this order: When to Use / Procedure / Pitfalls /",
  "Verification. Requires approval. New skills become discoverable from the next",
  "session; this session you can still Read the returned file.",
].join("\n");

/** 用户级技能目录(spec 152:与 skills discovery 的 user scope 同源)。
 * ZCODE_SKILLS_HOME 供测试隔离(临时 HOME),生产不设走真 homedir。 */
export function skillManageDirectory(homeDirectory?: string): string {
  const home =
    homeDirectory ?? process.env.ZCODE_SKILLS_HOME ?? homedir();
  return join(home, ".zcode", "skills");
}

function skillFileFor(name: string, homeDirectory?: string): string {
  return join(skillManageDirectory(homeDirectory), name, "SKILL.md");
}

function requireManageInput(input: unknown) {
  const parsed = SKILL_MANAGE_INPUT_SCHEMA.parse(input);
  if (parsed.action === "create" && (!parsed.description || !parsed.body)) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      "SkillManage create requires description and body",
      { context: { toolName: SKILL_MANAGE_TOOL_NAME }, recoverable: true },
    );
  }
  if (parsed.action === "patch" && (!parsed.old_text || parsed.new_text === undefined)) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      "SkillManage patch requires old_text and new_text",
      { context: { toolName: SKILL_MANAGE_TOOL_NAME }, recoverable: true },
    );
  }
  if (parsed.description && parsed.description.length > MAX_DESCRIPTION_CHARS) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      `description exceeds ${MAX_DESCRIPTION_CHARS} characters`,
      { context: { toolName: SKILL_MANAGE_TOOL_NAME }, recoverable: true },
    );
  }
  return parsed;
}

function fail(code: string, message: string, toolCallId: string) {
  return createCoreError(
    CoreErrorType.ToolExecutionFailed,
    message,
    { context: { code, toolCallId }, recoverable: true },
  );
}

const skillManageHandler: ToolHandler = async (input, context) => {
  const parsed = requireManageInput(input);
  const skillFile = skillFileFor(parsed.name);

  if (parsed.action === "create") {
    if (existsSync(skillFile)) {
      throw fail(
        "skill_manage_exists",
        `Skill "${parsed.name}" already exists at ${skillFile}. Use action=patch to update it.`,
        context.toolCallId,
      );
    }
    const body = parsed.body ?? "";
    if (body.length > MAX_SKILL_BODY_CHARS) {
      throw createCoreError(
        CoreErrorType.InvalidInput,
        `body exceeds ${MAX_SKILL_BODY_CHARS} characters (${body.length})`,
        { context: { toolName: SKILL_MANAGE_TOOL_NAME }, recoverable: true },
      );
    }
    const frontmatter = [
      "---",
      `name: ${parsed.name}`,
      `description: ${parsed.description}`,
      "metadata:",
      "  created_by: skill_manage",
      "---",
      "",
    ].join("\n");
    mkdirSync(dirname(skillFile), { recursive: true });
    writeFileSync(skillFile, `${frontmatter}${body.trimStart()}\n`, "utf8");
    return {
      action: "create",
      path: skillFile,
      chars: body.length,
      note: `Saved. Discoverable from the next session (/${parsed.name} or the Skill tool); this session you can still Read the file.`,
    };
  }

  if (!existsSync(skillFile)) {
    throw fail(
      "skill_manage_missing",
      `Skill "${parsed.name}" does not exist. Use action=create first.`,
      context.toolCallId,
    );
  }
  const current = readFileSync(skillFile, "utf8");
  const occurrences = current.split(parsed.old_text!).length - 1;
  if (occurrences === 0) {
    throw fail(
      "skill_manage_old_text_missing",
      "old_text not found in the skill body; Read the file and retry with an exact substring.",
      context.toolCallId,
    );
  }
  if (occurrences > 1) {
    throw fail(
      "skill_manage_old_text_ambiguous",
      `old_text occurs ${occurrences} times; provide a longer, unique substring.`,
      context.toolCallId,
    );
  }
  const updated = current.replace(parsed.old_text!, parsed.new_text!);
  if (updated.length > MAX_SKILL_BODY_CHARS) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      `updated skill exceeds ${MAX_SKILL_BODY_CHARS} characters (${updated.length})`,
      { context: { toolName: SKILL_MANAGE_TOOL_NAME }, recoverable: true },
    );
  }
  writeFileSync(skillFile, updated, "utf8");
  return { action: "patch", path: skillFile, chars: updated.length };
};

export const skillManageToolEntry: ToolEntry = {
  capability: "Persist reusable procedures as personal skills (agent-authored, approval-gated)",
  metadata: {
    shouldDefer: true,
    name: SKILL_MANAGE_TOOL_NAME,
    searchHint: "save skill lesson procedure memory",
    description: SKILL_MANAGE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 15_000,
    maxOutputBytes: 4096,
    sideEffectScope: "system",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: skillManageHandler,
  inputSchema: SkillManageInputJsonSchema,
  outputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "patch"] },
      path: { type: "string" },
      chars: { type: "integer" },
      note: { type: "string" },
    },
    required: ["action", "path", "chars"],
    additionalProperties: false,
  },
  runtimeInputSchema: SKILL_MANAGE_INPUT_SCHEMA,
  permission: {
    permission: "skill.manage.write",
    reason: "SkillManage writes a skill into the user-level skills directory",
    riskLevel: "medium",
    sideEffectScope: "system",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 4096,
    maxModelBytes: 4096,
    strategy: "truncate",
    preview: { maxBytes: 4096, direction: "head" },
  },
  timeout: { defaultMs: 15_000, maxMs: 15_000, allowCallOverride: false },
  cancellation: { supported: false, cleanup: "none", userVisibleMessage: "SkillManage is not cancellable" },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export function formatSkillManageModelContent(output: unknown): string {
  const parsed = output as { action?: string; path?: string; note?: string };
  return [`${parsed.action ?? "done"}: ${parsed.path ?? ""}`, parsed.note].filter(Boolean).join("\n");
}
