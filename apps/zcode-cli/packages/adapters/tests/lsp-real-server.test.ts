import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeLspAdapter } from "../src/lsp/index.js";

/**
 * 真 typescript-language-server 烟雾测试(spec 151 可选验收项)。
 *
 * 门控:设 ZCODE_LSP_SERVER_BIN 指向 typescript-language-server 的 cli.js 才运行
 * (例:D:/.../.lsp-real-server/node_modules/typescript-language-server/lib/cli.mjs);
 * 未设则跳过——CI/无网环境不阻塞,但每次发版前建议本机跑一次。
 *
 * 与假夹具用例的区别:这是**真 tsserver**——tsconfig 项目解析、跨文件
 * definition/references/rename 都是真实的语义结果。
 */

const SERVER_BIN = process.env.ZCODE_LSP_SERVER_BIN;
const d = SERVER_BIN ? describe : describe.skip;

const A_TS = `export function doWork(count: number): number {
  return count * 2;
}
`;

const B_TS = `import { doWork } from "./a";

export function main(): number {
  return doWork(21);
}
`;

/**
 * tsserver 冷启动会异步加载项目:首个请求可能拿到不完整结果(definition 落在
 * import 声明、references 只见单文件)。真实 IDE 等项目就绪信号;我们的最小适配层
 * 没有该信号,以「有界轮询」表达同样的等待——这也是真实使用里的预期用法
 * (模型对不完整结果自然重试)。
 */
async function pollUntil<T>(
  query: () => Promise<T>,
  ready: (result: T) => boolean,
  { attempts = 20, delayMs = 500 }: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  let last: T = await query();
  for (let index = 1; index < attempts && !ready(last); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    last = await query();
  }
  return last;
}

d("NodeLspAdapter × 真 typescript-language-server", () => {
  let tempRoot: string;
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const task of cleanup.reverse()) await task().catch(() => undefined);
    cleanup = [];
  });

  const setup = async (): Promise<{
    adapter: ReturnType<typeof createNodeLspAdapter>;
    aPath: string;
    bPath: string;
  }> => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-lsp-real-"));
    const aPath = join(tempRoot, "a.ts");
    const bPath = join(tempRoot, "b.ts");
    await writeFile(aPath, A_TS, "utf8");
    await writeFile(bPath, B_TS, "utf8");
    await writeFile(
      join(tempRoot, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, module: "commonjs" }, include: ["*.ts"] }),
      "utf8",
    );
    const adapter = createNodeLspAdapter({
      servers: {
        typescript: {
          command: process.execPath,
          args: [SERVER_BIN as string, "--stdio"],
        },
      },
      rootUri: pathToFileURL(tempRoot).href,
    });
    cleanup.push(async () => rm(tempRoot, { force: true, recursive: true }));
    return { adapter, aPath, bPath };
  };

  it(
    "definition 跨文件解析到声明处",
    async () => {
      const { adapter, aPath, bPath } = await setup();
      // b.ts 第 4 行的 doWork(21) 调用点(1-based character 10 起,"d")。
      const locations = await pollUntil(
        () =>
          adapter.definition({
            languageId: "typescript",
            filePath: bPath,
            line: 4,
            character: 10,
          }),
        (result) => result.some((location) => location.path === aPath),
      );
      expect(locations.length).toBeGreaterThan(0);
      expect(locations[0]?.path).toBe(aPath);
      expect(locations[0]?.line).toBe(1);
    },
    60_000,
  );

  it(
    "references 覆盖声明与跨文件调用",
    async () => {
      const { adapter, aPath, bPath } = await setup();
      // a.ts 第 1 行 doWork 声明处(character 17 起)。
      const locations = await pollUntil(
        () =>
          adapter.references({
            languageId: "typescript",
            filePath: aPath,
            line: 1,
            character: 17,
            includeDeclaration: true,
          }),
        (result) => {
          const paths = result.map((location) => location.path);
          return paths.includes(aPath) && paths.includes(bPath);
        },
      );
      const paths = locations.map((location) => location.path);
      expect(paths).toContain(aPath);
      expect(paths).toContain(bPath);
    },
    60_000,
  );

  it(
    "rename 返回跨文件编辑计划",
    async () => {
      const { adapter, aPath, bPath } = await setup();
      const plan = await pollUntil(
        () =>
          adapter.rename({
            languageId: "typescript",
            filePath: aPath,
            line: 1,
            character: 17,
            newName: "doWorkRenamed",
          }),
        (result) => result.files.length >= 2,
      );
      expect(plan.files.length).toBeGreaterThanOrEqual(2);
      const paths = plan.files.map((file) => file.path);
      expect(paths).toContain(aPath);
      expect(paths).toContain(bPath);
    },
    60_000,
  );

  it(
    "callHierarchy incoming 找到调用方",
    async () => {
      const { adapter, aPath, bPath } = await setup();
      const calls = await adapter.callHierarchy({
        languageId: "typescript",
        filePath: aPath,
        line: 1,
        character: 17,
        direction: "incoming",
      });
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]?.item.path).toBe(bPath);
    },
    60_000,
  );
});
