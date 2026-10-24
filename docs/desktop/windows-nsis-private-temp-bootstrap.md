# Windows NSIS 私有临时目录启动器与完整性级别治理

## 背景与根因

Windows NSIS 安装器在两类边界条件下会出现四连环安装失败：

1. `NSIS Error: Error writing temporary file. Make sure your temp folder is valid.`
2. `不能打开要写入的文件: D:\ZCode-CE\uninstallerIcon.ico`
3. `Can't modify "ZCode-CE"'s files.` + `复制到: D:\ZCode-CE` + `复制失败` + `ZCode-CE 无法关闭。请手动关闭它，然后单击重试以继续。`
4. `不能打开要写入的文件: D:\ZCode-CE\Uninstall ZCode-CE.exe`

### 根因一：Windows 强制完整性控制（MIC）`Low Mandatory Level` 继承

当工作区目录（如 `D:\ZCode-src`）被沙箱环境打上可继承的 NTFS 强制完整性标签 SACL（`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`，`S-1-16-4096`）时，构建产物 `packages/desktop/dist/*.exe` 及同目录创建的子目录（如 `.zcode-nsis-tmp`）都会继承 `Low Mandatory Level`。

- 根据 Windows 内核 `SeComputeTokenIntegrityLevel` 规则，即使普通桌面用户从 `explorer.exe`（`Medium Mandatory Level`）双击启动一个带有 `Low Mandatory Level` 文件标签的 `.exe`，新进程令牌的完整性级别也会被强制取 `min(ParentTokenIL, FileObjectIL) = Low Mandatory Level`。
- `Low Mandatory Level` 进程受 `No-Write-Up`（`NW`）强制访问控制限制，任何对 `Medium Mandatory Level` 目录（如 `%TEMP%`、`%LOCALAPPDATA%`、`D:\ZCode-CE`）的写入或文件创建都会在内核层直接返回 `STATUS_ACCESS_DENIED (0xC0000022)`，即使 DACL 显示 `Everyone:(F)`。
- 如果启动器优先使用 `exeDir\.zcode-nsis-tmp`（同样继承了 `Low` 标签），内层 `setup.exe` 虽然能解压临时文件到 `Low` 临时目录，但在向 `D:\ZCode-CE`（`Medium`）创建目录或写入 `app-64.7z`、`uninstallerIcon.ico`、`Uninstall ZCode-CE.exe` 时必然全部触发 `STATUS_ACCESS_DENIED`，被 NSIS 误报为「无法关闭 / 复制失败 / 不能打开要写入的文件」。

### 根因二：stub 自解压阶段对系统临时目录的环境干扰

NSIS 安装器在执行任何 `installer.nsh` 脚本之前，就会调用 `GetTempPath` 并在 `%TEMP%\nseXXXX.tmp` 写出插件 DLL。若系统 `%TEMP%` 受安全软件或残留句柄干扰，单层 NSIS stub 会直接报 `Error writing temporary file`。

## 产品规则

1. Windows NSIS 发布产物（`*-win-*.exe`）必须是 **私有 TEMP 启动器 + 内嵌原 NSIS 载荷** 的单文件，且构建及包装阶段必须显式将产物完整性级别重置为 `Medium Mandatory Level`（`S-1-16-8192`，`icacls <exe> /setintegritylevel M`）。
2. 启动器在启动载荷前：
   - 嵌入显式 `app.manifest`（`requestedExecutionLevel level="asInvoker"`），避免 Windows Installer Detection 启发式拦截；
   - 按 `Medium Mandatory Level` 友好的顺序选择候选临时根目录：优先 `%LOCALAPPDATA%\Temp\ZCode-CE-nsis\`、用户/系统 `%TEMP%`、`ProgramData`，仅在前面全部不可写时才回退到安装包同目录 `.zcode-nsis-tmp\`；
   - 每个根目录先 `CreateDirectory` + 写探测文件；失败则记录具体异常并换根目录/重试；
   - 将内嵌 NSIS 载荷写出为工作目录下的 `setup.exe`，并通过 Win32 `SetNamedSecurityInfoW`（`LABEL_SECURITY_INFORMATION`）显式将工作目录与 `setup.exe` 的完整性标签设为 `Medium Mandatory Level`（`S:(ML;;NW;;;ME)`），防止父目录存在可继承 `Low` SACL 时传染给子进程；
   - 将 `TEMP`/`TMP` 指到该目录下的 `tmp\`，原样转发命令行参数（含 `/S`、`/D=`，供静默安装与 electron-updater）；
   - 等待子进程结束后尽量删除工作目录，并以子进程退出码退出；同时清理超过 1 小时的陈旧工作目录。
3. 自动更新仍只下载这一个 exe；`latest.yml` 的 `sha512`/`size` 与 `.blockmap` 必须对 **包装后** 的最终文件计算。
4. 可用 `ZCODE_NSIS_SKIP_PRIVATE_TEMP_WRAP=1` 跳过包装（仅调试原 NSIS）；默认包装。更新启动器时用 `node scripts/wrap-nsis-private-temp.mjs <exe> --force` 重包。

## 状态所有者

- 包装与完整性级别重置：`packages/desktop/scripts/wrap-nsis-private-temp.mjs`
- 启动器源码与运行时完整性标签保护：`packages/desktop/scripts/nsis-private-temp-bootstrap/Program.cs`、`app.manifest`
- 打包接入与 `app.asar` 运行时依赖闭包补齐：`packages/desktop/electron-builder.config.js`、`packages/desktop/scripts/bundle.mjs`

## 安装目录写入与静默进程清理（与私有 TEMP 正交）

私有 TEMP 与 `Medium` 完整性级别解决 stub 自解压及目标目录权限。应用 7z 解压进 `$INSTDIR` 期间，若旧进程或句柄短暂占用：

- `build/installer.nsh` 的 `customCheckAppRunning` / `customInstallExtractStarted` 在解压前使用 `nsExec::Exec`（不向详情框打印进程不存在时的 `taskkill` 标准错误噪音）按进程名及 `$INSTDIR` 路径强杀占用进程，避免「无法关闭 / 复制失败」。
- `patch-nsis-install-section.mjs` 把 `extractAppPackage.nsh`、`uninstallerIcon.ico` 与 `Uninstall ${PRODUCT_FILENAME}.exe` 改为带重试及「`$PLUGINSDIR` → `.new` → `CopyFileW`/`MoveFileExW`」的容错写入。
- `electron-builder.config.js` 的 `REQUIRED_ASAR_RUNTIME_MODULES` 与 `bundle.mjs` 的 `requiredRuntimeModules` 同步覆盖 `@opentelemetry/*` 与 `electron-updater` 闭包根，防止 `electron-builder` 的 `PnpmNodeModulesCollector` 因 `pnpm list --prod` 多父节点去重空子树而漏打 `@opentelemetry/semantic-conventions` 等运行时子依赖。

`ZCODE_EB_SKIP_UNINSTALLER_SIGN=1` 时须提供 `dist/prebuilt-uninstaller.exe`（或 `ZCODE_EB_PREBUILT_UNINSTALLER`）供嵌入。

## 验收

- 包装后的 exe 尾部含魔数 `ZCODE_NSIS_PAYLOAD_V1` 与小端 `int64` 载荷长度，且 `icacls` 检查不存在 `Low Mandatory Level`。
- 在默认 `%TEMP%` 下启动包装后的安装器，能正常安装到 `D:\ZCode-CE`；`$INSTDIR` 下同时有 `ZCode-CE.exe`、`uninstallerIcon.ico` 与 `Uninstall ZCode-CE.exe`，且启动 `D:\ZCode-CE\ZCode-CE.exe` 主进程与渲染窗口正常渲染无异常。
- `pnpm --dir packages/desktop exec node scripts/test-nsis-private-temp-wrap.mjs` 与 `pnpm --dir packages/desktop test -- test/nsis-install-section-patch.test.ts` 通过。
