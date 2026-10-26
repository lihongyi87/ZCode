import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeLspAdapter } from "../src/lsp/index.js";

/**
 * spec 151 验收:假 LSP server 夹具(最小 LSP 协议实现)的集成测试。
 * 覆盖 initialize→didOpen→definition→didClose 全链、1-based 坐标往返、
 * 未配置语言的显式错误。真实 typescript-language-server 手测见 spec 的可选验收项。
 *
 * 夹具把收到的生命周期消息逐条追加到日志文件(process.argv[2]),
 * 测试据此断言 adapter 确实发生了 didOpen(带磁盘全文)与 didClose。
 */

const FIXTURE_SERVER = `
const fs = require("node:fs");
const logPath = process.argv[2];
let buffer = "";

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}

function log(entry) {
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n");
}

// 帧解析与 adapter 同款:Content-Length 头 + JSON 体(adapter 写帧不带尾换行,不能按行读)。
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += String(chunk);
  for (;;) {
    const header = /Content-Length:\\s*(\\d+)/i.exec(buffer);
    const sep = buffer.indexOf("\\r\\n\\r\\n");
    if (!header || sep < 0) return;
    const length = Number(header[1]);
    if (buffer.length < sep + 4 + length) return;
    const message = JSON.parse(buffer.slice(sep + 4, sep + 4 + length));
    buffer = buffer.slice(sep + 4 + length);
    if (!message.id) {
      if (message.method === "textDocument/didOpen") {
        log({ method: "didOpen", uri: message.params.textDocument.uri, text: message.params.textDocument.text });
      }
      if (message.method === "textDocument/didClose") {
        log({ method: "didClose", uri: message.params.textDocument.uri });
      }
      continue;
    }
    if (message.method === "initialize") {
      log({ method: "initialize" });
      send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
      continue;
    }
    if (message.method === "textDocument/definition") {
      // 0-based 位置返回(3,8),验证 adapter 的 1-based 往返。
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: [{
          uri: message.params.textDocument.uri,
          range: { start: { line: 3, character: 8 }, end: { line: 3, character: 20 } },
        }],
      });
      continue;
    }
    if (message.method === "textDocument/references") {
      const uri = message.params.textDocument.uri;
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: [
          { uri, range: { start: { line: 1, character: 6 }, end: { line: 1, character: 10 } } },
          { uri, range: { start: { line: 3, character: 5 }, end: { line: 3, character: 9 } } },
        ],
      });
      continue;
    }
    if (message.method === "textDocument/prepareCallHierarchy") {
      const uri = message.params.textDocument.uri;
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: [{
          name: "doWork",
          kind: 12,
          uri,
          range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
          selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } },
        }],
      });
      continue;
    }
    if (message.method === "callHierarchy/incomingCalls") {
      const uri = message.params.item ? message.params.item.uri : "file:///missing";
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: [{
          from: {
            name: "main",
            kind: 12,
            uri,
            range: { start: { line: 10, character: 0 }, end: { line: 14, character: 1 } },
            selectionRange: { start: { line: 10, character: 9 }, end: { line: 10, character: 13 } },
          },
          fromRanges: [
            { start: { line: 12, character: 2 }, end: { line: 12, character: 8 } },
          ],
        }],
      });
      continue;
    }
    if (message.method === "callHierarchy/outgoingCalls") {
      send({ jsonrpc: "2.0", id: message.id, result: [] });
      continue;
    }
    if (message.method === "textDocument/prepareRename") {
      const uri = message.params.textDocument.uri;
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } },
      });
      continue;
    }
    if (message.method === "textDocument/rename") {
      // 跨两文件的 WorkspaceEdit(changes 形态);newText 回传给断言。
      const other = message.params.newName === "renamed"
        ? "file:///renamed-target.ts"
        : "file:///other-target.ts";
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          changes: {
            [message.params.textDocument.uri]: [
              { range: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } }, newText: message.params.newName },
              { range: { start: { line: 3, character: 5 }, end: { line: 3, character: 11 } }, newText: message.params.newName },
            ],
            [other]: [
              { range: { start: { line: 7, character: 4 }, end: { line: 7, character: 10 } }, newText: message.params.newName },
            ],
          },
        },
      });
      continue;
    }
    send({ jsonrpc: "2.0", id: message.id, result: null });
  }
});
`;

describe("NodeLspAdapter (spec 151)", () => {
  let tempRoot: string;
  let cleanup: Array<() => Promise<void>> = [];

  const setup = async (): Promise<{ fixturePath: string; logPath: string; sourcePath: string }> => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-lsp-adapter-"));
    const fixturePath = join(tempRoot, "fake-lsp-server.cjs");
    const logPath = join(tempRoot, "lsp-log.jsonl");
    const sourcePath = join(tempRoot, "sample.ts");
    await writeFile(fixturePath, FIXTURE_SERVER, "utf8");
    await writeFile(
      sourcePath,
      "const alpha = 1;\nconst beta = 2;\nvoid alpha;\nvoid beta;\n",
      "utf8",
    );
    cleanup.push(async () => rm(tempRoot, { force: true, recursive: true }));
    return { fixturePath, logPath, sourcePath };
  };

  afterEach(async () => {
    for (const task of cleanup.reverse()) await task().catch(() => undefined);
    cleanup = [];
  });

  it(
    "initialize→didOpen→definition→didClose 全链,坐标 1-based 往返",
    async () => {
    const { fixturePath, logPath, sourcePath } = await setup();
    const adapter = createNodeLspAdapter({
      servers: { typescript: { command: process.execPath, args: [fixturePath, logPath] } },
    });
    expect(adapter.availableLanguages()).toEqual(["typescript"]);

    const locations = await adapter.definition({
      languageId: "typescript",
      filePath: sourcePath,
      // 模型给 1-based (4,9);LSP 0-based (3,8);返回应回到 1-based。
      line: 4,
      character: 9,
    });
    expect(locations).toEqual([
      {
        path: sourcePath,
        line: 4,
        character: 9,
        endLine: 4,
        endCharacter: 21,
      },
    ]);

    // definition 已完成 ⇒ didClose 通知也已写出(通知先于请求返回无保证,轮询等它)。
    let entries = "";
    for (let i = 0; i < 50 && !entries.includes("didClose"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      entries = await readFile(logPath, "utf8").catch(() => "");
    }
    const methods = entries
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; uri?: string; text?: string });
    expect(methods.map((entry) => entry.method)).toEqual([
      "initialize",
      "didOpen",
      "didClose",
    ]);
    // didOpen 带磁盘全文(server 视图=磁盘),uri 为 file:// 形态。
    expect(methods[1]?.text).toContain("const beta = 2;");
    expect(methods[1]?.uri).toContain("sample.ts");
    expect(methods[2]?.uri).toBe(methods[1]?.uri);
    },
    // 跨进程 spawn + 握手在 Windows 上偏慢,放宽用例级超时。
    30_000,
  );

  it("references 返回归一化位置列表", async () => {
    const { fixturePath, logPath, sourcePath } = await setup();
    const adapter = createNodeLspAdapter({
      servers: { typescript: { command: process.execPath, args: [fixturePath, logPath] } },
    });
    const locations = await adapter.references({
      languageId: "typescript",
      filePath: sourcePath,
      line: 2,
      character: 7,
    });
    expect(locations).toHaveLength(2);
    // 0-based (1,6) → 1-based (2,7)
    expect(locations[0]).toMatchObject({ path: sourcePath, line: 2, character: 7 });
  });

  it("callHierarchy incoming 返回调用方符号与调用点", async () => {
    const { fixturePath, logPath, sourcePath } = await setup();
    const adapter = createNodeLspAdapter({
      servers: { typescript: { command: process.execPath, args: [fixturePath, logPath] } },
    });
    const calls = await adapter.callHierarchy({
      languageId: "typescript",
      filePath: sourcePath,
      line: 1,
      character: 17,
      direction: "incoming",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.item).toMatchObject({ name: "main", path: sourcePath, line: 11, character: 10 });
    expect(calls[0]?.sites[0]).toMatchObject({ line: 13, character: 3 });
  });

  it("rename 返回跨文件编辑计划(changes 形态归一化)", async () => {
    const { fixturePath, logPath, sourcePath } = await setup();
    const adapter = createNodeLspAdapter({
      servers: { typescript: { command: process.execPath, args: [fixturePath, logPath] } },
    });
    const plan = await adapter.rename({
      languageId: "typescript",
      filePath: sourcePath,
      line: 1,
      character: 17,
      newName: "renamed",
    });
    expect(plan.symbolName).toBe("renamed");
    expect(plan.files).toHaveLength(2);
    const main = plan.files.find((file) => file.path === sourcePath);
    expect(main?.edits).toHaveLength(2);
    expect(main?.edits[0]).toMatchObject({ line: 1, character: 17, endLine: 1, endCharacter: 23, newText: "renamed" });
  });

  it("warmup 预启动 server 并完成握手(批三:消首次查询冷启动)", async () => {
    const { fixturePath, logPath } = await setup();
    const adapter = createNodeLspAdapter({
      servers: { typescript: { command: process.execPath, args: [fixturePath, logPath] } },
    });
    const warmed = await adapter.warmup();
    expect(warmed).toEqual(["typescript"]);
    // 预热后日志里应已有 initialize 记录(握手完成,后续查询不再冷启动)
    const entries = await readFile(logPath, "utf8");
    expect(entries).toContain("initialize");
  });

  it("未配置语言给出显式错误(不静默降级)", async () => {
    const { fixturePath, logPath, sourcePath } = await setup();
    const adapter = createNodeLspAdapter({
      servers: { typescript: { command: process.execPath, args: [fixturePath, logPath] } },
    });
    await expect(
      adapter.definition({
        languageId: "python",
        filePath: sourcePath,
        line: 1,
        character: 1,
      }),
    ).rejects.toThrow(/No LSP server configured for language "python"/);
  });
});
