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
