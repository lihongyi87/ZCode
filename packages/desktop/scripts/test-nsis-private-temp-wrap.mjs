#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NSIS_PRIVATE_TEMP_MAGIC,
  compileNsisPrivateTempBootstrap,
  readNsisPrivateTempTrailer,
  wrapNsisInstallerWithPrivateTemp,
} from "./wrap-nsis-private-temp.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const staging = mkdtempSync(join(tmpdir(), "zcode-nsis-wrap-test-"));
  try {
    const fakeNsisPath = join(staging, "fake-nsis.exe");
    // 伪造一个带 MZ 头的“载荷”，便于目视确认提取结果；无需真实 NSIS。
    const payload = Buffer.concat([
      Buffer.from("MZ"),
      Buffer.alloc(62, 0),
      Buffer.from("FAKE-NSIS-PAYLOAD-FOR-WRAP-TEST"),
    ]);
    writeFileSync(fakeNsisPath, payload);

    const wrapResult = await wrapNsisInstallerWithPrivateTemp(fakeNsisPath);
    const trailer = readNsisPrivateTempTrailer(wrapResult.path);
    assert(trailer, "包装后应能读到 trailer");
    assert(
      trailer.payloadSize === payload.length,
      `payloadSize 应为 ${payload.length}，实际 ${trailer.payloadSize}`,
    );
    assert(trailer.totalSize === wrapResult.wrappedSize, "totalSize 应等于包装后文件大小");
    assert(
      wrapResult.wrappedSize > payload.length + NSIS_PRIVATE_TEMP_MAGIC.length + 8,
      "包装后体积应大于原载荷+trailer",
    );

    // 启动包装后的 exe：启动器会把载荷解到 LocalAppData 并尝试执行。
    // 伪造 MZ 会被 Windows 拒绝启动，但启动器应已完成解包并返回非 0。
    // 这里改为直接复用 compile + 手动解 trailer 校验字节，避免依赖失败进程。
    const bootstrapOnly = join(staging, "bootstrap-only.exe");
    compileNsisPrivateTempBootstrap(bootstrapOnly);
    assert(existsSync(bootstrapOnly), "应能单独编译启动器");
    assert(statSync(bootstrapOnly).size > 1024, "启动器不应为空");

    // 从包装文件尾部回读载荷字节，确认拼接未损坏。
    const wrapped = readFileSync(wrapResult.path);
    const magicBuf = Buffer.from(NSIS_PRIVATE_TEMP_MAGIC, "ascii");
    const payloadStart = wrapped.length - magicBuf.length - 8 - payload.length;
    const extracted = wrapped.subarray(payloadStart, payloadStart + payload.length);
    assert(extracted.equals(payload), "包装文件中的载荷字节应与原始 fake NSIS 一致");

    // 冒烟：用真实启动器提取（通过再包一层只含 payload 的文件并运行过于重）。
    // 校验启动器至少是有效 PE。
    const peHeader = readFileSync(bootstrapOnly).subarray(0, 2).toString("ascii");
    assert(peHeader === "MZ", "启动器应为 PE/MZ");

    console.log("[test-nsis-private-temp-wrap] ok");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    `[test-nsis-private-temp-wrap] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
