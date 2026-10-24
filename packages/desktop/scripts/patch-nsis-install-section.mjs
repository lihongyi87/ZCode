import { readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";

const PATCH_MARKER = "; zcode-installer-details-v1";
const UNINSTALLER_COPY_MARKER = "; zcode-robust-uninstaller-copy-v14";
const UNINSTALLER_COPY_MARKER_PREFIX = "; zcode-robust-uninstaller-copy-v";
const ICON_COPY_MARKER = "; zcode-robust-uninstaller-icon-copy-v11";
const ICON_COPY_MARKER_PREFIX = "; zcode-robust-uninstaller-icon-copy-v";
const EXTRACT_APP_PACKAGE_MARKER = "; zcode-direct-7z-extract-v2";

const ORIGINAL_ICON_BLOCK =
  '!ifdef UNINSTALLER_ICON\n  File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"\n!endif';
const ORIGINAL_UNINSTALLER_FILE = 'File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"';

function optionalMacro(name) {
  return [`!ifmacrodef ${name}`, `  !insertmacro ${name}`, "!endif"].join("\n");
}

function replaceRequired(source, needle, replacement, label) {
  const index = source.indexOf(needle);
  if (index === -1) {
    throw new Error(`electron-builder NSIS 模板缺少预期锚点：${label}`);
  }
  return `${source.slice(0, index)}${replacement}${source.slice(index + needle.length)}`;
}

function normalizeNewlines(source) {
  return source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function restoreEol(source, eol) {
  return eol === "\r\n" ? source.replaceAll("\n", "\r\n") : source;
}

/**
 * 把历史上的图标/卸载器 CopyFiles 补丁还原成上游锚点，便于升到 v2。
 * 匹配从 !ifdef / File 到对应结束标记的整块，避免只替换一行导致重复补丁。
 */
function stripLegacyIconCopyPatch(patched) {
  if (patched.includes(ICON_COPY_MARKER)) {
    return patched;
  }
  if (!patched.includes(ICON_COPY_MARKER_PREFIX)) {
    return patched;
  }
  const start = patched.indexOf("!ifdef UNINSTALLER_ICON");
  if (start === -1) {
    return patched;
  }
  const endMarker = "!endif";
  const end = patched.indexOf(endMarker, start);
  if (end === -1) {
    return patched;
  }
  const block = patched.slice(start, end + endMarker.length);
  if (!block.includes(ICON_COPY_MARKER_PREFIX)) {
    return patched;
  }
  return `${patched.slice(0, start)}${ORIGINAL_ICON_BLOCK}${patched.slice(end + endMarker.length)}`;
}

function stripLegacyUninstallerCopyPatch(patched) {
  if (patched.includes(UNINSTALLER_COPY_MARKER)) {
    return patched;
  }
  const markerIndex = patched.indexOf(UNINSTALLER_COPY_MARKER_PREFIX);
  if (markerIndex === -1) {
    return patched;
  }
  const lineStart = patched.lastIndexOf("\n", markerIndex - 1) + 1;
  const macroEnd = "\n!macroend";
  const macroEndIndex = patched.indexOf(macroEnd, markerIndex);
  if (macroEndIndex === -1) {
    return patched;
  }
  return `${patched.slice(0, lineStart)}${ORIGINAL_UNINSTALLER_FILE}${patched.slice(macroEndIndex)}`;
}

/**
 * NSIS System::Call 中 `""` 会被解析器折成字面量引号，不能包路径变量！
 * 这里直接用 NSIS 内置 `File` 先写 `.new`，再用 `Delete` + `Rename` 原子替换；失败也不阻断主程序安装。
 */
/**
 * NSIS 内置 `WriteUninstaller` 直接生成卸载器，不走 `CopyFiles`（`SHFileOperation`），
 * 并且完全兼容卸载器构建阶段与安装阶段（无需外部 `UNINSTALLER_OUT_FILE` 预构建文件）。
 * 图标同样先写 `.new` 再 `Rename`，失败也不阻断主程序安装。
 */
function buildUninstallerIconCopyBlock() {
  return [
    "!ifdef UNINSTALLER_ICON",
    `  ${ICON_COPY_MARKER}`,
    "  SetOutPath $INSTDIR",
    "  ClearErrors",
    '  SetFileAttributes "$INSTDIR\\uninstallerIcon.ico" NORMAL',
    '  SetFileAttributes "$INSTDIR\\uninstallerIcon.ico.new" NORMAL',
    '  Delete "$INSTDIR\\uninstallerIcon.ico.new"',
    "  ClearErrors",
    '  File /oname=uninstallerIcon.ico.new "${UNINSTALLER_ICON}"',
    "  IfErrors zcodeCopyUninstallerIconSkip",
    '  Delete "$INSTDIR\\uninstallerIcon.ico"',
    "  ClearErrors",
    '  Rename "$INSTDIR\\uninstallerIcon.ico.new" "$INSTDIR\\uninstallerIcon.ico"',
    "  IfErrors zcodeCopyUninstallerIconSkip zcodeCopyUninstallerIconDone",
    "  zcodeCopyUninstallerIconSkip:",
    '    DetailPrint "ZCode: skip locked uninstallerIcon.ico; install continues"',
    '    Delete "$INSTDIR\\uninstallerIcon.ico.new"',
    "    ClearErrors",
    "  zcodeCopyUninstallerIconDone:",
    "!endif",
  ].join("\n");
}

function patchUninstallerIconCopy(patched) {
  patched = stripLegacyIconCopyPatch(patched);
  if (patched.includes(ICON_COPY_MARKER)) {
    return patched;
  }
  if (!patched.includes(ORIGINAL_ICON_BLOCK)) {
    return patched;
  }
  return replaceRequired(
    patched,
    ORIGINAL_ICON_BLOCK,
    buildUninstallerIconCopyBlock(),
    "installSection uninstallerIcon File",
  );
}

export function patchNsisInstallSectionSource(source) {
  const sourceEol = source.includes("\r\n") ? "\r\n" : "\n";
  let patched = normalizeNewlines(source);
  const before = patched;

  if (!patched.includes(PATCH_MARKER)) {
    const detailsAnchor = "${IfNot} ${Silent}\n  SetDetailsPrint none\n${endif}";
    patched = replaceRequired(
      patched,
      detailsAnchor,
      [
        PATCH_MARKER,
        "# 详情区需要同时显示 electron-builder 的 File 条目和项目阶段。",
        "${IfNot} ${Silent}",
        "  SetDetailsPrint listonly",
        "${endif}",
        optionalMacro("customInstallSectionStarted"),
      ].join("\n"),
      "installSection SetDetailsPrint none",
    );

    const cleanupStartAnchor =
      "!insertmacro uninstallOldVersion SHELL_CONTEXT\n!insertmacro handleUninstallResult SHELL_CONTEXT";
    patched = replaceRequired(
      patched,
      cleanupStartAnchor,
      `${optionalMacro("customInstallCleanupStarted")}\n${cleanupStartAnchor}`,
      "installSection SHELL_CONTEXT cleanup",
    );

    const cleanupEndAnchor =
      '${if} $installMode == "all"\n  !insertmacro uninstallOldVersion HKEY_CURRENT_USER\n  !insertmacro handleUninstallResult HKEY_CURRENT_USER\n${endIf}';
    patched = replaceRequired(
      patched,
      cleanupEndAnchor,
      `${cleanupEndAnchor}\n${optionalMacro("customInstallCleanupCompleted")}`,
      "installSection HKEY_CURRENT_USER cleanup",
    );

    const extractAnchor = "!insertmacro installApplicationFiles";
    patched = replaceRequired(
      patched,
      extractAnchor,
      `${optionalMacro("customInstallExtractStarted")}\n${extractAnchor}\n${optionalMacro("customInstallExtractCompleted")}`,
      "installSection application extraction",
    );

    const shortcutsAnchor =
      "!insertmacro addStartMenuLink $keepShortcuts\n!insertmacro addDesktopLink $keepShortcuts";
    patched = replaceRequired(
      patched,
      shortcutsAnchor,
      `${optionalMacro("customInstallShortcutsStarted")}\n${shortcutsAnchor}\n${optionalMacro("customInstallShortcutsCompleted")}`,
      "installSection shortcut installation",
    );
  }

  // uninstallerIcon.ico 是 SetOutPath $INSTDIR 后的第一个 File。本机实测会偶发
  // “不能打开要写入的文件”；先落到 $PLUGINSDIR 再 CopyFiles 重试。可独立于详情补丁增量套用。
  patched = patchUninstallerIconCopy(patched);

  if (patched === before) {
    return source;
  }
  return restoreEol(patched, sourceEol);
}

function buildUninstallerExeCopyBlock() {
  return [
    UNINSTALLER_COPY_MARKER,
    '  !insertmacro ZCodeReportInstallerStage "uninstaller-write-started"',
    '  IfFileExists "$INSTDIR\\${UNINSTALL_FILENAME}" zcodeUninstPresentFrom7z 0',
    "  SetOutPath $INSTDIR",
    "  ClearErrors",
    '  SetFileAttributes "$INSTDIR\\${UNINSTALL_FILENAME}" NORMAL',
    '  Delete "$INSTDIR\\${UNINSTALL_FILENAME}"',
    '  Delete "$INSTDIR\\zcode-uninstaller.bin"',
    "  ClearErrors",
    '  File "/oname=$INSTDIR\\zcode-uninstaller.bin" "${UNINSTALLER_OUT_FILE}"',
    "  IfErrors zcodeUninstInstDirBinFailed",
    '  !insertmacro ZCodeReportInstallerStage "uninstaller-instdir-bin-ok"',
    "  ClearErrors",
    '  Rename "$INSTDIR\\zcode-uninstaller.bin" "$INSTDIR\\${UNINSTALL_FILENAME}"',
    "  IfErrors zcodeUninstInstDirRenameFailed",
    '  IfFileExists "$INSTDIR\\${UNINSTALL_FILENAME}" 0 zcodeUninstInstDirRenameFailed',
    '  !insertmacro ZCodeReportInstallerStage "uninstaller-instdir-rename-ok"',
    "  Goto zcodeWriteUninstallerDone",
    "  zcodeUninstPresentFrom7z:",
    '    !insertmacro ZCodeReportInstallerStage "uninstaller-present-from-7z"',
    "    Goto zcodeWriteUninstallerDone",
    "  zcodeUninstInstDirBinFailed:",
    '    !insertmacro ZCodeReportInstallerStage "uninstaller-instdir-bin-failed"',
    "    Goto zcodeUninstTryPluginsDir",
    "  zcodeUninstInstDirRenameFailed:",
    '    !insertmacro ZCodeReportInstallerStage "uninstaller-instdir-rename-failed"',
    '    Delete "$INSTDIR\\zcode-uninstaller.bin"',
    "  zcodeUninstTryPluginsDir:",
    "    ClearErrors",
    '    File "/oname=$PLUGINSDIR\\zcode-uninstaller.bin" "${UNINSTALLER_OUT_FILE}"',
    "    IfErrors zcodeWriteUninstallerFailed",
    '    !insertmacro ZCodeReportInstallerStage "uninstaller-pluginsdir-bin-ok"',
    "    ClearErrors",
    '    Rename "$PLUGINSDIR\\zcode-uninstaller.bin" "$INSTDIR\\${UNINSTALL_FILENAME}"',
    '    IfFileExists "$INSTDIR\\${UNINSTALL_FILENAME}" 0 zcodeUninstTryElectronNode',
    '    !insertmacro ZCodeReportInstallerStage "uninstaller-pluginsdir-rename-ok"',
    "    Goto zcodeWriteUninstallerDone",
    "  zcodeUninstTryElectronNode:",
    '    !insertmacro ZCodeReportInstallerStage "uninstaller-pluginsdir-rename-failed"',
    '    nsExec::ExecToStack `"$SYSDIR\\cmd.exe" /d /s /c "set ELECTRON_RUN_AS_NODE=1&& "$INSTDIR\\${APP_EXECUTABLE_FILENAME}" -e "require(\'fs\').copyFileSync(process.argv[1],process.argv[2])" "$PLUGINSDIR\\zcode-uninstaller.bin" "$INSTDIR\\${UNINSTALL_FILENAME}""`',
    "    Pop $R8",
    "    Pop $R9",
    '    !insertmacro ZCodeReportInstallerStage "uninstaller-electron-node-rc=$R8"',
    '    IfFileExists "$INSTDIR\\${UNINSTALL_FILENAME}" 0 zcodeWriteUninstallerFailed',
    '    !insertmacro ZCodeReportInstallerStage "uninstaller-electron-node-copy-ok"',
    "    Goto zcodeWriteUninstallerDone",
    "  zcodeWriteUninstallerFailed:",
    "    ClearErrors",
    '    !insertmacro ZCodeReportInstallerStage "uninstaller-write-failed"',
    "  zcodeWriteUninstallerDone:",
    "  ClearErrors",
  ].join("\n");
}

/**
 * installApplicationFiles 末尾把预编译卸载器 File 进 INSTDIR。
 * 本机复现：应用 7z 已完整落盘，唯独 Uninstall ZCode-CE.exe 触发
 * “不能打开要写入的文件”；先写 $PLUGINSDIR，再 .new + Rename 重试。
 */
export function patchNsisInstallerIncludeSource(source) {
  const sourceEol = source.includes("\r\n") ? "\r\n" : "\n";
  let patched = normalizeNewlines(source);
  patched = stripLegacyUninstallerCopyPatch(patched);
  if (patched.includes(UNINSTALLER_COPY_MARKER)) {
    const restored = restoreEol(patched, sourceEol);
    return restored === source ? source : restored;
  }

  patched = replaceRequired(
    patched,
    ORIGINAL_UNINSTALLER_FILE,
    buildUninstallerExeCopyBlock(),
    "installer.nsh UNINSTALL_FILENAME File",
  );

  return restoreEol(patched, sourceEol);
}

/**
 * 上游 extractAppPackage.nsh 先解压到 `$PLUGINSDIR\7z-out`，再用 `CopyFiles /SILENT` 批量拷入 `$OUTDIR`。
 * `CopyFiles` 底层是 Shell `SHFileOperation`：本机环境（安全软件/目录句柄）下会直接置 Errors，
 * 连打 4 次 `Can't modify "ZCode-CE"'s files.` 并弹 `$(appCannotBeClosed)`；而点重试后上游自己也退回
 * 直接 `Nsis7z::Extract "${FILE}"` 到 `$OUTDIR`（所以静默 `/SD IDRETRY` 能过、交互必弹窗）。
 * 这里直接改为在解压前强杀占用并 `Nsis7z::Extract` 到 `$OUTDIR`，省掉双倍临时空间与 `SHFileOperation`。
 */
export function patchNsisExtractAppPackageSource(source) {
  const sourceEol = source.includes("\r\n") ? "\r\n" : "\n";
  let patched = normalizeNewlines(source);
  if (patched.includes(EXTRACT_APP_PACKAGE_MARKER)) {
    return source;
  }

  const startMarker = "!macro extractUsing7za FILE";
  const endMarker = "!macroend";
  const start = patched.indexOf(startMarker);
  if (start === -1) {
    throw new Error("electron-builder NSIS 模板缺少预期锚点：extractUsing7za");
  }
  const end = patched.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error("electron-builder NSIS 模板缺少预期锚点：extractUsing7za !macroend");
  }

  const replacement = [
    "!macro extractUsing7za FILE",
    `  ${EXTRACT_APP_PACKAGE_MARKER}`,
    "  !ifmacrodef ZCodeReportInstallerStage",
    '    !insertmacro ZCodeReportInstallerStage "7z-extract-enter"',
    "  !endif",
    "  !ifmacrodef ZCodeForceStopInstDirProcesses",
    "    !insertmacro ZCodeForceStopInstDirProcesses",
    "  !else",
    '    nsExec::Exec `taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T`',
    "    Pop $R8",
    '    nsExec::Exec `taskkill /F /IM "${UNINSTALL_FILENAME}" /T`',
    "    Pop $R8",
    "  !endif",
    "  ClearErrors",
    '  Nsis7z::Extract "${FILE}"',
    "  !ifmacrodef ZCodeReportInstallerStage",
    '    !insertmacro ZCodeReportInstallerStage "7z-extract-leave"',
    "  !endif",
    "!macroend",
  ].join("\n");

  patched = `${patched.slice(0, start)}${replacement}${patched.slice(end + endMarker.length)}`;
  return restoreEol(patched, sourceEol);
}

export async function patchNsisInstallSectionFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const patched = patchNsisInstallSectionSource(source);
  if (patched === source) {
    return { changed: false, originalSource: null };
  }

  await writeFile(filePath, patched, "utf8");
  return { changed: true, originalSource: source };
}

export async function patchNsisInstallerIncludeFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const patched = patchNsisInstallerIncludeSource(source);
  if (patched === source) {
    return { changed: false, originalSource: null };
  }

  await writeFile(filePath, patched, "utf8");
  return { changed: true, originalSource: source };
}

export async function patchNsisExtractAppPackageFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const patched = patchNsisExtractAppPackageSource(source);
  if (patched === source) {
    return { changed: false, originalSource: null };
  }

  await writeFile(filePath, patched, "utf8");
  return { changed: true, originalSource: source };
}

export function restoreNsisInstallSectionFileSync({ filePath, originalSource }) {
  if (originalSource !== null) {
    writeFileSync(filePath, originalSource, "utf8");
  }
}

export function restoreNsisInstallerIncludeFileSync({ filePath, originalSource }) {
  if (originalSource !== null) {
    writeFileSync(filePath, originalSource, "utf8");
  }
}

export function restoreNsisExtractAppPackageFileSync({ filePath, originalSource }) {
  if (originalSource !== null) {
    writeFileSync(filePath, originalSource, "utf8");
  }
}

export { PATCH_MARKER, UNINSTALLER_COPY_MARKER, ICON_COPY_MARKER, EXTRACT_APP_PACKAGE_MARKER };
