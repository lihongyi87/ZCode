import { createCoreError, CoreErrorType } from "@zcode/contracts";
import { isMap, parseDocument } from "yaml";

import { memoryFileRelativePath } from "./memory-file-path.js";

const MEMORY_FRONTMATTER_PATTERN =
  /^(\uFEFF?---(?:\r\n|\n))([\s\S]*?)((?:\r\n|\n)---)(?=(?:\r\n|\n)|$)/u;

export function stampMemoryOriginSessionId(input: {
  content: string;
  filePath: string;
  memoryRoot: string | undefined;
  sessionId: string;
}): string {
  if (
    !input.memoryRoot ||
    !input.filePath.endsWith(".md") ||
    memoryFileRelativePath(input.memoryRoot, input.filePath) === undefined
  ) {
    return input.content;
  }

  const match = MEMORY_FRONTMATTER_PATTERN.exec(input.content);
  if (!match) return input.content;

  const opening = match[1]!;
  const frontmatter = match[2]!;
  const closing = match[3]!;
  const document = parseDocument(frontmatter);
  if (document.errors.length > 0) return input.content;

  try {
    if (document.get("metadata", true) === undefined) document.set("metadata", {});
    const metadata = document.get("metadata", true);
    if (!isMap(metadata)) return input.content;

    const existingOrigin = metadata.get("originSessionId");
    if (typeof existingOrigin === "string" && existingOrigin.length > 0) return input.content;

    // 基线只在缺少 origin 时序列化 frontmatter，并在同一次写入补齐 node_type。
    metadata.delete("node_type");
    metadata.items.unshift(document.createPair("node_type", "memory"));
    metadata.set("originSessionId", input.sessionId);
  } catch {
    // 非 mapping 的 metadata 不做修复；Memory 文件格式仍由 prompt 约束。
    return input.content;
  }

  const lineEnding = opening.endsWith("\r\n") ? "\r\n" : "\n";
  const stampedFrontmatter = document.toString().replace(/\n$/u, "").replace(/\n/gu, lineEnding);
  return `${opening}${stampedFrontmatter}${closing}${input.content.slice(match[0].length)}`;
}

// ── 批三b(spec 149):记忆写租约 ──────────────────────────────────────────
// 记忆 .md 是跨会话共享资产(同 workspace 多窗口、提取子代理、宿主查看器)。
// 写前检查他方新鲜租约:持有人 TTL 内活跃编辑即拒写,模型可稍后重试或换文件。
// 建议性租约:最后写入冲突仍由 expectedRevision(stale_write)兜底;TTL 兜底崩溃
// 残留。租约文件 <file>.lease 不入记忆 manifest(glob 只认 .md)。

const MEMORY_WRITE_LEASE_TTL_MS = 120_000;

/** 租约操作所需的最小 FS 面(结构化:完整 FileSystemPort 天然满足,测试可用假件)。 */
export interface MemoryWriteLeasePort {
  readTextFile(request: { path: string }): Promise<{ content: string }>;
  writeTextFile(request: {
    path: string;
    content: string;
    createParents?: boolean;
    atomic?: boolean;
  }): Promise<unknown>;
  removeFile(request: { path: string }): Promise<unknown>;
}

export interface MemoryWriteLeaseGuard {
  /** 非记忆 .md 路径为空串:acquire/release 全程 no-op。 */
  leasePath: string;
}

function isManagedMemoryMarkdown(filePath: string, memoryRoot: string | undefined): boolean {
  return (
    memoryRoot !== undefined &&
    filePath.endsWith(".md") &&
    memoryFileRelativePath(memoryRoot, filePath) !== undefined
  );
}

/**
 * 跨会话记忆写保护:他方新鲜租约在场则抛 memory_write_lease_conflict(可恢复),
 * 否则写入本会话租约。同会话重入(崩溃残留)不拒。
 */
export async function acquireMemoryWriteLease(input: {
  fileSystemPort: MemoryWriteLeasePort;
  filePath: string;
  memoryRoot: string | undefined;
  sessionId: string;
}): Promise<MemoryWriteLeaseGuard> {
  if (!isManagedMemoryMarkdown(input.filePath, input.memoryRoot)) {
    return { leasePath: "" };
  }
  const leasePath = `${input.filePath}.lease`;
  let holder: { sessionId: string; acquiredAt: number } | undefined;
  try {
    const parsed = JSON.parse(
      (await input.fileSystemPort.readTextFile({ path: leasePath })).content,
    ) as { sessionId?: unknown; acquiredAt?: unknown };
    if (typeof parsed.sessionId === "string" && typeof parsed.acquiredAt === "number") {
      holder = { sessionId: parsed.sessionId, acquiredAt: parsed.acquiredAt };
    }
  } catch {
    holder = undefined; // 租约缺席/损坏=无租约
  }
  if (
    holder &&
    holder.sessionId !== input.sessionId &&
    Date.now() - holder.acquiredAt < MEMORY_WRITE_LEASE_TTL_MS
  ) {
    const heldSeconds = Math.max(0, Math.round((Date.now() - holder.acquiredAt) / 1000));
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `Memory file is locked by another session (lease held ${heldSeconds}s ago). ` +
        "Retry later, or edit a different memory file.",
      {
        context: {
          code: "memory_write_lease_conflict",
          filePath: input.filePath,
          holderSessionId: holder.sessionId,
        },
        recoverable: true,
      },
    );
  }
  await input.fileSystemPort.writeTextFile({
    path: leasePath,
    content: JSON.stringify({ version: 1, sessionId: input.sessionId, acquiredAt: Date.now() }),
    createParents: true,
    atomic: true,
  });
  return { leasePath };
}

/** 写后释放;释放失败(被覆盖/FS 抖动)靠 TTL 过期兜底,不影响写结果。 */
export async function releaseMemoryWriteLease(input: {
  fileSystemPort: MemoryWriteLeasePort;
  guard: MemoryWriteLeaseGuard;
}): Promise<void> {
  if (!input.guard.leasePath) return;
  try {
    await input.fileSystemPort.removeFile({ path: input.guard.leasePath });
  } catch {
    // TTL 兜底,静默。
  }
}
