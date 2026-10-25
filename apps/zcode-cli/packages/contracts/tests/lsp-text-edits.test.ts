import { describe, expect, it } from "vitest";
import { applyLspTextEdits } from "../src/tools/lsp.js";

const SAMPLE = "const alpha = 1;\nconst beta = 2;\nvoid alpha;\n";

describe("applyLspTextEdits（1-based 倒序应用）", () => {
  it("替换单行内的范围", () => {
    const result = applyLspTextEdits(SAMPLE, [
      { line: 1, character: 7, endLine: 1, endCharacter: 12, newText: "beta" },
    ]);
    expect(result).toBe("const beta = 1;\nconst beta = 2;\nvoid alpha;\n");
  });

  it("同一行多个编辑按倒序应用,靠前偏移不被推移", () => {
    // "const beta = 2;" 里 beta=7..10(end 11)、"2"=14(end 15)。
    const result = applyLspTextEdits(SAMPLE, [
      { line: 2, character: 7, endLine: 2, endCharacter: 11, newText: "gamma" },
      { line: 2, character: 14, endLine: 2, endCharacter: 15, newText: "3" },
    ]);
    expect(result).toBe("const alpha = 1;\nconst gamma = 3;\nvoid alpha;\n");
  });

  it("跨行替换把多行折叠为替换文本", () => {
    // 互斥端语义:end=16 覆盖第二行全部 15 个字符(含末尾分号)。
    const result = applyLspTextEdits(SAMPLE, [
      { line: 1, character: 1, endLine: 2, endCharacter: 16, newText: "// collapsed" },
    ]);
    expect(result).toBe("// collapsed\nvoid alpha;\n");
  });

  it("越界编辑明确报错(不静默截断)", () => {
    expect(() =>
      applyLspTextEdits(SAMPLE, [{ line: 9, character: 1, endLine: 9, endCharacter: 5, newText: "x" }]),
    ).toThrow(/out of range/);
  });
});
