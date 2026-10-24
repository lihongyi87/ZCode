import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PATCH_MARKER,
  UNINSTALLER_COPY_MARKER,
  ICON_COPY_MARKER,
  EXTRACT_APP_PACKAGE_MARKER,
  patchNsisExtractAppPackageFile,
  patchNsisInstallSectionFile,
  patchNsisInstallSectionSource,
  patchNsisInstallerIncludeFile,
  patchNsisInstallerIncludeSource,
  restoreNsisExtractAppPackageFileSync,
  restoreNsisInstallSectionFileSync,
  restoreNsisInstallerIncludeFileSync,
} from "../scripts/patch-nsis-install-section.mjs";

function createInstallSectionFixture(eol = "\r\n") {
  return [
    "InitPluginsDir",
    "",
    "${IfNot} ${Silent}",
    "  SetDetailsPrint none",
    "${endif}",
    "",
    "!insertmacro uninstallOldVersion SHELL_CONTEXT",
    "!insertmacro handleUninstallResult SHELL_CONTEXT",
    "",
    '${if} $installMode == "all"',
    "  !insertmacro uninstallOldVersion HKEY_CURRENT_USER",
    "  !insertmacro handleUninstallResult HKEY_CURRENT_USER",
    "${endIf}",
    "",
    "SetOutPath $INSTDIR",
    "",
    "!insertmacro installApplicationFiles",
    "!insertmacro registryAddInstallInfo",
    "!insertmacro addStartMenuLink $keepShortcuts",
    "!insertmacro addDesktopLink $keepShortcuts",
  ].join(eol);
}

describe("NSIS installSection template patch", () => {
  it("当前真实模板可接入阶段，文件级重复调用幂等且可恢复原字节", async () => {
    const require = createRequire(import.meta.url);
    const source = await readFile(
      join(
        dirname(require.resolve("app-builder-lib/package.json")),
        "templates/nsis/installSection.nsh",
      ),
      "utf8",
    );
    const root = await mkdtemp(join(tmpdir(), "zcode-nsis-template-"));
    const path = join(root, "installSection.nsh");
    try {
      // 只修改隔离副本，不污染开发依赖；真实模板锚点变更不能被手写 fixture 掩盖。
      await writeFile(path, source);
      const first = await patchNsisInstallSectionFile(path);
      expect(first.changed).toBe(true);
      expect(first.originalSource).toBe(source);
      const patched = await readFile(path, "utf8");
      const sequence = [
        "!insertmacro customInstallSectionStarted",
        "!insertmacro customInstallCleanupStarted",
        "!insertmacro uninstallOldVersion SHELL_CONTEXT",
        "!insertmacro uninstallOldVersion HKEY_CURRENT_USER",
        "!insertmacro customInstallCleanupCompleted",
        "!insertmacro customInstallExtractStarted",
        "!insertmacro installApplicationFiles",
        "!insertmacro customInstallExtractCompleted",
        "!insertmacro customInstallShortcutsStarted",
        "!insertmacro addStartMenuLink",
        "!insertmacro customInstallShortcutsCompleted",
      ].map((marker) => patched.indexOf(marker));
      expect(
        sequence.every((index, offset) => index >= 0 && (!offset || index > sequence[offset - 1]!)),
      ).toBe(true);
      expect(await patchNsisInstallSectionFile(path)).toEqual({
        changed: false,
        originalSource: null,
      });
      restoreNsisInstallSectionFileSync({ filePath: path, originalSource: first.originalSource });
      expect(await readFile(path, "utf8")).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("opens file details and inserts the install phases without changing CRLF", () => {
    const source = createInstallSectionFixture();
    const patched = patchNsisInstallSectionSource(source);

    expect(patched).toContain(PATCH_MARKER.replaceAll("\n", "\r\n"));
    expect(patched).toContain("  SetDetailsPrint listonly\r\n");
    expect(patched).toContain("!insertmacro customInstallExtractStarted\r\n");
    expect(patched).toContain("!insertmacro customInstallExtractCompleted\r\n");
    expect(patched).toContain("!insertmacro customInstallShortcutsStarted\r\n");
    expect(patched).toContain("!insertmacro customInstallShortcutsCompleted\r\n");
    expect(patched).not.toContain("SetDetailsPrint none");
    expect(patchNsisInstallSectionSource(patched)).toBe(patched);
  });

  it("模板结构变化时应立即失败，而不是静默生成缺少诊断的安装器", () => {
    expect(() => patchNsisInstallSectionSource("InitPluginsDir\n")).toThrow(
      "electron-builder NSIS 模板缺少预期锚点",
    );
  });

  it("真实 installSection 会把 uninstallerIcon 改为 .new + Rename，且失败不中止", async () => {
    const require = createRequire(import.meta.url);
    const source = await readFile(
      join(
        dirname(require.resolve("app-builder-lib/package.json")),
        "templates/nsis/installSection.nsh",
      ),
      "utf8",
    );
    const patched = patchNsisInstallSectionSource(source);
    expect(patched).toContain(ICON_COPY_MARKER);
    expect(patched).toContain('File /oname=uninstallerIcon.ico.new "${UNINSTALLER_ICON}"');
    expect(patched).toContain('Rename "$INSTDIR\\uninstallerIcon.ico.new"');
    expect(patched).toContain("zcodeCopyUninstallerIconSkip:");
    expect(patched).not.toContain("无法写入 uninstallerIcon.ico");
    expect(patched).not.toContain('File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"');
  });
});

describe("NSIS installer.nsh uninstaller File patch", () => {
  it("当前真实 installer.nsh 可改为 .new + Rename 重试且可恢复", async () => {
    const require = createRequire(import.meta.url);
    const source = await readFile(
      join(
        dirname(require.resolve("app-builder-lib/package.json")),
        "templates/nsis/include/installer.nsh",
      ),
      "utf8",
    );
    const root = await mkdtemp(join(tmpdir(), "zcode-nsis-installer-include-"));
    const path = join(root, "installer.nsh");
    try {
      await writeFile(path, source);
      const first = await patchNsisInstallerIncludeFile(path);
      expect(first.changed).toBe(true);
      const patched = await readFile(path, "utf8");
      expect(patched).toContain(UNINSTALLER_COPY_MARKER);
      expect(patched).toContain("zcode-uninstaller.bin");
      expect(patched).toContain(
        'Rename "$INSTDIR\\zcode-uninstaller.bin" "$INSTDIR\\${UNINSTALL_FILENAME}"',
      );
      expect(patched).toContain("zcodeUninstTryElectronNode:");
      expect(patched).not.toContain(
        'File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"',
      );
      expect(await patchNsisInstallerIncludeFile(path)).toEqual({
        changed: false,
        originalSource: null,
      });
      restoreNsisInstallerIncludeFileSync({
        filePath: path,
        originalSource: first.originalSource,
      });
      expect(await readFile(path, "utf8")).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("缺少 File 锚点时立即失败", () => {
    expect(() =>
      patchNsisInstallerIncludeSource("!macro installApplicationFiles\n!macroend\n"),
    ).toThrow("electron-builder NSIS 模板缺少预期锚点");
  });
});

describe("NSIS extractAppPackage.nsh patch", () => {
  it("当前真实 extractAppPackage.nsh 可注入静默强杀与重试逻辑且可恢复", async () => {
    const require = createRequire(import.meta.url);
    const source = await readFile(
      join(
        dirname(require.resolve("app-builder-lib/package.json")),
        "templates/nsis/include/extractAppPackage.nsh",
      ),
      "utf8",
    );
    const root = await mkdtemp(join(tmpdir(), "zcode-nsis-extract-app-package-"));
    const path = join(root, "extractAppPackage.nsh");
    try {
      await writeFile(path, source);
      const first = await patchNsisExtractAppPackageFile(path);
      expect(first.changed).toBe(true);
      const patched = await readFile(path, "utf8");
      expect(patched).toContain(EXTRACT_APP_PACKAGE_MARKER);
      expect(patched).toContain("ZCodeForceStopInstDirProcesses");
      expect(patched).toContain('nsExec::Exec `taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T`');
      expect(patched).not.toContain("nsExec::ExecToLog");
      expect(await patchNsisExtractAppPackageFile(path)).toEqual({
        changed: false,
        originalSource: null,
      });
      restoreNsisExtractAppPackageFileSync({
        filePath: path,
        originalSource: first.originalSource,
      });
      expect(await readFile(path, "utf8")).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
