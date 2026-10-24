#!/usr/bin/env node
/**
 * Wrap a Windows NSIS installer with a private-TEMP bootstrap EXE.
 *
 * Layout of the final artifact:
 *   [bootstrap PE][NSIS payload bytes][magic ASCII][payloadLength int64 LE]
 *
 * Magic: ZCODE_NSIS_PAYLOAD_V1\n
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const requireFromWrap = createRequire(import.meta.url);

export const NSIS_PRIVATE_TEMP_MAGIC = "ZCODE_NSIS_PAYLOAD_V1\n";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const bootstrapSourcePath = resolve(scriptDir, "nsis-private-temp-bootstrap", "Program.cs");

function resolveCscPath() {
  const candidates = [
    process.env.ZCODE_CSC_PATH,
    join(
      process.env.WINDIR || "C:\\Windows",
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe",
    ),
    join(
      process.env.WINDIR || "C:\\Windows",
      "Microsoft.NET",
      "Framework",
      "v4.0.30319",
      "csc.exe",
    ),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "未找到 .NET Framework csc.exe，无法编译 NSIS 私有 TEMP 启动器。可设置 ZCODE_CSC_PATH。",
  );
}

export function compileNsisPrivateTempBootstrap(
  outputExePath,
  { cscPath = resolveCscPath() } = {},
) {
  mkdirSync(dirname(outputExePath), { recursive: true });
  const manifestPath = resolve(scriptDir, "nsis-private-temp-bootstrap", "app.manifest");
  const cscArgs = [
    "/nologo",
    "/target:winexe",
    "/platform:anycpu",
    "/optimize+",
    `/out:${outputExePath}`,
  ];
  if (existsSync(manifestPath)) {
    cscArgs.push(`/win32manifest:${manifestPath}`);
  }
  cscArgs.push(bootstrapSourcePath);
  const result = spawnSync(cscPath, cscArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `编译 NSIS 私有 TEMP 启动器失败 (code=${result.status}):\n${result.stdout || ""}\n${result.stderr || ""}`,
    );
  }
  if (!existsSync(outputExePath)) {
    throw new Error(`csc 未产出启动器: ${outputExePath}`);
  }
  return outputExePath;
}

export function ensureMediumIntegrityLevel(targetPath) {
  if (process.platform !== "win32" || !existsSync(targetPath)) {
    return;
  }
  const icaclsPath = join(process.env.WINDIR || "C:\\Windows", "System32", "icacls.exe");
  if (!existsSync(icaclsPath)) {
    return;
  }
  // Cursor 等 Windows 沙箱环境会给工作区目录打上 Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)。
  // 在该目录下生成的 .exe 会继承 Low Mandatory Level，导致任何进程（包括用户双击 explorer.exe）
  // 启动该安装包时被 Windows 内核 (NtCreateUserProcess) 自动降权为 Low Integrity，
  // 从而无法写入 %TEMP% 或 D:\ZCode-CE 等正常 Medium 完整性目录。
  // 注意：只修改最终 .exe 文件本身的完整性级别为 Medium，不要把 dist 目录改成 Medium，
  // 否则 node_modules 下继承了 Low Mandatory Level 的构建工具（如 app-builder.exe）将无法写入 dist。
  spawnSync(icaclsPath, [resolve(targetPath), "/setintegritylevel", "M"], { stdio: "ignore" });
}

export async function wrapNsisInstallerWithPrivateTemp(installerPath, options = {}) {
  const targetPath = resolve(installerPath);
  if (!existsSync(targetPath)) {
    throw new Error(`NSIS 安装包不存在: ${targetPath}`);
  }

  ensureMediumIntegrityLevel(targetPath);

  const existingTrailer = readNsisPrivateTempTrailer(targetPath);
  if (existingTrailer && !options.force) {
    // 避免对已包装产物再次包装（会嵌套启动器、破坏载荷）。
    return {
      path: targetPath,
      payloadSize: existingTrailer.payloadSize,
      wrappedSize: existingTrailer.totalSize,
      skipped: true,
    };
  }

  const stagingRoot = mkdtempSync(join(tmpdir(), "zcode-nsis-wrap-"));
  const bootstrapPath = join(stagingRoot, "bootstrap.exe");
  const wrappedPath = join(stagingRoot, "wrapped.exe");
  const originalBackupPath = join(stagingRoot, "original.exe");

  try {
    compileNsisPrivateTempBootstrap(bootstrapPath, { cscPath: options.cscPath });
    if (existingTrailer && options.force) {
      // 用新启动器重包：先抽出原 NSIS 载荷，再重新拼接。
      await extractNsisPrivateTempPayload(targetPath, originalBackupPath, existingTrailer);
    } else {
      copyFileSync(targetPath, originalBackupPath);
    }

    const payloadSize = statSync(originalBackupPath).size;
    const magicBuffer = Buffer.from(NSIS_PRIVATE_TEMP_MAGIC, "ascii");
    const lengthBuffer = Buffer.alloc(8);
    lengthBuffer.writeBigInt64LE(BigInt(payloadSize), 0);

    // bootstrap + payload + trailer。流式拼接避免把 170MB+ 安装包整文件读进内存。
    copyFileSync(bootstrapPath, wrappedPath);
    await pipeline(
      createReadStream(originalBackupPath),
      createWriteStream(wrappedPath, { flags: "a" }),
    );
    appendFileSync(wrappedPath, magicBuffer);
    appendFileSync(wrappedPath, lengthBuffer);

    // 原子替换：先写同目录临时文件再 rename，避免半截产物留在 dist。
    const replaceTempPath = `${targetPath}.zcode-wrap-tmp`;
    copyFileSync(wrappedPath, replaceTempPath);
    renameSync(replaceTempPath, targetPath);
    ensureMediumIntegrityLevel(targetPath);

    return {
      path: targetPath,
      payloadSize,
      wrappedSize: statSync(targetPath).size,
    };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export async function extractNsisPrivateTempPayload(wrappedPath, outputPath, trailer = null) {
  const info = trailer || readNsisPrivateTempTrailer(wrappedPath);
  if (!info) {
    throw new Error(`不是私有 TEMP 包装产物，无法解出 NSIS 载荷: ${wrappedPath}`);
  }
  const magicBuffer = Buffer.from(NSIS_PRIVATE_TEMP_MAGIC, "ascii");
  const payloadStart = info.totalSize - magicBuffer.length - 8 - info.payloadSize;
  const output = createWriteStream(outputPath);
  const input = createReadStream(wrappedPath, {
    start: payloadStart,
    end: payloadStart + info.payloadSize - 1,
  });
  await pipeline(input, output);
  return { path: outputPath, payloadSize: info.payloadSize };
}

export function readNsisPrivateTempTrailer(filePath) {
  const fdStat = statSync(filePath);
  const magicBuffer = Buffer.from(NSIS_PRIVATE_TEMP_MAGIC, "ascii");
  const trailerSize = magicBuffer.length + 8;
  if (fdStat.size < trailerSize) {
    return null;
  }
  const buffer = Buffer.alloc(trailerSize);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, buffer, 0, trailerSize, fdStat.size - trailerSize);
  } finally {
    closeSync(fd);
  }
  const magic = buffer.subarray(0, magicBuffer.length).toString("ascii");
  if (magic !== NSIS_PRIVATE_TEMP_MAGIC) {
    return null;
  }
  const payloadSize = Number(buffer.readBigInt64LE(magicBuffer.length));
  return { magic, payloadSize, totalSize: fdStat.size };
}

export function sha512Base64OfFile(filePath) {
  const hash = createHash("sha512");
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    const size = statSync(filePath).size;
    while (position < size) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) {
        break;
      }
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("base64");
}

export function updateLatestYmlForArtifact(latestYmlPath, artifactFileName, artifactPath) {
  if (!existsSync(latestYmlPath)) {
    return false;
  }
  const size = statSync(artifactPath).size;
  const sha512 = sha512Base64OfFile(artifactPath);
  const original = readFileSync(latestYmlPath, "utf8");

  // electron-builder latest.yml 形如：
  // version: ...
  // files:
  //   - url: NAME.exe
  //     sha512: ...
  //     size: ...
  // path: NAME.exe
  // sha512: ...
  const updated = original
    .replace(/sha512:\s*\S+/g, `sha512: ${sha512}`)
    .replace(
      new RegExp(
        `(url:\\s*${escapeRegExp(artifactFileName)}\\s*\\n\\s*sha512:\\s*\\S+\\s*\\n\\s*size:\\s*)\\d+`,
      ),
      `$1${size}`,
    );

  writeFileSync(latestYmlPath, updated, "utf8");
  return true;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function regenerateBlockmap(artifactPath) {
  const blockmapPath = `${artifactPath}.blockmap`;
  rmSync(blockmapPath, { force: true });
  // Prefer electron-builder's app-builder if resolvable; otherwise drop stale blockmap
  // so electron-updater falls back to full download instead of a mismatched delta.
  try {
    const { appBuilderPath } = requireFromWrap("app-builder-bin");
    const result = spawnSync(
      appBuilderPath,
      ["blockmap", "--input", artifactPath, "--output", blockmapPath],
      { encoding: "utf8" },
    );
    if (result.status === 0 && existsSync(blockmapPath)) {
      return blockmapPath;
    }
    console.warn(
      `[wrap-nsis-private-temp] app-builder blockmap failed (code=${result.status}): ${result.stderr || result.stdout || ""}`,
    );
  } catch (error) {
    console.warn(
      `[wrap-nsis-private-temp] app-builder unavailable, remove stale blockmap: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  rmSync(blockmapPath, { force: true });
  return null;
}

async function main(argv) {
  const force = argv.includes("--force");
  const installerPath = argv.find((arg) => !arg.startsWith("-"));
  if (!installerPath) {
    throw new Error("用法: node wrap-nsis-private-temp.mjs <installer.exe> [--force]");
  }
  const result = await wrapNsisInstallerWithPrivateTemp(installerPath, { force });
  const trailer = readNsisPrivateTempTrailer(result.path);
  console.log(
    `[wrap-nsis-private-temp] wrapped path=${result.path} payload=${result.payloadSize} wrapped=${result.wrappedSize} trailer=${JSON.stringify(trailer)}`,
  );

  const distDir = dirname(result.path);
  const latestYmlPath = join(distDir, "latest.yml");
  updateLatestYmlForArtifact(latestYmlPath, basename(result.path), result.path);
  await regenerateBlockmap(result.path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `[wrap-nsis-private-temp] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
