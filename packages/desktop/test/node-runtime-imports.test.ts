import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectNodeRuntimeBareImports } from "../scripts/node-runtime-imports.mjs";

function withDesktopRoot(files, run) {
  const rootDir = mkdtempSync(join(tmpdir(), "zcode-node-runtime-imports-"));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = join(rootDir, relativePath);
      mkdirSync(join(absolutePath, ".."), { recursive: true });
      writeFileSync(absolutePath, content, "utf8");
    }
    return run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

describe("desktop node runtime bare imports", () => {
  it("收集 ESM/CJS 产物里仍保留的裸模块包名", () => {
    withDesktopRoot(
      {
        "out/main/index.js": [
          'import armsRum from "@arms/rum-electron";',
          'import { parse } from "yaml";',
          'const ssh = await import("ssh2");',
        ].join("\n"),
        "out/preload/index.cjs": 'const { app } = require("electron");',
      },
      (rootDir) => {
        expect(collectNodeRuntimeBareImports(rootDir)).toEqual([
          "@arms/rum-electron",
          "ssh2",
          "yaml",
        ]);
      },
    );
  });

  it("排除 Node 内置模块、相对路径与 scoped 子路径", () => {
    withDesktopRoot(
      {
        "out/host/index.js": [
          'import { readFileSync } from "node:fs";',
          'import { join } from "path";',
          'import { createRequire } from "module";',
          'import sibling from "./sibling.js";',
          'import scoped from "@scope/pkg/sub/path";',
        ].join("\n"),
      },
      (rootDir) => {
        expect(collectNodeRuntimeBareImports(rootDir)).toEqual(["@scope/pkg"]);
      },
    );
  });

  it("不把压缩产物里的 Array.from(...) 之类误判成包依赖", () => {
    withDesktopRoot(
      {
        // minify 后常见形态：属性名后面紧跟 from(...)，旧正则 /\bfrom\s*["']/ 会误匹配。
        "out/main/chunk-abc.js": 'const a=Array.from("abc");const b=String.fromCharCode(65);',
      },
      (rootDir) => {
        expect(collectNodeRuntimeBareImports(rootDir)).toEqual([]);
      },
    );
  });

  it("只扫 Node 侧产物，忽略 renderer 与 plugin-sandbox", () => {
    withDesktopRoot(
      {
        "out/renderer/assets/index.js": 'import React from "react";',
        "out/plugin-sandbox/gen-ui.js": 'import { z } from "zod";',
        "out/main/index.js": 'import yaml from "yaml";',
      },
      (rootDir) => {
        expect(collectNodeRuntimeBareImports(rootDir)).toEqual(["yaml"]);
      },
    );
  });

  it("产物目录缺失时返回空数组而不是抛错", () => {
    withDesktopRoot({}, (rootDir) => {
      expect(collectNodeRuntimeBareImports(rootDir)).toEqual([]);
    });
  });
});
