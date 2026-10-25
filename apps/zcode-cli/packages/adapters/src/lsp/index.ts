import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { fileURLToPath as nodeFileURLToPath, pathToFileURL } from "node:url";
import type {
  LspCallHierarchyCall,
  LspCallHierarchyRequest,
  LspDefinitionRequest,
  LspFileEdit,
  LspLocation,
  LspPort,
  LspReferencesRequest,
  LspRenameRequest,
  LspRenameResult,
  LspSymbolPositionRequest,
} from "@zcode/contracts";

/**
 * NodeLspAdapter(spec 151):LSP 语义查询的最小客户端。
 *
 * 形态:按 languageId 懒启动 server 进程(进程生命周期复用,initialize 握手一次);
 * 每请求 didOpen(读盘全文,version=1)→ 请求 → didClose——无增量同步状态,
 * server 视图始终等于磁盘内容(正确性优先,速度代价可接受)。
 * 坐标对外 1-based,与 LSP 0-based 在此往返转换。
 */

const REQUEST_TIMEOUT_MS = 20_000;
const LSP_EOF = "lsp-server-exit";

export interface LspServerConfig {
  command: string;
  args?: readonly string[];
}

export interface NodeLspAdapterOptions {
  servers: Readonly<Record<string, LspServerConfig>>;
}

interface ServerSession {
  process: ChildProcessWithoutNullStreams;
  nextId: number;
  pending: Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >;
  initialized: Promise<void>;
  stderrTail: string;
}

export class NodeLspAdapter implements LspPort {
  private readonly sessions = new Map<string, ServerSession>();

  constructor(private readonly options: NodeLspAdapterOptions) {}

  availableLanguages(): readonly string[] {
    return Object.keys(this.options.servers);
  }

  async references(
    request: LspReferencesRequest & { includeDeclaration?: boolean },
  ): Promise<LspLocation[]> {
    const session = await this.sessionFor(request);
    const content = await readFile(request.filePath, "utf8");
    const uri = pathToFileURL(request.filePath).href;
    this.notify(session, "textDocument/didOpen", {
      textDocument: { uri, languageId: request.languageId, version: 1, text: content },
    });
    try {
      const raw = (await this.request(session, "textDocument/references", {
        textDocument: { uri },
        position: { line: request.line - 1, character: request.character - 1 },
        context: { includeDeclaration: request.includeDeclaration ?? false },
      })) as unknown;
      return normalizeDefinitionResult(raw);
    } finally {
      this.notify(session, "textDocument/didClose", { textDocument: { uri } });
    }
  }

  async callHierarchy(
    request: LspCallHierarchyRequest,
  ): Promise<LspCallHierarchyCall[]> {
    const session = await this.sessionFor(request);
    const content = await readFile(request.filePath, "utf8");
    const uri = pathToFileURL(request.filePath).href;
    this.notify(session, "textDocument/didOpen", {
      textDocument: { uri, languageId: request.languageId, version: 1, text: content },
    });
    try {
      const items = (await this.request(session, "textDocument/prepareCallHierarchy", {
        textDocument: { uri },
        position: { line: request.line - 1, character: request.character - 1 },
      })) as unknown;
      const prepared = Array.isArray(items) ? items : items == null ? [] : [items];
      const item = prepared[0] as
        | { name?: unknown; uri?: unknown; selectionRange?: { start?: pos } }
        | undefined;
      if (!item || typeof item.uri !== "string") {
        return [];
      }
      const method =
        request.direction === "outgoing"
          ? "callHierarchy/outgoingCalls"
          : "callHierarchy/incomingCalls";
      const calls = (await this.request(session, method, {
        item,
      })) as unknown;
      return normalizeCallHierarchyCalls(calls, request.direction);
    } finally {
      this.notify(session, "textDocument/didClose", { textDocument: { uri } });
    }
  }

  async rename(request: LspRenameRequest): Promise<LspRenameResult> {
    const session = await this.sessionFor(request);
    const content = await readFile(request.filePath, "utf8");
    const uri = pathToFileURL(request.filePath).href;
    this.notify(session, "textDocument/didOpen", {
      textDocument: { uri, languageId: request.languageId, version: 1, text: content },
    });
    try {
      const prepared = (await this.request(session, "textDocument/prepareRename", {
        textDocument: { uri },
        position: { line: request.line - 1, character: request.character - 1 },
      })) as unknown;
      // prepareRename 返回 null/undefined = 位置不可改名(如字符串内部),显式报给模型。
      if (prepared == null) {
        throw new Error(
          `The symbol at ${request.filePath}:${request.line}:${request.character} cannot be renamed.`,
        );
      }
      const workspaceEdit = (await this.request(session, "textDocument/rename", {
        textDocument: { uri },
        position: { line: request.line - 1, character: request.character - 1 },
        newName: request.newName,
      })) as unknown;
      return {
        symbolName: request.newName,
        files: normalizeWorkspaceEdit(workspaceEdit),
      };
    } finally {
      this.notify(session, "textDocument/didClose", { textDocument: { uri } });
    }
  }

  private async sessionFor(
    request: LspSymbolPositionRequest,
  ): Promise<ServerSession> {
    const server = this.options.servers[request.languageId];
    if (!server) {
      throw new Error(
        `No LSP server configured for language "${request.languageId}". ` +
          `Configured: ${this.availableLanguages().join(", ") || "(none)"}.`,
      );
    }
    return await this.ensureSession(request.languageId, server);
  }

  async definition(request: LspDefinitionRequest): Promise<LspLocation[]> {
    const session = await this.sessionFor(request);
    const content = await readFile(request.filePath, "utf8");
    const uri = pathToFileURL(request.filePath).href;

    // didOpen(通知)→ definition(请求)→ didClose(通知)。
    this.notify(session, "textDocument/didOpen", {
      textDocument: { uri, languageId: request.languageId, version: 1, text: content },
    });
    try {
      const raw = (await this.request(session, "textDocument/definition", {
        textDocument: { uri },
        position: { line: request.line - 1, character: request.character - 1 },
      })) as unknown;
      return normalizeDefinitionResult(raw);
    } finally {
      this.notify(session, "textDocument/didClose", { textDocument: { uri } });
    }
  }

  private async ensureSession(
    languageId: string,
    server: LspServerConfig,
  ): Promise<ServerSession> {
    const existing = this.sessions.get(languageId);
    if (existing && existing.process.exitCode === null) return existing;
    if (existing) this.sessions.delete(languageId);

    const child = spawn(server.command, [...(server.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    const session: ServerSession = {
      process: child,
      nextId: 1,
      pending: new Map(),
      stderrTail: "",
      initialized: Promise.resolve(),
    };
    child.stderr.setEncoding("utf8");
    createInterface({ input: child.stderr }).on("line", (line) => {
      session.stderrTail = (session.stderrTail + "\n" + line).slice(-2000);
    });
    this.sessions.set(languageId, session);

    // 帧解析:Content-Length 头 + JSON 体;逐消息分发给 pending。
    // 必须按 data 块做帧解析而不是按行读:响应体末尾没有换行,readline 会把
    // 最后一条消息滞留在缓冲里永不分发(实测 initialize 直接超时)。
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const header = /Content-Length:\s*(\d+)/i.exec(buffer);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (!header || headerEnd < 0) return;
        const length = Number(header[1]);
        if (buffer.length < headerEnd + 4 + length) return;
        const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length);
        buffer = buffer.slice(headerEnd + 4 + length);
        this.dispatch(session, body);
      }
    });
    child.on("exit", () => {
      const error = new Error(`${LSP_EOF}: ${session.stderrTail}`);
      for (const pending of session.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      session.pending.clear();
    });

    session.initialized = this.initialize(session);
    await session.initialized;
    return session;
  }

  private async initialize(session: ServerSession): Promise<void> {
    await this.request(session, "initialize", {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
    });
    this.notify(session, "initialized", {});
  }

  /** stdout 可能混有非帧日志行;忽略解析失败的消息而不是崩掉会话。 */
  private dispatch(session: ServerSession, body: string): void {
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return;
    }
    const id = (message as { id?: unknown }).id;
    if (typeof id !== "number") return;
    const pending = session.pending.get(id);
    if (!pending) return;
    session.pending.delete(id);
    clearTimeout(pending.timer);
    const error = (message as { error?: { message?: string } }).error;
    if (error) pending.reject(new Error(error.message ?? "LSP request error"));
    else pending.resolve((message as { result?: unknown }).result);
  }

  private request(session: ServerSession, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
      const id = session.nextId++;
      const timer = setTimeout(() => {
        session.pending.delete(id);
        rejectPromise(new Error(`LSP ${method} timed out (${REQUEST_TIMEOUT_MS}ms)`));
      }, REQUEST_TIMEOUT_MS);
      session.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.write(session, { jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(session: ServerSession, method: string, params: unknown): void {
    this.write(session, { jsonrpc: "2.0", method, params });
  }

  private write(session: ServerSession, message: unknown): void {
    const body = JSON.stringify(message);
    session.process.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
}

/** callHierarchy/incomingCalls: CallHierarchyIncomingCall[] = {from, fromRanges}; outgoing 对称 {to, fromRanges}。 */
function normalizeCallHierarchyCalls(
  raw: unknown,
  direction: "incoming" | "outgoing",
): LspCallHierarchyCall[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const calls: LspCallHierarchyCall[] = [];
  for (const entry of list) {
    const record = entry as {
      from?: CallHierarchyItemLike;
      to?: CallHierarchyItemLike;
      fromRanges?: Array<{ start?: pos; end?: pos }>;
    };
    const item = direction === "outgoing" ? record.to : record.from;
    if (!item || typeof item.uri !== "string") continue;
    const selectionStart = item.selectionRange?.start;
    if (!selectionStart || typeof selectionStart.line !== "number") continue;
    const itemPath = fileUrlToPath(item.uri);
    // fromRanges 是「调用点在 from 文档内的 Range 列表」——没有 uri 字段,
    // 不能复用 normalizeDefinitionResult(它按 Location 形态过滤会全部丢弃)。
    const sites: LspLocation[] = (record.fromRanges ?? []).map((range) => {
      const start = range.start;
      if (!start || typeof start.line !== "number") return undefined;
      return {
        path: itemPath,
        line: start.line + 1,
        character: (start.character ?? 0) + 1,
        ...(range.end && typeof range.end.line === "number"
          ? {
              endLine: range.end.line + 1,
              endCharacter: (range.end.character ?? 0) + 1,
            }
          : {}),
      };
    }).filter((site) => site !== undefined);
    calls.push({
      item: {
        name: typeof item.name === "string" ? item.name : "(unnamed)",
        path: itemPath,
        line: selectionStart.line + 1,
        character: (selectionStart.character ?? 0) + 1,
      },
      sites,
    });
  }
  return calls;
}

interface CallHierarchyItemLike {
  name?: unknown;
  uri?: unknown;
  selectionRange?: { start?: pos };
}

/** WorkspaceEdit 两形态:changes: {uri: TextEdit[]} 与 documentChanges: [{textDocument:{uri}, edits}]。 */
function normalizeWorkspaceEdit(raw: unknown): LspFileEdit[] {
  if (raw == null || typeof raw !== "object") return [];
  const record = raw as {
    changes?: Record<string, unknown>;
    documentChanges?: Array<{
      textDocument?: { uri?: unknown };
      edits?: unknown;
    }>;
  };
  const files: LspFileEdit[] = [];
  const pushFile = (uri: unknown, edits: unknown) => {
    if (typeof uri !== "string" || !Array.isArray(edits) || edits.length === 0) return;
    const normalized = edits
      .map((edit) => {
        const e = edit as { range?: { start?: pos; end?: pos }; newText?: unknown };
        const start = e.range?.start;
        const end = e.range?.end;
        if (
          !start ||
          !end ||
          typeof start.line !== "number" ||
          typeof end.line !== "number" ||
          typeof e.newText !== "string"
        ) {
          return undefined;
        }
        return {
          line: start.line + 1,
          character: (start.character ?? 0) + 1,
          endLine: end.line + 1,
          endCharacter: (end.character ?? 0) + 1,
          newText: e.newText,
        };
      })
      .filter((edit) => edit !== undefined);
    if (normalized.length === 0) return;
    files.push({ path: fileUrlToPath(uri), edits: normalized });
  };
  if (record.changes) {
    for (const [uri, edits] of Object.entries(record.changes)) pushFile(uri, edits);
  }
  for (const change of record.documentChanges ?? []) {
    pushFile(change.textDocument?.uri, change.edits);
  }
  return files;
}

/** LSP definition 结果三形态:单 Location / Location[] / LocationLink[]。 */
function normalizeDefinitionResult(raw: unknown): LspLocation[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const locations: LspLocation[] = [];
  for (const item of list) {
    const record = item as {
      uri?: unknown;
      targetUri?: unknown;
      range?: { start?: pos; end?: pos };
      targetRange?: { start?: pos; end?: pos };
    };
    const uri = typeof record.uri === "string" ? record.uri : record.targetUri;
    if (typeof uri !== "string") continue;
    const range = record.range ?? record.targetRange;
    const start = range?.start;
    if (!start || typeof start.line !== "number") continue;
    locations.push({
      path: fileUrlToPath(uri),
      line: start.line + 1,
      character: (start.character ?? 0) + 1,
      ...(range?.end && typeof range.end.line === "number"
        ? {
            endLine: range.end.line + 1,
            endCharacter: (range.end.character ?? 0) + 1,
          }
        : {}),
    });
  }
  return locations;
}

type pos = { line?: number; character?: number };

function fileUrlToPath(uri: string): string {
  // 必须用官方转换:手写 new URL(uri).pathname 在 Windows 丢盘符处理("/C:/...")。
  try {
    return nodeFileURLToPath(uri);
  } catch {
    return uri;
  }
}

export function createNodeLspAdapter(options: NodeLspAdapterOptions): LspPort {
  return new NodeLspAdapter(options);
}
