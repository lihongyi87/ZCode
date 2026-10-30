import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

// 只扫描会以 Node ESM/CJS 身份运行的产物目录：renderer 由 vite 打成浏览器包，
// plugin-sandbox 是 IIFE，它们里面的裸 import 不需要出现在 app.asar 的 node_modules。
const NODE_OUTPUT_DIRS = ["out/main", "out/host", "out/scheduler", "out/preload"];

// 产物以 ESM 为主，但也含 preload 的 .cjs。这里只匹配真正的模块说明符位置，
// 不能用裸的 /\bfrom\s*["']/：压缩产物里的 Array.from("文") 会被误判成包依赖。
const SPECIFIER_PATTERNS = [
  /\bimport\s*(?:[^"'`();]*?\bfrom\s*)?["']([^"'`\s]+)["']/g,
  /\bexport\s+[^"'`();]*?\bfrom\s*["']([^"'`\s]+)["']/g,
  /\bimport\s*\(\s*["']([^"'`\s]+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"'`\s]+)["']\s*\)/g,
];

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "electron",
]);

// npm 包名规范；用来把压缩代码里的碎片匹配挡在外面。
const VALID_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

function packageNameOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function walkJsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      walkJsFiles(fullPath, out);
    } else if (/\.(?:c|m)?js$/u.test(name)) {
      out.push(fullPath);
    }
  }
  return out;
}

/**
 * 扫描 Desktop 的 Node 侧产物，返回其中仍然以裸模块说明符形式存在的包名。
 *
 * 这些包就是 tsup 外置、必须在 app.asar 的 node_modules 里真实存在的运行时依赖；
 * 它们不随 import 内联进产物，漏打只会在已安装应用的启动/使用期才以
 * ERR_MODULE_NOT_FOUND 暴露。
 */
export function collectNodeRuntimeBareImports(desktopPackageRoot) {
  const packages = new Set();
  for (const relativeDir of NODE_OUTPUT_DIRS) {
    const absoluteDir = join(desktopPackageRoot, relativeDir);
    if (!existsSync(absoluteDir)) {
      continue;
    }
    for (const filePath of walkJsFiles(absoluteDir)) {
      const source = readFileSync(filePath, "utf8");
      for (const pattern of SPECIFIER_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(source))) {
          const specifier = match[1];
          if (specifier.startsWith(".") || specifier.startsWith("/")) {
            continue;
          }
          if (NODE_BUILTINS.has(specifier)) {
            continue;
          }
          const packageName = packageNameOf(specifier);
          if (!VALID_PACKAGE_NAME.test(packageName)) {
            continue;
          }
          packages.add(packageName);
        }
      }
    }
  }
  return [...packages].sort();
}
