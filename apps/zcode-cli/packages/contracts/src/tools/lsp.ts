import { z } from "zod";

export const LSP_DEFINITION_TOOL_NAME = "LspDefinition";

/** 扩展名 → languageId(纯函数;core 与 adapters 共用,避免 core→adapters 反向依赖)。 */
const EXTENSION_LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".cts": "typescript",
  ".mts": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
};

export function inferLanguageId(filePath: string): string | undefined {
  const name = filePath.replaceAll("\\", "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return EXTENSION_LANGUAGE_IDS[name.slice(dot)];
}

export const LspDefinitionInputSchema = z.object({
  file_path: z.string().min(1),
  /** 1-based 行。 */
  line: z.number().int().min(1),
  /** 1-based 列;缺省 1(行首)。 */
  character: z.number().int().min(1).optional(),
});

export type LspDefinitionInput = z.infer<typeof LspDefinitionInputSchema>;

export const LspDefinitionOutputSchema = z.object({
  languageId: z.string(),
  locations: z.array(
    z.object({
      path: z.string(),
      line: z.number().int(),
      character: z.number().int(),
      endLine: z.number().int().optional(),
      endCharacter: z.number().int().optional(),
    }),
  ),
});

export type LspDefinitionOutput = z.infer<typeof LspDefinitionOutputSchema>;

/** JSON-Schema(draft 2020-12)面,供 provider 工具声明。 */
export const LspDefinitionInputJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    file_path: { type: "string", description: "Absolute path of the file containing the symbol" },
    line: { type: "integer", minimum: 1, description: "1-based line of the symbol" },
    character: {
      type: "integer",
      minimum: 1,
      description: "1-based column of the symbol (default 1)",
    },
  },
  required: ["file_path", "line"],
  additionalProperties: false,
} as const;
