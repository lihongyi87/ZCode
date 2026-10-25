import {
  CoreErrorType,
  LSP_REFERENCES_TOOL_NAME,
  LspReferencesInputJsonSchema,
  LspReferencesInputSchema,
  createCoreError,
  inferLanguageId,
} from "@zcode/contracts";
import { resolveWorkspacePath } from "../path-policy.js";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_LSP_REFERENCES_MODEL_BYTES = 4096;

const LSP_REFERENCES_PROVIDER_DESCRIPTION = [
  "# LspReferences",
  "",
  "Find all references to the symbol at the given 1-based line/column using",
  "language-server semantics. Unlike text search, this matches actual symbol usages —",
  "not same-name strings in comments or unrelated scopes.",
  "",
  "```json",
  '{"file_path": "/abs/path/src/a.ts", "line": 12, "character": 10}',
  "```",
  "",
  "Read-only. A language without a configured server reports it explicitly — fall",
  "back to Grep for those.",
].join("\n");

const lspReferencesHandler: ToolHandler = async (input, context) => {
  const parsed = LspReferencesInputSchema.parse(input);
  if (!context.lspPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "LspPort is not configured for LspReferences",
      {
        context: { toolCallId: context.toolCallId, toolName: LSP_REFERENCES_TOOL_NAME },
        recoverable: false,
      },
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
  const locations = await context.lspPort.references({
    languageId,
    filePath,
    line: parsed.line,
    character: parsed.character ?? 1,
    includeDeclaration: parsed.include_declaration ?? false,
  });
  return { languageId, locations };
};

export const lspReferencesToolEntry: ToolEntry = {
  capability: "Find all references to a symbol via language server",
  metadata: {
    shouldDefer: true,
    name: LSP_REFERENCES_TOOL_NAME,
    searchHint: "find references symbol usages",
    description: LSP_REFERENCES_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_LSP_REFERENCES_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: lspReferencesHandler,
  inputSchema: LspReferencesInputJsonSchema,
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
  runtimeInputSchema: LspReferencesInputSchema,
  permission: {
    permission: "lsp.references.read",
    reason: "LspReferences queries a language server read-only",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_LSP_REFERENCES_MODEL_BYTES,
    maxModelBytes: MAX_LSP_REFERENCES_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_LSP_REFERENCES_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: 30_000, maxMs: 30_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "LspReferences was cancelled before the language server responded",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
