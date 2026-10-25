import { z } from "zod";

export const LSP_DEFINITION_TOOL_NAME = "LspDefinition";
export const LSP_REFERENCES_TOOL_NAME = "LspReferences";
export const LSP_CALL_HIERARCHY_TOOL_NAME = "LspCallHierarchy";
export const LSP_RENAME_TOOL_NAME = "LspRename";

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

// ── 批二:references / call hierarchy / rename ──

const symbolPositionJsonSchemaProperties = {
  file_path: { type: "string", description: "Absolute path of the file containing the symbol" },
  line: { type: "integer", minimum: 1, description: "1-based line of the symbol" },
  character: {
    type: "integer",
    minimum: 1,
    description: "1-based column of the symbol (default 1)",
  },
} as const;

export const LspReferencesInputSchema = z.object({
  file_path: z.string().min(1),
  line: z.number().int().min(1),
  character: z.number().int().min(1).optional(),
  include_declaration: z.boolean().optional(),
});

export const LspReferencesInputJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    ...symbolPositionJsonSchemaProperties,
    include_declaration: {
      type: "boolean",
      description: "Include the declaration site among the references (default false)",
    },
  },
  required: ["file_path", "line"],
  additionalProperties: false,
} as const;

export const LspCallHierarchyInputSchema = z.object({
  file_path: z.string().min(1),
  line: z.number().int().min(1),
  character: z.number().int().min(1).optional(),
  direction: z.enum(["incoming", "outgoing"]).optional(),
});

export const LspCallHierarchyInputJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    ...symbolPositionJsonSchemaProperties,
    direction: {
      type: "string",
      enum: ["incoming", "outgoing"],
      description: "incoming = who calls this symbol; outgoing = what this symbol calls (default incoming)",
    },
  },
  required: ["file_path", "line"],
  additionalProperties: false,
} as const;

export const LspRenameInputSchema = z.object({
  file_path: z.string().min(1),
  line: z.number().int().min(1),
  character: z.number().int().min(1).optional(),
  new_name: z.string().min(1),
});

export const LspRenameInputJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    ...symbolPositionJsonSchemaProperties,
    new_name: { type: "string", minLength: 1, description: "New symbol name" },
  },
  required: ["file_path", "line", "new_name"],
  additionalProperties: false,
} as const;

/** 单个文件的 LSP 文本编辑应用(纯函数):按起点倒序应用,保持靠前偏移不被前面的替换推移。 */
export function applyLspTextEdits(
  content: string,
  edits: ReadonlyArray<{
    line: number;
    character: number;
    endLine: number;
    endCharacter: number;
    newText: string;
  }>,
): string {
  const lines = content.split("\n");
  const sorted = [...edits].sort((left, right) =>
    left.line !== right.line
      ? right.line - left.line
      : right.character - left.character,
  );
  for (const edit of sorted) {
    const startLineIndex = edit.line - 1;
    const endLineIndex = edit.endLine - 1;
    if (
      startLineIndex < 0 ||
      endLineIndex >= lines.length ||
      startLineIndex > endLineIndex
    ) {
      throw new Error(`LSP edit out of range: lines ${edit.line}-${edit.endLine}`);
    }
    const startLineText = lines[startLineIndex] ?? "";
    const endLineText = lines[endLineIndex] ?? "";
    const before = startLineText.slice(0, edit.character - 1);
    const after = endLineText.slice(edit.endCharacter - 1);
    const replacement = before + edit.newText + after;
    lines.splice(startLineIndex, endLineIndex - startLineIndex + 1, replacement);
  }
  return lines.join("\n");
}
