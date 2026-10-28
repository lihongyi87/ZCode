import {
  CoreErrorType,
  SKILL_MANAGE_INPUT_SCHEMA,
  SKILL_MANAGE_TOOL_NAME,
  SkillManageInputJsonSchema,
  createCoreError,
} from "@zcode/contracts";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_SKILL_BODY_CHARS = 32_768;
const MAX_DESCRIPTION_CHARS = 400;
const MAX_EVIDENCE_CHARS = 2_000;

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
  "",
  "Evidence-gated path (spec 164): when the improvement is unverified or this session",
  "cannot get user confirmation, use action=stage — same inputs as create/patch plus an",
  "optional `evidence` (the probe: which task you contrasted, bench verdict, why this",
  "change should help). Staged proposals do NOT go live; list them with action=pending",
  "(same name), and apply or discard with action=approve / action=reject + the entry",
  "`id` (both go through user approval). Verify before you stage when you can: run the",
  "affected tests or the domain bench with and without the change and put the contrast",
  "into evidence.",
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

/** spec 164:pending 暂存库。点前缀目录被技能扫描策略天然跳过
 * (shouldWalkSkillDirectoryEntry 只放行 allowlist 点目录),不会混进技能发现。 */
export function skillPendingDirectory(homeDirectory?: string): string {
  return join(skillManageDirectory(homeDirectory), ".pending");
}

interface PendingSkillEntry {
  id: string;
  name: string;
  action: "create" | "patch";
  description?: string;
  body?: string;
  old_text?: string;
  new_text?: string;
  evidence?: string;
  sessionId?: string;
  timeCreated: number;
}

function pendingFileFor(id: string, homeDirectory?: string): string {
  return join(skillPendingDirectory(homeDirectory), `${id}.json`);
}

function readPendingEntry(id: string, toolCallId: string, homeDirectory?: string): PendingSkillEntry {
  const file = pendingFileFor(id, homeDirectory);
  if (!existsSync(file)) {
    throw fail(
      "skill_manage_pending_missing",
      `Pending entry "${id}" does not exist (already applied or rejected?).`,
      toolCallId,
    );
  }
  return JSON.parse(readFileSync(file, "utf8")) as PendingSkillEntry;
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
  if (parsed.evidence && parsed.evidence.length > MAX_EVIDENCE_CHARS) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      `evidence exceeds ${MAX_EVIDENCE_CHARS} characters`,
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
    return applyCreate(parsed, skillFile, context.toolCallId);
  }

  // ---- spec 164:stage / pending / approve / reject(pending 暂存库)----
  if (parsed.action === "stage") {
    const isPatch = parsed.old_text !== undefined;
    const liveExists = existsSync(skillFile);
    if (isPatch && !liveExists) {
      throw fail(
        "skill_manage_missing",
        `Skill "${parsed.name}" does not exist; stage create semantics (description+body) instead.`,
        context.toolCallId,
      );
    }
    if (!isPatch && liveExists) {
      throw fail(
        "skill_manage_exists",
        `Skill "${parsed.name}" already exists at ${skillFile}; stage patch semantics (old_text+new_text) instead.`,
        context.toolCallId,
      );
    }
    // 同名暂存去重:同技能只保留一条 pending,避免堆积。
    const existing = listPendingEntries(parsed.name).filter((entry) => entry.entry.name === parsed.name);
    if (existing.length > 0) {
      throw fail(
        "skill_manage_pending_exists",
        `A staged proposal for "${parsed.name}" already exists (id=${existing[0]?.entry.id}). Approve or reject it first.`,
        context.toolCallId,
      );
    }
    const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const entry: PendingSkillEntry = {
      id,
      name: parsed.name,
      action: isPatch ? "patch" : "create",
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(parsed.body ? { body: parsed.body } : {}),
      ...(parsed.old_text ? { old_text: parsed.old_text } : {}),
      ...(parsed.new_text !== undefined ? { new_text: parsed.new_text } : {}),
      ...(parsed.evidence ? { evidence: parsed.evidence } : {}),
      ...(context.sessionId ? { sessionId: String(context.sessionId) } : {}),
      timeCreated: Date.now(),
    };
    mkdirSync(skillPendingDirectory(), { recursive: true });
    writeFileSync(pendingFileFor(id), JSON.stringify(entry, null, 2), "utf8");
    return {
      action: "stage",
      id,
      name: parsed.name,
      stagedAs: entry.action,
      note: `Staged (not live). Evidence ${parsed.evidence ? "recorded" : "absent"}. User reviews with action=pending, then action=approve/reject with this id.`,
    };
  }

  if (parsed.action === "pending") {
    const entries = listPendingEntries(parsed.name);
    return {
      action: "pending",
      count: entries.length,
      entries: entries.map(({ entry }) => ({
        id: entry.id,
        name: entry.name,
        kind: entry.action,
        description: entry.description ?? (entry.action === "patch" ? "patch proposal" : undefined),
        hasEvidence: Boolean(entry.evidence),
        timeCreated: entry.timeCreated,
      })),
      note: entries.length === 0 ? "No staged skill proposals." : undefined,
    };
  }

  if (parsed.action === "approve") {
    const entry = readPendingEntry(parsed.id!, context.toolCallId);
    const applied =
      entry.action === "create"
        ? applyCreate(
            { name: entry.name, description: entry.description, body: entry.body },
            skillFileFor(entry.name),
            context.toolCallId,
          )
        : applyPatch(
            { name: entry.name, old_text: entry.old_text, new_text: entry.new_text },
            skillFileFor(entry.name),
            context.toolCallId,
          );
    rmSync(pendingFileFor(parsed.id!), { force: true });
    return {
      action: "approve",
      id: parsed.id!,
      name: entry.name,
      path: applied.path,
      chars: applied.chars,
      ...(entry.evidence ? { evidence: entry.evidence } : {}),
      note: "Applied to the live skill directory.",
    };
  }

  if (parsed.action === "reject") {
    const entry = readPendingEntry(parsed.id!, context.toolCallId);
    rmSync(pendingFileFor(parsed.id!), { force: true });
    return {
      action: "reject",
      id: parsed.id!,
      name: entry.name,
      note: "Staged proposal discarded.",
    };
  }

  // patch(直写)
  return applyPatch(parsed, skillFile, context.toolCallId);
};

function listPendingEntries(nameFilter?: string): Array<{ id: string; entry: PendingSkillEntry }> {
  const dir = skillPendingDirectory();
  if (!existsSync(dir)) return [];
  const entries: Array<{ id: string; entry: PendingSkillEntry }> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(readFileSync(join(dir, file), "utf8")) as PendingSkillEntry;
      if (nameFilter && entry.name !== nameFilter) continue;
      entries.push({ id: entry.id, entry });
    } catch {
      // 半写/损坏条目跳过,不阻塞列表。
    }
  }
  return entries.sort((a, b) => a.entry.timeCreated - b.entry.timeCreated);
}

function applyCreate(
  parsed: { name: string; description?: string; body?: string },
  skillFile: string,
  toolCallId: string,
): { action: "create"; path: string; chars: number } {
  if (existsSync(skillFile)) {
    throw fail(
      "skill_manage_exists",
      `Skill "${parsed.name}" already exists at ${skillFile}. Use action=patch to update it.`,
      toolCallId,
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
  return { action: "create", path: skillFile, chars: body.length };
}

function applyPatch(
  parsed: { name: string; old_text?: string; new_text?: string },
  skillFile: string,
  toolCallId: string,
): { action: "patch"; path: string; chars: number } {
  if (!existsSync(skillFile)) {
    throw fail(
      "skill_manage_missing",
      `Skill "${parsed.name}" does not exist. Use action=create first.`,
      toolCallId,
    );
  }
  const current = readFileSync(skillFile, "utf8");
  const occurrences = current.split(parsed.old_text!).length - 1;
  if (occurrences === 0) {
    throw fail(
      "skill_manage_old_text_missing",
      "old_text not found in the skill body (changed since staging?); Read the file and re-stage.",
      toolCallId,
    );
  }
  if (occurrences > 1) {
    throw fail(
      "skill_manage_old_text_ambiguous",
      `old_text occurs ${occurrences} times; provide a longer, unique substring.`,
      toolCallId,
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
}

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
      action: { type: "string", enum: ["create", "patch", "stage", "pending", "approve", "reject"] },
      path: { type: "string" },
      chars: { type: "integer" },
      note: { type: "string" },
      id: { type: "string" },
      name: { type: "string" },
      stagedAs: { type: "string", enum: ["create", "patch"] },
      count: { type: "integer" },
      entries: { type: "array", items: { type: "object" } },
      evidence: { type: "string" },
    },
    required: ["action"],
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
