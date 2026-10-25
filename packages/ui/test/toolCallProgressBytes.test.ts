import { describe, expect, it } from "vitest";
import { toolProgressSchema } from "@zcode/shared/zcode-protocol-v4";

/** spec 155:长等待可见性。Bash 字节计数与 TaskOutput 等待上限都经
 * row.progress(toolProgressSchema)到达渲染器;这里钉住 schema 容纳三要素。 */
describe("长等待可见性(spec 155)", () => {
  it("progress schema 容纳 bytes/message/elapsedMs 三要素", () => {
    const parsed = toolProgressSchema.parse({
      bytes: 1280,
      message: "已等待 / 阻塞上限 120s · 输出文件 4.2KB",
      elapsedMs: 42_000,
      updatedAt: 1,
    });
    expect(parsed.bytes).toBe(1280);
    expect(parsed.message).toContain("阻塞上限 120s");
    expect(parsed.elapsedMs).toBe(42_000);
  });

  it("bytes 缺席仍合法(非 Bash 工具的心跳只有 elapsedMs)", () => {
    const parsed = toolProgressSchema.parse({ elapsedMs: 15_000, updatedAt: 2 });
    expect(parsed.bytes).toBeUndefined();
  });
});
