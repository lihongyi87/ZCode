// ============================================================
// Skill Tool Handler
// ============================================================

import {
  CoreErrorType,
  SkillInputJsonSchema,
  SkillInputSchema,
  SkillOutputJsonSchema,
  SkillOutputSchema,
  createCoreError,
  DYNAMIC_WORKFLOW_SKILL_NAME,
  type SkillReference,
  type SkillRuntimeInput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

/** 技能正文的默认字节上限；超出部分由 adapter 从尾部截掉。 */
export const MAX_SKILL_BYTES = 100_000;

/** references 清单注入上限（140 §P1-6）：条目数与整段字节双上限。 */
export const MAX_SKILL_REFERENCES = 80;
export const MAX_SKILL_REFERENCE_BLOCK_BYTES = 8_192;

/**
 * `dynamic-workflows` 技能的字节上限（docs/dynamic-workflow/authoring.md「The skill」）。
 * 2026-09-30 放宽：这份技能从 09-22 起一直贴在 100 000 上，每加一个功能都得先删掉已有的指导。
 * 判据是请求里的名字，与技能门认的是同一个（workflow-skill-gate.ts）。
 */
export const WORKFLOW_SKILL_MAX_BYTES = 200_000;

/** 结果外壳（`<skill_content>` 标签、标题、Base directory 行）的余量；工具级预算要装得下它。 */
export const SKILL_RESULT_WRAPPER_BYTES = 4_096;

/** 工具级结果预算是静态的，所以取最大的正文上限再加外壳。 */
const MAX_SKILL_RESULT_BYTES = WORKFLOW_SKILL_MAX_BYTES + SKILL_RESULT_WRAPPER_BYTES;

function skillMaxBytes(skill: string): number {
  return skill === DYNAMIC_WORKFLOW_SKILL_NAME ? WORKFLOW_SKILL_MAX_BYTES : MAX_SKILL_BYTES;
}

export const skillHandler: ToolHandler = async (input, context) => {
  const { skill } = SkillInputSchema.parse(input) as SkillRuntimeInput;
  const skillPort = context.skillPort;

  if (!skillPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SkillPort is not configured for Skill tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Skill",
        },
        recoverable: false,
      },
    );
  }

  const loaded = await skillPort.loadSkill(
    {
      name: skill,
      workingDirectory: context.workingDirectory,
      maxBytes: skillMaxBytes(skill),
      trace: {
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: context.parentSpanId,
        sessionId: context.sessionId,
        turnId: context.turnId,
      },
    },
    { signal: context.abortSignal },
  );

  context.recordSkillTelemetryMetadata?.({
    name: loaded.metadata.name,
    ...(loaded.metadata.qualifiedName ? { qualifiedName: loaded.metadata.qualifiedName } : {}),
    ...(loaded.metadata.pluginId ? { pluginId: loaded.metadata.pluginId } : {}),
    source: loaded.metadata.source,
  });

  const referenceBlock = formatSkillReferences(loaded.references);

  return [
    `<skill_content name="${loaded.metadata.name}">`,
    `# Skill: ${loaded.metadata.name}`,
    "",
    expandSkillContextVariables(loaded.content, loaded.baseDirectory),
    "",
    ...(referenceBlock ? [referenceBlock] : []),
    `Base directory for this skill: ${loaded.baseDirectory}`,
    "Relative paths in this skill are relative to this base directory.",
    loaded.truncated ? "[Skill content truncated]" : "",
    "</skill_content>",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
};

/**
 * 把 adapter 枚举的 references 渲染成一段紧凑清单（140 §P1-6）。
 * 只列路径、大小与首标题，让模型知道「有什么、多大」，不复制正文。
 * 超过 80 项或 8 KiB 时截断，并明确告知剩余数量。
 */
export function formatSkillReferences(
  references: readonly SkillReference[] | undefined,
): string | null {
  if (!references || references.length === 0) return null;
  const lines = ["[references]"];
  let bytes = Buffer.byteLength(lines[0]!);
  let shown = 0;
  for (const reference of references) {
    if (shown >= MAX_SKILL_REFERENCES) break;
    const title = reference.title ? ` — # ${reference.title}` : "";
    const line = `- ${reference.relativePath} — ${formatReferenceSize(reference.sizeBytes)}${title}`;
    const nextBytes = bytes + Buffer.byteLength(line) + 1;
    if (nextBytes > MAX_SKILL_REFERENCE_BLOCK_BYTES) break;
    lines.push(line);
    bytes = nextBytes;
    shown += 1;
  }
  if (shown < references.length) {
    lines.push(`另有 ${references.length - shown} 个未列出，用 Glob 查 references/ 目录。`);
  }
  return lines.join("\n");
}

function formatReferenceSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

function expandSkillContextVariables(content: string, baseDirectory: string): string {
  // 只有 Skill 工具加载后才有明确的当前 skill 目录，因此变量替换限定在这里完成。
  return content.replace(/\$\{(CLAUDE_SKILL_DIR|ZCODE_SKILL_DIR)\}/gu, baseDirectory);
}

export const skillToolEntry: ToolEntry = {
  capability: "Load local skill instructions into the current session context",
  metadata: {
    name: "Skill",
    // 描述只写已支持的能力：不含 fork/后台 skill、目录作用域 skill 名。
    description: `Invoke a skill.

A skill is a packaged set of instructions the user or project has set up for a particular kind of task (deploy steps, a review checklist, a repo-specific workflow). Available skills appear in a system-reminder listing with one-line descriptions. When the task at hand is one a listed skill covers, call this tool first — the skill's instructions load into the turn for you to follow in place of your default approach. Users may also ask for one by name (\`/<name>\`, or "slash command"); that's a request to invoke it.

- \`skill\`: exact name from the listing, no leading slash. Plugin skills use \`plugin:skill\`.
- \`args\`: optional arguments to pass through.

Only names from the listing (or that the user typed explicitly) are valid. Built-in CLI commands (\`/help\`, \`/clear\`, …) aren't skills. If a \`<command-name>\` block is already present this turn, the skill is loaded — follow it directly rather than calling again.
`,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_SKILL_RESULT_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: skillHandler,
  inputSchema: SkillInputJsonSchema,
  outputSchema: SkillOutputJsonSchema,
  runtimeInputSchema: SkillInputSchema,
  runtimeOutputSchema: SkillOutputSchema,
  permission: {
    permission: "skill",
    reason: "Skill loads local instructions into session context",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SKILL_RESULT_BYTES,
    maxModelBytes: MAX_SKILL_RESULT_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_SKILL_RESULT_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Skill loading was cancelled before content was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
