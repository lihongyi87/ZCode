import { describe, expect, it } from "vitest";
import {
  renderCodemodeToolDeclarations,
  toBindingIdentifier,
} from "../src/tools-bindings.js";

describe("toBindingIdentifier", () => {
  it("folds MCP 风格名字里的非法字符为下划线（Pi 同规则）", () => {
    expect(toBindingIdentifier("mcp__dev-radius__search")).toBe("mcp__dev_radius__search");
  });

  it("前导数字补下划线前缀", () => {
    expect(toBindingIdentifier("3d-render")).toBe("_3d_render");
  });

  it("重名按出现序追加序号，不静默覆盖", () => {
    const rendered = renderCodemodeToolDeclarations(
      [
        { name: "mcp__a__search", description: "first" },
        { name: "mcp__a__search", description: "second" },
      ],
      10_000,
    );
    expect(rendered.included).toEqual(["mcp__a__search", "mcp__a__search"]);
    expect(rendered.declarations).toContain("declare function mcp__a__search(");
    expect(rendered.declarations).toContain("declare function mcp__a__search_2(");
  });
});

describe("renderCodemodeToolDeclarations", () => {
  const tools = [
    { name: "read_file", description: "读文件", inputSchema: { type: "object" } },
    { name: "web_search", description: "搜索" },
    { name: "huge_tool", description: "x".repeat(8_000) },
  ];

  it("预算内全部收录且声明含描述与压缩 schema", () => {
    const rendered = renderCodemodeToolDeclarations(tools, 10_000);
    expect(rendered.omitted).toEqual([]);
    expect(rendered.included).toEqual(["read_file", "web_search", "huge_tool"]);
    expect(rendered.declarations).toContain("declare function read_file(");
    expect(rendered.declarations).toContain('"type":"object"');
    expect(rendered.declarations).toContain("读文件");
  });

  it("预算截断按整块工具丢弃，被截名单如实回传", () => {
    const rendered = renderCodemodeToolDeclarations(tools, 120);
    // 前两个小工具应被保留，8k 字符描述的 huge_tool 必然超预算。
    expect(rendered.included).toEqual(["read_file", "web_search"]);
    expect(rendered.omitted).toEqual(["huge_tool"]);
    expect(rendered.declarations).not.toContain("huge_tool");
  });

  it("预算为 0 时全量省略、声明为空串", () => {
    const rendered = renderCodemodeToolDeclarations(tools, 0);
    expect(rendered.declarations).toBe("");
    expect(rendered.included).toEqual([]);
    expect(rendered.omitted).toEqual(["read_file", "web_search", "huge_tool"]);
  });

  it("JSDoc 内的 */ 被转义，避免声明块提前闭合", () => {
    const rendered = renderCodemodeToolDeclarations(
      [{ name: "tricky", description: "use */ carefully" }],
      5_000,
    );
    expect(rendered.declarations).toContain("*\\/ carefully");
  });
});
