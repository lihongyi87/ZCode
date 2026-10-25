// ============================================================
// Skill Tool - load reusable local instructions on demand
// ============================================================

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

const SkillCurrentInputSchema = z.object({
  skill: z
    .string()
    .describe("The name of a skill from the available-skills list. Do not guess names."),
  args: z.string().optional().describe("Optional arguments for the skill"),
});

const LegacySkillInputSchema = z.object({
  name: z.string().min(1),
  args: z.string().optional(),
});

export const SkillInputSchema = z
  .union([SkillCurrentInputSchema, LegacySkillInputSchema])
  .transform((input) => ({
    args: input.args,
    skill: "skill" in input ? input.skill : input.name,
  }));

export type SkillInput = z.infer<typeof SkillCurrentInputSchema>;
export type SkillRuntimeInput = z.infer<typeof SkillInputSchema>;

export const SkillInputJsonSchema = toToolJsonSchema(SkillCurrentInputSchema);

export interface SkillStructuredOutput {
  name: string;
  content: string;
  baseDirectory: string;
  truncated: boolean;
}

export type SkillOutput = string | SkillStructuredOutput;

export const SkillStructuredOutputSchema = z
  .object({
    name: z.string(),
    content: z.string(),
    baseDirectory: z.string(),
    truncated: z.boolean(),
  })
  .strict();

export const SkillOutputSchema = z.union([z.string(), SkillStructuredOutputSchema]);

export const SkillOutputJsonSchema = toToolJsonSchema(SkillOutputSchema);

export interface SkillToolCall {
  id: ToolCallId;
  name: "Skill";
  input: SkillInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface SkillToolResult {
  toolCallId: ToolCallId;
  output: SkillOutput;
  traceId: TraceId;
  durationMs: number;
}

// ============================================================
// SkillManage - agent-authored skill persistence (spec 152)
// ============================================================

export const SKILL_MANAGE_TOOL_NAME = "SkillManage";

export const SKILL_MANAGE_INPUT_SCHEMA = z
  .object({
    action: z.enum(["create", "patch"]),
    /** 技能名(= 用户技能目录名);限小写字母/数字/连字符,目录安全。 */
    name: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "skill name must be kebab-case"),
    description: z.string().min(1).max(400).optional(),
    /** create:SKILL.md 正文(markdown;frontmatter 由系统生成)。 */
    body: z.string().min(1).max(32_768).optional(),
    /** patch:old_text 必须在现有正文中恰好出现一次。 */
    old_text: z.string().min(1).optional(),
    new_text: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "create" && (!value.description || !value.body)) {
      ctx.addIssue({ code: "custom", message: "create requires description and body" });
    }
    if (value.action === "patch" && (!value.old_text || value.new_text === undefined)) {
      ctx.addIssue({ code: "custom", message: "patch requires old_text and new_text" });
    }
  });

export type SkillManageInput = z.output<typeof SKILL_MANAGE_INPUT_SCHEMA>;

export const SkillManageInputJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    action: { type: "string", enum: ["create", "patch"] },
    name: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9-]*[a-z0-9]$",
      description: "Skill name (kebab-case); becomes the skill directory name",
    },
    description: {
      type: "string",
      maxLength: 400,
      description: "create only: one-line description used for discovery (when to use it)",
    },
    body: {
      type: "string",
      maxLength: 32768,
      description:
        "create only: markdown body. Use sections in this order: When to Use / Procedure / Pitfalls / Verification. Lessons, not logs — a generalizable rule plus one line of why.",
    },
    old_text: {
      type: "string",
      description: "patch only: exact substring to replace (must occur exactly once)",
    },
    new_text: { type: "string", description: "patch only: replacement text" },
  },
  required: ["action", "name"],
  additionalProperties: false,
} as const;
