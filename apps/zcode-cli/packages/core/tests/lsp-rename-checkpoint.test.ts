import { describe, expect, it } from "vitest";
import { getFileMutationCheckpointCandidates } from "../src/runtime/helpers/rewind.js";

/** LspRename 多文件 checkpoint 候选提取(批二补:rename 可 rewind)。 */
describe("getFileMutationCheckpointCandidates（LspRename 多文件）", () => {
  const candidate = (path: string) => ({
    filePath: path,
    originalFile: `before ${path}`,
    content: `after ${path}`,
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
    type: "lsp_rename",
  });

  it("fileMutations 数组逐项通过校验", () => {
    const candidates = getFileMutationCheckpointCandidates({
      symbolName: "renamed",
      files: [{ path: "a.ts", editCount: 2 }],
      fileMutations: [candidate("a.ts"), candidate("b.ts")],
    });
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.filePath).toBe("a.ts");
    expect(candidates[1]?.content).toBe("after b.ts");
  });

  it("任一项无效则整批丢弃(fail-closed,不留半套 checkpoint)", () => {
    const candidates = getFileMutationCheckpointCandidates({
      fileMutations: [
        candidate("a.ts"),
        { filePath: "bad.ts", structuredPatch: [{ nonsense: true }] },
      ],
    });
    expect(candidates).toEqual([]);
  });

  it("无 fileMutations 字段返回空(Edit/Write 走单文件形态)", () => {
    expect(getFileMutationCheckpointCandidates({ filePath: "a.ts", structuredPatch: [] })).toEqual([]);
    expect(getFileMutationCheckpointCandidates("not an object")).toEqual([]);
  });
});
