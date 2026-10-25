import {
  CoreErrorType,
  LSP_CALL_HIERARCHY_TOOL_NAME,
  LspCallHierarchyInputJsonSchema,
  LspCallHierarchyInputSchema,
  createCoreError,
  inferLanguageId,
} from "@zcode/contracts";
import { resolveWorkspacePath } from "../path-policy.js";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_LSP_CALL_HIERARCHY_MODEL_BYTES = 4096;

const LSP_CALL_HIERARCHY_PROVIDER_DESCRIPTION = [
  "# LspCallHierarchy",
  "",
  "Explore the call graph around the symbol at the given 1-based line/column using",
  "language-server semantics. direction=incoming lists callers of this symbol;",
  "direction=outgoing lists what this symbol calls. Each entry carries the callee/caller",
  "declaration site plus the actual call-site locations.",
  "",
  "```json",
  '{"file_path": "/abs/path/src/a.ts", "line": 12, "character": 10, "direction": "incoming"}',
  "```",
  "",
  "Read-only. A language without a configured server reports it explicitly.",
].join("\n");

const lspCallHierarchyHandler: ToolHandler = async (input, context) => {
  const parsed = LspCallHierarchyInputSchema.parse(input);
  if (!context.lspPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "LspPort is not configured for LspCallHierarchy",
      {
        context: { toolCallId: context.toolCallId, toolName: LSP_CALL_HIERARCHY_TOOL_NAME },
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
  const calls = await context.lspPort.callHierarchy({
    languageId,
    filePath,
    line: parsed.line,
    character: parsed.character ?? 1,
    direction: parsed.direction ?? "incoming",
  });
  return { languageId, direction: parsed.direction ?? "incoming", calls };
};

export const lspCallHierarchyToolEntry: ToolEntry = {
  capability: "Explore callers/callees of a symbol via language server call hierarchy",
  metadata: {
    shouldDefer: true,
    name: LSP_CALL_HIERARCHY_TOOL_NAME,
    searchHint: "call hierarchy callers callees",
    description: LSP_CALL_HIERARCHY_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_LSP_CALL_HIERARCHY_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: lspCallHierarchyHandler,
  inputSchema: LspCallHierarchyInputJsonSchema,
  outputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      languageId: { type: "string" },
      direction: { type: "string", enum: ["incoming", "outgoing"] },
      calls: {
        type: "array",
        items: {
          type: "object",
          properties: {
            item: {
              type: "object",
              properties: {
                name: { type: "string" },
                path: { type: "string" },
                line: { type: "integer" },
                character: { type: "integer" },
              },
              required: ["name", "path", "line", "character"],
            },
            sites: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  line: { type: "integer" },
                  character: { type: "integer" },
                },
              },
            },
          },
          required: ["item", "sites"],
        },
      },
    },
    required: ["languageId", "direction", "calls"],
    additionalProperties: false,
  },
  runtimeInputSchema: LspCallHierarchyInputSchema,
  permission: {
    permission: "lsp.call_hierarchy.read",
    reason: "LspCallHierarchy queries a language server read-only",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_LSP_CALL_HIERARCHY_MODEL_BYTES,
    maxModelBytes: MAX_LSP_CALL_HIERARCHY_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_LSP_CALL_HIERARCHY_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: 30_000, maxMs: 30_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "LspCallHierarchy was cancelled before the language server responded",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
