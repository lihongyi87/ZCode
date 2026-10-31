import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { resolveSpawnRuntimeOptions } from "./spawn-command.mjs";
import {
  EVIDENCE_TIERS,
  PINNED_UPSTREAM_CLAUSES,
  SHIPPED_STANDARD_TEXTS,
  STANDARD_CLAUSES,
  declaredLicenseText,
  mentionsIdentifier,
  publisherSubjectText,
} from "./third-party-evidence-tiers.mjs";

const exec = promisify(execFile);
export const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
// 原生二进制包按平台分发，每个平台一个包。pnpm 只会安装**当前平台**的那一个，
// 其余平台包虽然出现在 lockfile 的生产依赖图里，但永远不会被安装。
//
// 历史：这条豁免最初只硬编码 @napi-rs/canvas 的 3 个平台，在 linux-x64 上必然失败；
// 后来改成按 @napi-rs/canvas- 前缀动态判断，但判据仍然只认这一个包名前缀。
// 新增 @ubjs/* 这类同样按平台分发的依赖后，同一类"平台包缺失"再次被误报成缺依赖 ——
// 根因是判据绑定在包名上，而问题本质与包名无关。
//
// 现在改为**与包名无关的通用规则**：识别包名结尾的平台标签，与当前平台比对。
//
// 安全边界（必须保持）：**当前平台**的变体绝不免除。否则真正缺了当前平台的原生包
// 也会被静默放过，而这条检查的全部价值就在于拦住那种情况。
const PLATFORM_VARIANT_SUFFIX =
  /(?:^|-)(darwin|linux|win32|android|freebsd|openbsd|netbsd|sunos|aix)-(x64|ia32|arm64|arm|armv7l|armhf|riscv64|loong64|s390x|ppc64le|ppc64|mips64el|universal)(?:-(gnu|musl|msvc|gnueabihf|android|eabi|eabihf))?$/u;

/** 包名结尾的平台标签；不是平台变体包时返回 undefined。 */
export function platformVariantTagOf(name) {
  const match = PLATFORM_VARIANT_SUFFIX.exec(name);
  if (!match) return undefined;
  const [, os, arch, abi] = match;
  return abi === undefined ? `${os}-${arch}` : `${os}-${arch}-${abi}`;
}

/**
 * 当前平台的标签集合（可能不止一个写法）。
 *
 * 无 abi 后缀的 `linux-<arch>` 在 npm 生态里指 glibc（esbuild 等包如此命名），
 * 所以 glibc 环境下它也算当前平台；musl 环境不算 —— 否则会把 musl 包误当成当前平台。
 */
export function currentPlatformVariantTags() {
  const arch = process.arch;
  switch (process.platform) {
    case "darwin":
      return new Set([`darwin-${arch}`]);
    case "win32":
      return new Set([`win32-${arch}-msvc`, `win32-${arch}`]);
    case "linux": {
      const isGnu = process.report?.getReport()?.header?.glibcVersionRuntime !== undefined;
      const tags = new Set([`linux-${arch}-${isGnu ? "gnu" : "musl"}`]);
      if (isGnu) tags.add(`linux-${arch}`);
      return tags;
    }
    default:
      return new Set([`${process.platform}-${arch}`]);
  }
}

/**
 * 该包是否属于**其他平台**的变体（因此允许未安装）。
 *
 * 只在包**缺失**时被调用：当前平台的变体仍会走到报错分支。
 */
export function isForeignPlatformVariant(name, currentTags = currentPlatformVariantTags()) {
  const tag = platformVariantTagOf(name);
  if (tag === undefined) return false;
  return !currentTags.has(tag);
}

const noticeName =
  /(?:^|[._-])(?:licen[sc]es?|copying|notice|copyright|unlicense|third.party|ofl)(?:[._-]|$)/iu;

export async function readPackageNotices(directory) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (["node_modules", ".git", "test", "tests", "fixtures"].includes(entry.name)) continue;
      // Chromium 聚合许可由打包流程经 resources/licenses/electron 单独分发，不进 npm 通知。
      if (entry.isFile() && entry.name === "LICENSES.chromium.html") continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && noticeName.test(entry.name)) {
        const bytes = await readFile(full);
        if (bytes.includes(0) || bytes.length === 0) continue;
        files.push({ member: relative(directory, full).replaceAll("\\", "/"), bytes });
      } else if (entry.isFile() && /^readme(?:\.[^/]*)?$/iu.test(entry.name)) {
        const text = await readFile(full, "utf8");
        const match = /^(?:#{1,6}\s+licen[sc]e[^\n]*\n|licen[sc]e\s*\n[=-]+\n)/imu.exec(text);
        if (match) {
          const section = text.slice(match.index).split(/\n(?=#{1,6}\s)/u)[0];
          files.push({
            member: `${relative(directory, full).replaceAll("\\", "/")} (license section)`,
            bytes: Buffer.from(section),
          });
        }
      }
    }
  }
  await visit(directory);
  return files.sort((a, b) => a.member.localeCompare(b.member, "en"));
}

// 解析锁文件（v9）packages 段的平台约束：`  'name@version':` 下的 `    os/cpu/libc: [..]` 行。
export function readLockfilePlatformConstraints(lockfileText) {
  const constraints = new Map();
  let inPackages = false;
  let key = null;
  for (const line of lockfileText.split(/\r?\n/u)) {
    if (/^\S/u.test(line)) {
      inPackages = line === "packages:";
      key = null;
      continue;
    }
    if (!inPackages) continue;
    const header = /^ {2}(?:'([^']+)'|([^\s'][^:]*)):$/u.exec(line);
    if (header) {
      key = header[1] ?? header[2];
      continue;
    }
    const field = key && /^ {4}(os|cpu|libc): \[(.*)\]$/u.exec(line);
    if (field) {
      const values = field[2]
        .split(",")
        .map((value) => value.trim().replace(/^'(.*)'$/u, "$1"))
        .filter(Boolean);
      constraints.set(key, { ...constraints.get(key), [field[1]]: values });
    }
  }
  return constraints;
}

// 照搬 pnpm package-is-installable 的 checkList，保证与实际安装结果一致（含否定项语义）。
function pnpmCheckList(values, list) {
  if (list.length === 1 && list[0] === "any") return true;
  let match = false;
  let blc = 0;
  for (const value of values) {
    for (const item of list) {
      if (item[0] === "!") {
        if (item.slice(1) === value) return false;
        ++blc;
      } else {
        match = match || item === value;
      }
    }
  }
  return match || blc === list.length;
}

// targets.libc 为 null 表示宿主 libc 未知（非 Linux），pnpm 此时不检查 libc。
export function createInstallablePackageFilter(constraints, targets) {
  return (name, version) => {
    const wanted = constraints.get(`${name}@${version.split("(")[0]}`);
    if (!wanted) return true;
    if (wanted.os && !pnpmCheckList(targets.os, wanted.os)) return false;
    if (wanted.cpu && !pnpmCheckList(targets.cpu, wanted.cpu)) return false;
    if (wanted.libc && targets.libc && !pnpmCheckList(targets.libc, wanted.libc)) return false;
    return true;
  };
}

function hostLibc() {
  if (process.platform !== "linux") return null;
  return process.report?.getReport?.()?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

// 与 pnpm checkPlatform 相同：supportedArchitectures 未配置时只取宿主，`current` 替换为宿主值。
export async function readInstallTargets(root) {
  const { parse } = await import("yaml");
  const workspace = parse(await readFile(join(root, "pnpm-workspace.yaml"), "utf8")) ?? {};
  const supported = workspace.supportedArchitectures ?? {};
  const resolveCurrent = (list, current) =>
    (list ?? ["current"]).map((value) => (value === "current" ? current : value));
  const libc = hostLibc();
  return {
    os: resolveCurrent(supported.os, process.platform),
    cpu: resolveCurrent(supported.cpu, process.arch),
    libc: libc ? resolveCurrent(supported.libc, libc) : null,
  };
}

export function productionPackages(projects, isInstallable = () => true) {
  const own = new Set(projects.map((project) => project.name));
  const required = new Map();
  function dependencies(deps) {
    for (const [alias, info] of Object.entries(deps ?? {})) {
      const name = info.name ?? alias;
      if (!isInstallable(name, info.version)) continue;
      if (!own.has(name) && !name.startsWith("@zcode/") && !info.version.startsWith("link:")) {
        required.set(`${name}@${info.version}`, { name, version: info.version });
      }
      dependencies(info.dependencies);
      dependencies(info.optionalDependencies);
    }
  }
  for (const project of projects) {
    dependencies(project.dependencies);
    dependencies(project.optionalDependencies);
  }
  return required;
}

export function assertProductionGraphs(lockedProjects, installedProjects) {
  const locked = productionPackages(lockedProjects);
  const installed = productionPackages(installedProjects);
  const missing = [...locked].filter(
    ([key, item]) => !installed.has(key) && !isForeignPlatformVariant(item.name),
  );
  const stale = [...installed.keys()].filter((key) => !locked.has(key));
  if (missing.length || stale.length) {
    throw new Error(
      `Installed production graph differs from pnpm-lock.yaml. Run pnpm install --frozen-lockfile.\nMissing: ${missing.map(([key]) => key).join(", ")}\nStale: ${stale.join(", ")}`,
    );
  }
  return locked;
}

/**
 * 枚举 workspace 成员包（读 pnpm-workspace.yaml 的 packages: 段）。
 *
 * 为什么不再用 `pnpm -r ls` 拿项目清单：整仓一次调用会让 pnpm 并行 open 全部
 * node_modules 的 package.json，依赖树长过 Windows 单进程句柄上限时直接 EMFILE
 * （2026-10 实测：串行遍历同树 2670 个文件零错误，故障纯粹来自 pnpm 的并发遍历）。
 * 这里只认两种形态：字面目录与一层 `dir/*` glob —— 与 pnpm-workspace.yaml 的
 * 实际用法一致；出现更复杂的 glob 时显式报错而不是静默漏包。
 */
function workspaceProjectDirectories(root) {
  const text = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const section = [];
  let inPackages = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^[A-Za-z][A-Za-z0-9_-]*:/.test(line)) {
      inPackages = line === "packages:";
      continue;
    }
    if (!inPackages || !line.startsWith("- ")) continue;
    section.push(line.slice(2).replace(/^['"]|['"]$/g, ""));
  }
  const dirs = [];
  for (const entry of section) {
    if (!entry.includes("*")) {
      dirs.push(entry);
      continue;
    }
    const star = entry.indexOf("*");
    if (star !== entry.length - 1 || entry.includes("**")) {
      throw new Error(`pnpm-workspace.yaml 出现不支持的 glob（需要显式适配枚举器）：${entry}`);
    }
    const parent = entry.slice(0, star - 1);
    for (const child of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (!child.isDirectory() || child.name.startsWith(".")) continue;
      const candidate = join(parent, child.name);
      if (existsSync(join(root, candidate, "package.json"))) dirs.push(candidate);
    }
  }
  return dirs.filter((dir) => existsSync(join(root, dir, "package.json")));
}

async function pnpmLsProject(root, dir, lockfileOnly) {
  const { stdout } = await exec(
    "pnpm",
    [
      "--filter",
      `./${dir.replaceAll("\\", "/")}`,
      "ls",
      "--prod",
      "--json",
      "--depth",
      "Infinity",
      ...(lockfileOnly ? ["--lockfile-only"] : []),
    ],
    {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
      ...resolveSpawnRuntimeOptions("pnpm"),
    },
  );
  return JSON.parse(stdout);
}

export async function readWorkspaceProductionGraph(root) {
  root = await realpath(root);
  // 修复①：locked 图必须来自 --lockfile-only（读锁文件而非安装快照）。
  // 修复②（EMFILE）：不再 `pnpm -r ls` 整仓一次调用 —— pnpm 会并行 open 全部
  // package.json，Windows 句柄上限下必然炸。改为按 workspace 成员串行分片调用
  // （每片只走自己的依赖子树，实测单片 depth Infinity 稳定通过），再拼回数组。
  // 输出形状与 `-r ls` 完全一致（每成员一个元素），下游 productionPackages 无感。
  const dirs = workspaceProjectDirectories(root);
  const locked = [];
  const actual = [];
  for (const dir of dirs) {
    locked.push(...(await pnpmLsProject(root, dir, true)));
    actual.push(...(await pnpmLsProject(root, dir, false)));
  }
  const required = assertProductionGraphs(locked, actual);
  return { required, projects: actual };
}

export async function scanInstalledPackages(root, projects) {
  // pnpm hoisted 布局的 ls.path 仍可能指向不存在的 .pnpm 路径；按真实安装目录和精确版本匹配。
  const installed = new Map();
  const visited = new Set();
  async function scanNodeModules(directory) {
    let actual;
    try {
      actual = await realpath(directory);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (visited.has(actual)) return;
    visited.add(actual);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scoped of await readdir(path)) await scanPackage(join(path, scoped));
      } else await scanPackage(path);
    }
  }
  async function scanPackage(directory) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return;
      throw error;
    }
    if (pkg.name && pkg.version) installed.set(`${pkg.name}@${pkg.version}`, { pkg, directory });
    await scanNodeModules(join(directory, "node_modules"));
  }
  for (const project of projects) await scanNodeModules(join(project.path, "node_modules"));
  await scanNodeModules(join(root, "node_modules"));
  await scanNodeModules(join(root, "apps/zcode-cli/node_modules"));
  return installed;
}

export function missingProductionPackages(required, installed) {
  const missing = [...required].filter(([key]) => !installed.has(key)).map(([, item]) => item);
  for (const item of missing) {
    if (!isForeignPlatformVariant(item.name))
      throw new Error(`Missing installed dependency: ${item.name}@${item.version}`);
  }
  return missing;
}

/**
 * 核对"发布者声明档"的四条判据。
 *
 * 输入刻意分成两类，避免**循环论证**：
 * - `publishedNotices`：来自**已发布包目录**的成员（README 许可段、包内 LICENSE），它才代表"发布者已发布"；
 * - `record.file`：我们自己登记的文本，只用来核对判据 (b)，**不**用来证明声明或版权主体存在。
 */
export function assessOverrideMaterials(key, record, { pkg, notices, shippedTexts = "" }) {
  const tier =
    record.evidenceKind ?? (record.acceptedMissingNotice ? "accepted-missing-notice" : "unknown");
  const policy = EVIDENCE_TIERS.get(tier) ?? { blocking: true, guard: null };
  const publishedNotices = notices.filter((notice) => !notice.injected);
  const publishedText = publishedNotices.map((notice) => notice.bytes.toString("utf8")).join("\n");
  const noticeText = record.file
    ? (notices.find((notice) => notice.injected)?.bytes.toString("utf8") ?? "")
    : "";
  const missing = [];
  const declared = declaredLicenseText(record.license);
  const artifactDeclaration = declaredLicenseText(pkg.license) || declaredLicenseText(pkg.licenses);

  if (policy.guard === "pinned-upstream-file") {
    // 这一档问的是："上游确实发布过一份许可文件，且它覆盖了已发布物声明的每一个标识。"
    //
    // 判据 (甲)：上游发布了许可文件 —— 我们登记的快照就是它的逐字节副本。
    // 必须与 refs/source 对上，否则"pinned"二字不成立（拿一个匿名文本当上游文件是自证）。
    const refs = record.refs ?? [];
    if (!record.file || !record.sha256)
      missing.push("(甲) no upstream licence file snapshot is recorded (file + sha256)");
    if (!record.source)
      missing.push("(甲) no provenance source recorded for the upstream licence file");
    if (!refs.length) missing.push("(甲) no upstream version pin recorded (refs is empty)");
    else if (record.source && !refs.some((ref) => record.source.includes(ref)))
      missing.push(
        "(甲) the recorded source does not reference the pinned ref (" +
          refs.join(", ") +
          ") — a snapshot that cannot be tied to the pinned tag is self-assertion",
      );
    if (!(record.reviewEvidence?.upstreamLicenseFiles ?? []).length)
      missing.push(
        "(甲) reviewEvidence.upstreamLicenseFiles does not name the upstream licence file",
      );

    // 判据 (乙)：已发布物声明的每一个标识，其标准条款都在我们分发的内容里。
    //
    // 为什么逐标识而不是只看 record.license：@trycua 的平台包在已发布物里声明的是
    // "MIT AND MPL-2.0"，而 override 一度只记成 "MIT" —— 只看 record 会把 MPL 义务藏掉。
    // 所以这里以已发布物为准，并要求 record 与它一致；不一致就是登记缺陷，不是放行理由。
    const splitIds = (value) =>
      value
        .split(/\s+(?:AND|OR)\s+/iu)
        .map((part) => part.trim())
        .filter(Boolean);
    const artifactIds = splitIds(artifactDeclaration);
    if (!artifactIds.length)
      missing.push("(乙) the published artifact declares no licence identifier");
    const declaredIds = splitIds(declared);
    if (
      artifactIds.length &&
      (declaredIds.length !== artifactIds.length ||
        !declaredIds.every((id) => artifactIds.includes(id)))
    )
      missing.push(
        "(乙) the recorded licence (" +
          (declared || "none") +
          ") does not match the published declaration (" +
          artifactDeclaration +
          ") — fix the record rather than the criterion",
      );
    const comparable = shippedTexts ? noticeText + "\n" + shippedTexts : noticeText;
    for (const id of artifactIds) {
      const clauses = PINNED_UPSTREAM_CLAUSES.get(id);
      if (!clauses) {
        missing.push("(乙) identifier " + id + " has no comparable standard-clause table entry");
        continue;
      }
      for (const clause of clauses)
        if (!comparable.includes(clause))
          missing.push(
            "(乙) neither the snapshot nor the shipped standard texts contain the " +
              id +
              " clause: " +
              clause.slice(0, 56),
          );
    }

    // 判据 (丙)：发布者版权主体可核（只认已发布物与上游文件原文，不认我们写的说明）。
    const subject =
      publisherSubjectText(pkg.author) ||
      publisherSubjectText(pkg.contributors) ||
      publisherSubjectText(pkg.maintainers) ||
      (/\bcopyright\b/iu.test(publishedText) || /\bcopyright\b/iu.test(noticeText)
        ? "licence text copyright line"
        : "");
    if (!subject)
      missing.push(
        "(丙) neither the published artifact nor the upstream licence file carries a copyright subject",
      );

    // 判据 (丁)：出处与内容锁定。
    if (!record.source) missing.push("(丁) no provenance source recorded");
    if (!record.file || !record.sha256)
      missing.push("(丁) no content pin recorded (file + sha256)");
    if (!(record.reviewEvidence?.checkedOn ?? record.reviewEvidence?.result))
      missing.push("(丁) no review evidence recorded (checkedOn / result)");
  }

  if (policy.guard === "published-declaration") {
    // (a) 已发布物里声明了 SPDX 标识
    if (!declared) missing.push("(a) no licence identifier is recorded for this entry");
    else if (!STANDARD_CLAUSES.has(declared))
      missing.push(`(a) identifier ${declared} has no standard-clause table entry`);
    else if (
      !mentionsIdentifier(artifactDeclaration, declared) &&
      !mentionsIdentifier(publishedText, declared)
    )
      missing.push(
        `(a) the published artifact does not declare ${declared} (neither the package.json licence field nor a README/licence-section paragraph)`,
      );

    // (b) 该标识对应标准、未修改的条款文本
    const clauses = STANDARD_CLAUSES.get(declared);
    if (!record.file) missing.push("(b) no notice text file is recorded");
    else if (!clauses)
      missing.push(`(b) identifier ${declared} has no comparable standard clauses`);
    else
      for (const clause of clauses)
        if (!noticeText.includes(clause))
          missing.push(
            `(b) notice text is missing the ${declared} standard clause: ${clause.slice(0, 56)}`,
          );

    // (c) 发布者版权主体已发布（只用已发布物，不用我们自己写的文本）
    const subject =
      publisherSubjectText(pkg.author) ||
      publisherSubjectText(pkg.contributors) ||
      publisherSubjectText(pkg.maintainers) ||
      (/\bcopyright\b/iu.test(publishedText) ? "artifact copyright line" : "");
    if (!subject)
      missing.push(
        "(c) the published artifact carries no publisher copyright subject (package.json author/contributors/maintainers, or a Copyright line in a published licence text)",
      );

    // (d) 出处与版本锁定
    if (!record.source) missing.push("(d) no provenance source recorded");
    if (!record.file || !record.sha256) missing.push("(d) no content pin recorded (file + sha256)");
    if (
      !record.reviewEvidence?.npmArchiveSha256 &&
      !record.reviewEvidence?.sourceRevision &&
      !(record.refs?.length > 0)
    )
      missing.push(
        "(d) no version pin recorded (none of npmArchiveSha256 / sourceRevision / refs)",
      );
  }

  return {
    package: key,
    tier,
    blocking: policy.blocking || missing.length > 0,
    satisfied: missing.length === 0,
    missing,
    evidence: {
      source: record.source ?? null,
      noticeFile: record.file ?? null,
      noticeSha256: record.sha256 ?? null,
      archiveSha256: record.reviewEvidence?.npmArchiveSha256 ?? null,
      declaredLicense: declared || null,
      declarationLocation: [
        artifactDeclaration ? "package.json license field" : null,
        publishedNotices.length
          ? `published notice members: ${publishedNotices.map((n) => n.member).join(", ")}`
          : null,
      ].filter(Boolean),
    },
  };
}

export async function collectNpmNotices(root, overrides) {
  // 随包分发的标准条款全文：判据 (乙) 要能核到"我们确实分发了全文"，
  // 而不是只看上游快照里有没有（@ubjs 的快照只有 192 B 的 Exhibit A）。
  const shippedTexts = (
    await Promise.all(
      Object.values(SHIPPED_STANDARD_TEXTS).map(async (file) => {
        try {
          return await readFile(join(root, file), "utf8");
        } catch (error) {
          if (error.code === "ENOENT")
            throw new Error(`Missing shipped standard licence text: ${file}`);
          throw error;
        }
      }),
    )
  ).join("\n");
  root = await realpath(root);
  const { required, projects } = await readWorkspaceProductionGraph(root);
  // 修复：标识门禁和声明生成必须扫描同一安装集合，避免嵌套版本只进声明、不进门禁。
  const installed = await scanInstalledPackages(root, projects);
  const packages = [];
  const overrideAssessments = [];
  const missing = [];
  const notInstalled = missingProductionPackages(required, installed);
  for (const [key, item] of [...required].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const installedPackage = installed.get(key);
    if (!installedPackage) {
      continue;
    }
    const { pkg, directory } = installedPackage;
    const notices = await readPackageNotices(directory);
    const override = overrides.find((record) => record.package === key);
    if (override?.file) {
      const bytes = await readFile(join(root, override.file));
      if (hashBytes(bytes) !== override.sha256) throw new Error(`Changed upstream notice: ${key}`);
      // injected 标记：这条成员是我们自己登记的快照，不是发布者发布物。
      // 判据 (a)/(c) 必须只用发布物，否则等于拿自己的断言给自己作证。
      notices.push({ member: override.source, bytes, injected: true });
    }
    // README 中仅有 MIT 等标签不能冒充完整许可文件；这种包仍需要版本固定的补充材料。
    if (
      !notices.some(({ member }) => !member.endsWith(" (license section)")) &&
      !override?.acceptedMissingNotice
    )
      missing.push(key);
    // 分档判定：只对登记了 evidenceKind 的条目做，判据核对不通过会被升级为阻断。
    if (override?.evidenceKind)
      overrideAssessments.push(
        assessOverrideMaterials(key, override, { pkg, notices, shippedTexts }),
      );
    packages.push({
      ...item,
      license:
        pkg.license ??
        pkg.licenses?.map((item) => (typeof item === "string" ? item : item.type)).join(" OR ") ??
        override?.license ??
        "(not declared)",
      repository: typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url,
      ...(override?.acceptedMissingNotice
        ? { acceptedMissingNotice: override.acceptedMissingNotice }
        : {}),
      notices,
    });
  }
  if (missing.length) throw new Error(`Missing complete upstream notices:\n${missing.join("\n")}`);
  return {
    packages,
    notInstalled,
    overrideAssessments,
    workspaceManifests: projects.map((project) =>
      relative(root, join(project.path, "package.json")).replaceAll("\\", "/"),
    ),
  };
}
