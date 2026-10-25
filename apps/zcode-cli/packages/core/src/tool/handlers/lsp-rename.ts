import {
  applyLspTextEdits,
  CoreErrorType,
  LSP_RENAME_TOOL_NAME,
  LspRenameInputJsonSchema,
  LspRenameInputSchema,
  createCoreError,
  inferLanguageId,
} from "@zcode/contracts";
import { readFileSync, writeFileSync } from "node:fs";
import { resolveWorkspacePath } from "../path-policy.js";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_LSP_RENAME_MODEL_BYTES = 4096;

const LSP_RENAME_PROVIDER_DESCRIPTION = [
  "# LspRename",
  "",
  "Rename the symbol at the given 1-based line/column across the codebase using",
  "language-server semantics. Unlike text replacement, this renames the actual symbol —",
  "same-name strings in unrelated scopes are untouched and dynamic references are",
  "handled by the language server.",
  "",
  "```json",
  '{"file_path": "/abs/path/src/a.ts", "line": 12, "character": 10, "new_name": "fetchUserById"}',
  "```",
  "",
  "This tool modifies files and requires approval. The result lists every edited file",
  "with its edit count; inspect those with Read if you need to verify the refactor.",
].join("\n");

const lspRenameHandler: ToolHandler = async (input, context) => {
  const parsed = LspRenameInputSchema.parse(input);
  if (!context.lspPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "LspPort is not configured for LspRename",
      {
        context: { toolCallId: context.toolCallId, toolName: LSP_RENAME_TOOL_NAME },
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

  const plan = await context.lspPort.rename({
    languageId,
    filePath,
    line: parsed.line,
    character: parsed.character ?? 1,
    newName: parsed.new_name,
  });
  if (plan.files.length === 0) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `The language server produced no edits for renaming to "${parsed.new_name}".`,
      { context: { code: "lsp_rename_empty_plan" }, recoverable: true },
    );
  }

  // 应用编辑:逐文件读原文→按起点倒序应用→写回。两阶段(先全部算出新内容再落盘)
  // 避免半套改动:任一文件读/算失败时还没有写任何文件。
  const applied: Array<{ path: string; editCount: number }> = [];
  const staged: Array<{ path: string; content: string }> = [];
  try {
    for (const fileEdit of plan.files) {
      const resolved = resolveWorkspacePath({
        inputPath: fileEdit.path,
        operation: "write",
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
      });
      const before = readFileSync(resolved, "utf8");
      const after = applyLspTextEdits(before, fileEdit.edits);
      staged.push({ path: resolved, content: after });
      applied.push({ path: resolved, editCount: fileEdit.edits.length });
    }
  } catch (error) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `LspRename failed while preparing edits: ${error instanceof Error ? error.message : String(error)}`,
      { context: { code: "lsp_rename_prepare_failed" }, recoverable: true },
    );
  }
  for (const file of staged) {
    writeFileSync(file.path, file.content, "utf8");
  }

  return { symbolName: parsed.new_name, files: applied };
};

export const lspRenameToolEntry: ToolEntry = {
  capability: "Rename a symbol across the codebase via language server (modifies files)",
  metadata: {
    shouldDefer: true,
    name: LSP_RENAME_TOOL_NAME,
    searchHint: "rename symbol refactor semantic",
    description: LSP_RENAME_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    // 多文件写入不能与其他工具并发(与 Edit 同款约束)。
    concurrentSafe: false,
    timeoutMs: 30_000,
    maxOutputBytes: MAX_LSP_RENAME_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: lspRenameHandler,
  inputSchema: LspRenameInputJsonSchema,
  outputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      symbolName: { type: "string" },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            editCount: { type: "integer" },
          },
          required: ["path", "editCount"],
        },
      },
    },
    required: ["symbolName", "files"],
    additionalProperties: false,
  },
  runtimeInputSchema: LspRenameInputSchema,
  permission: {
    permission: "lsp.rename.write",
    reason: "LspRename modifies file contents across the workspace",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_LSP_RENAME_MODEL_BYTES,
    maxModelBytes: MAX_LSP_RENAME_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_LSP_RENAME_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: 30_000, maxMs: 30_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "LspRename was cancelled before edits were written",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export function formatLspRenameModelContent(output: unknown): string {
  const parsed = output as { symbolName?: string; files?: Array<{ path: string; editCount: number }> };
  const files = parsed.files ?? [];
  if (files.length === 0) {
    return `No edits produced for renaming to "${parsed.symbolName ?? "?"}".`;
  }
  return files.map((file) => `${file.path} (${file.editCount} edits)`).join("\n");
}
