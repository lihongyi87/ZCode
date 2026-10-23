import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSessionId,
  createTraceId,
  type FileSystemRevision,
  type ReadFileStateMap,
} from "@zcode/contracts";

import {
  acquireMemoryWriteLease,
  recordMemoryWriteHistory,
  releaseMemoryWriteLease,
  stampMemoryOriginSessionId,
} from "../src/memory/origin-session.js";
import { editHandler } from "../src/tool/handlers/edit.js";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { MemoryFileSystem } from "./memory-test-utils.js";

const MEMORY_ROOT = "/storage/memories/projects/project-0123456789abcdef/memory";

function createLeaseFs(existing: Record<string, string> = {}) {
  const files = new Map(Object.entries(existing));
  const fs = new MemoryFileSystem(Object.fromEntries(files));
  // MemoryFileSystem 的文件账本用 Record;这里补一个可直接断言删除的视图。
  const removed: string[] = [];
  const originalRemove = fs.removeFile.bind(fs);
  fs.removeFile = async (request: { path: string }) => {
    removed.push(request.path);
    return originalRemove(request);
  };
  return { fs, removed };
}

describe("Memory file metadata", () => {
  it("adds the fixed node type and creating session to standard Memory frontmatter", () => {
    const content = [
      "---",
      "name: feedback-agent-sdk-naming",
      'description: "Keep internal naming local"',
      "metadata:",
      "  type: feedback",
      "---",
      "",
      "Use local semantic names for internal code.",
    ].join("\n");

    expect(
      stampMemoryOriginSessionId({
        content,
        filePath: `${MEMORY_ROOT}/feedback-agent-sdk-naming.md`,
        memoryRoot: MEMORY_ROOT,
        sessionId: "sess_origin",
      }),
    ).toBe(
      [
        "---",
        "name: feedback-agent-sdk-naming",
        'description: "Keep internal naming local"',
        "metadata:",
        "  node_type: memory",
        "  type: feedback",
        "  originSessionId: sess_origin",
        "---",
        "",
        "Use local semantic names for internal code.",
      ].join("\n"),
    );
  });

  it("preserves the original file when the first origin session is already present", () => {
    const content = [
      "---",
      "name: existing-memory",
      "description: Existing memory",
      "metadata:",
      "  node_type: other",
      "  type: project",
      "  originSessionId: sess_original",
      "---",
      "",
      "Updated fact.",
    ].join("\n");

    expect(
      stampMemoryOriginSessionId({
        content,
        filePath: `${MEMORY_ROOT}/existing-memory.md`,
        memoryRoot: MEMORY_ROOT,
        sessionId: "sess_later",
      }),
    ).toBe(content);
  });

  it("adds a missing origin session through the Edit write boundary", async () => {
    // Bug 修复(测试):editHandler 经 resolveWorkspacePath 用 win32 normalize——
    // POSIX 风格假路径会被转成反斜杠形态,与 MemoryFileSystem 的 POSIX 键对不上,
    // 稳定报「File does not exist」。workspace 用 win32 形态,键与解析结果一致。
    const editMemoryRoot = win32.join(
      "C:",
      "storage",
      "memories",
      "projects",
      "project-0123456789abcdef",
      "memory",
    );
    const filePath = win32.join(editMemoryRoot, "edited-memory.md");
    const original = [
      "---",
      "name: edited-memory",
      "description: Existing memory without provenance",
      "metadata:",
      "  type: project",
      "---",
      "",
      "Old fact.",
    ].join("\n");
    const fileSystemPort = new MemoryFileSystem({ [filePath]: original });
    const sessionId = createSessionId("memory-edit-origin");
    const context: ToolExecutionContext = {
      abortSignal: new AbortController().signal,
      fileSystemPort,
      memoryRoot: editMemoryRoot,
      sessionId,
      readFileState: createReadFileState(filePath, original),
      toolCallId: "edit-memory-origin",
      traceId: createTraceId(),
      workingDirectory: editMemoryRoot,
      workspaceRoot: editMemoryRoot,
    };

    await editHandler(
      { file_path: "edited-memory.md", old_string: "Old fact.", new_string: "Updated fact." },
      context,
    );

    expect(fileSystemPort.files[filePath]).toBe(
      original
        .replace(
          "  type: project",
          `  node_type: memory\n  type: project\n  originSessionId: ${sessionId}`,
        )
        .replace("Old fact.", "Updated fact."),
    );
  });

  it("does not change files outside Memory or Markdown without frontmatter", () => {
    expect(
      stampMemoryOriginSessionId({
        content: "ordinary project note",
        filePath: "/workspace/note.md",
        memoryRoot: MEMORY_ROOT,
        sessionId: "sess_origin",
      }),
    ).toBe("ordinary project note");
    expect(
      stampMemoryOriginSessionId({
        content: "- [Fact](fact.md) — index entry",
        filePath: `${MEMORY_ROOT}/MEMORY.md`,
        memoryRoot: MEMORY_ROOT,
        sessionId: "sess_origin",
      }),
    ).toBe("- [Fact](fact.md) — index entry");
  });
});


// 复刻 edit-tool-contract.test.ts 的读态夹具:editHandler 强制先读后改。
function revisionFor(path: string, content: string, mtimeMs = 1): FileSystemRevision {
  return {
    id: `rev:${path}:${content.length}:${Buffer.byteLength(content, "utf8")}:${mtimeMs}`,
    mtimeMs,
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

function createReadFileState(filePath: string, content: string): ReadFileStateMap {
  return new Map([
    [
      [filePath, "1", ""].join("\0"),
      {
        path: filePath,
        content,
        offset: undefined,
        limit: undefined,
        isPartialView: false,
        readAt: new Date(),
        revisionId: revisionFor(filePath, content).id,
        mtimeMs: 1,
        sizeBytes: Buffer.byteLength(content, "utf8"),
      },
    ],
  ]);
}

describe("memory write lease (spec 149 批三b)", () => {
  const LEASE_PATH = `${MEMORY_ROOT}/MEMORY.md.lease`;
  const memoryFile = `${MEMORY_ROOT}/MEMORY.md`;

  it("非记忆 .md 路径全程 no-op", async () => {
    const { fs } = createLeaseFs();
    const guard = await acquireMemoryWriteLease({
      fileSystemPort: fs,
      filePath: "/storage/other/notes.md",
      memoryRoot: MEMORY_ROOT,
      sessionId: "sess_a",
    });
    expect(guard.leasePath).toBe("");
    await releaseMemoryWriteLease({ fileSystemPort: fs, guard });
    expect(fs.files[LEASE_PATH]).toBeUndefined();
  });

  it("无租约时获取并写本会话标记,释放即删除", async () => {
    const { fs, removed } = createLeaseFs();
    const guard = await acquireMemoryWriteLease({
      fileSystemPort: fs,
      filePath: memoryFile,
      memoryRoot: MEMORY_ROOT,
      sessionId: "sess_a",
    });
    expect(guard.leasePath).toBe(LEASE_PATH);
    expect(Boolean(fs.files[LEASE_PATH])).toBe(true);
    await releaseMemoryWriteLease({ fileSystemPort: fs, guard });
    expect(removed).toContain(LEASE_PATH);
    expect(Boolean(fs.files[LEASE_PATH])).toBe(false);
  });

  it("他方新鲜租约拒写并带持有人信息", async () => {
    const { fs } = createLeaseFs({
      [LEASE_PATH]: JSON.stringify({
        version: 1,
        sessionId: "sess_b",
        acquiredAt: Date.now() - 5_000,
      }),
    });
    await expect(
      acquireMemoryWriteLease({
        fileSystemPort: fs,
        filePath: memoryFile,
        memoryRoot: MEMORY_ROOT,
        sessionId: "sess_a",
      }),
    ).rejects.toThrow(/locked by another session/);
  });

  it("过期他方租约与本会话残留租约均可重入", async () => {
    const expired = createLeaseFs({
      [LEASE_PATH]: JSON.stringify({
        version: 1,
        sessionId: "sess_b",
        acquiredAt: Date.now() - 121_000,
      }),
    });
    const guard = await acquireMemoryWriteLease({
      fileSystemPort: expired.fs,
      filePath: memoryFile,
      memoryRoot: MEMORY_ROOT,
      sessionId: "sess_a",
    });
    expect(guard.leasePath).toBe(LEASE_PATH);

    const own = createLeaseFs({
      [LEASE_PATH]: JSON.stringify({
        version: 1,
        sessionId: "sess_a",
        acquiredAt: Date.now() - 60_000,
      }),
    });
    await expect(
      acquireMemoryWriteLease({
        fileSystemPort: own.fs,
        filePath: memoryFile,
        memoryRoot: MEMORY_ROOT,
        sessionId: "sess_a",
      }),
    ).resolves.toMatchObject({ leasePath: LEASE_PATH });
  });
});

describe("memory write history archive (spec 149 批三c)", () => {
  const historyLeaf = (memoryRoot: string, name: string) =>
    `${memoryRoot}/.history/${name}/${name}`;
  const memoryFile = `${MEMORY_ROOT}/MEMORY.md`;

  it("archives before/after with op and session for memory files", async () => {
    const { fs } = createLeaseFs();
    const archivePath = await recordMemoryWriteHistory({
      fileSystemPort: fs,
      filePath: memoryFile,
      memoryRoot: MEMORY_ROOT,
      sessionId: "sess_hist",
      op: "update",
      before: "Old fact.",
      after: "New fact.",
    });

    expect(archivePath).toMatch(/^.*\.history\/MEMORY\.md\/MEMORY\.md\.\d{15}-\w+\.json$/);
    const record = JSON.parse(fs.files[archivePath!]) as {
      version: number;
      sessionId: string;
      filePath: string;
      op: string;
      before: string | null;
      after: string;
    };
    expect(record.version).toBe(1);
    expect(record.sessionId).toBe("sess_hist");
    expect(record.op).toBe("update");
    expect(record.before).toBe("Old fact.");
    expect(record.after).toBe("New fact.");
  });

  it("archives create ops with null before and skips non-memory paths", async () => {
    const { fs } = createLeaseFs();
    const createPath = await recordMemoryWriteHistory({
      fileSystemPort: fs,
      filePath: memoryFile,
      memoryRoot: MEMORY_ROOT,
      sessionId: "sess_hist",
      op: "create",
      before: null,
      after: "born",
    });
    const record = JSON.parse(fs.files[createPath!]) as { op: string; before: string | null };
    expect(record.op).toBe("create");
    expect(record.before).toBeNull();

    const skipped = await recordMemoryWriteHistory({
      fileSystemPort: fs,
      filePath: "/storage/other/notes.md",
      memoryRoot: MEMORY_ROOT,
      sessionId: "sess_hist",
      op: "update",
      before: "x",
      after: "y",
    });
    expect(skipped).toBeNull();
  });

  it("never fails the write when the archive backend throws", async () => {
    const { fs } = createLeaseFs();
    fs.writeTextFile = async (request: { path: string }) => {
      if (request.path.includes(".history/")) {
        throw new Error("disk full");
      }
      throw new Error("unexpected write target");
    };
    const archivePath = await recordMemoryWriteHistory({
      fileSystemPort: fs,
      filePath: memoryFile,
      memoryRoot: MEMORY_ROOT,
      sessionId: "sess_hist",
      op: "update",
      before: "a",
      after: "b",
    });
    expect(archivePath).toBeNull();
  });
});
