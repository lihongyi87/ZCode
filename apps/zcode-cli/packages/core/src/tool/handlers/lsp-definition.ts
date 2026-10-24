import {
  CoreErrorType,
  LSP_DEFINITION_TOOL_NAME,
  LspDefinitionInputJsonSchema,
  LspDefinitionInputSchema,
  createCoreError,
  inferLanguageId,
} from "@zcode/contracts";
import { resolveWorkspacePath } from "../path-policy.js";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_LSP_DEFINITION_MODEL_BYTES = 4096;

const LSP_DEFINITION_PROVIDER_DESCRIPTION = [
  "# LspDefinition",
  "",
  "Find where a symbol is defined using language-server semantics (go-to-definition).",
  "Unlike text search, this resolves the actual definition site of the symbol at the",
  "given 1-based line/column — including cross-file imports.",
  "",
  "```json",
  '{"file_path": "/abs/path/src/a.ts", "line": 12, "character": 10}',
  "```",
  "",
  "Available language ids are listed in the tool result errors; a language without a",
  "configured server reports it explicitly — fall back to Grep for those.",
].join("\n");

const lspDefinitionHandler: ToolHandler = async (input, context) => {
  const parsed = LspDefinitionInputSchema.parse(input);
  if (!context.lspPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "LspPort is not configured for LspDefinition",
      { context: { toolCallId: context.toolCallId, toolName: LSP_DEFINITION_TOOL_NAME }, recoverable: false },
    );
  }
  const filePath = resolveWorkspacePath({
    inputPath: parsed.file_path,
    operation: "read",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  });
  const languageId = inferLanguageId(filePath);
  if (!languageId) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `Cannot infer a language id for ${filePath}; unsupported extension.`,
      { context: { code: "lsp_language_unsupported", filePath }, recoverable: true },
    );
  }
  const locations = await context.lspPort.definition({
    languageId,
    filePath,
    line: parsed.line,
    character: parsed.character ?? 1,
  });
  return { languageId, locations };
};

export const lspDefinitionToolEntry: ToolEntry = {
  capability: "Resolve the definition site of a symbol via language server",
  metadata: {
    shouldDefer: true,
    name: LSP_DEFINITION_TOOL_NAME,
    searchHint: "go to definition symbol resolution",
    description: LSP_DEFINITION_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_LSP_DEFINITION_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: lspDefinitionHandler,
  formatModelContent: formatLspDefinitionModelContent,
  inputSchema: LspDefinitionInputJsonSchema,
  outputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      languageId: { type: "string" },
      locations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            line: { type: "integer" },
            character: { type: "integer" },
          },
          required: ["path", "line", "character"],
        },
      },
    },
    required: ["languageId", "locations"],
    additionalProperties: false,
  },
  runtimeInputSchema: LspDefinitionInputSchema,
  permission: {
    permission: "lsp.definition.read",
    reason: "LspDefinition queries a language server read-only",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_LSP_DEFINITION_MODEL_BYTES,
    maxModelBytes: MAX_LSP_DEFINITION_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_LSP_DEFINITION_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: 30_000, maxMs: 30_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "LspDefinition was cancelled before the language server responded",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatLspDefinitionModelContent(output: unknown): string {
  const parsed = output as { languageId?: string; locations?: Array<{ path: string; line: number; character: number }> };
  const locations = parsed.locations ?? [];
  if (locations.length === 0) {
    return `No definition found (${parsed.languageId ?? "unknown"}).`;
  }
  return locations
    .slice(0, 20)
    .map((location) => `${location.path}:${location.line}:${location.character}`)
    .join("\n");
}
