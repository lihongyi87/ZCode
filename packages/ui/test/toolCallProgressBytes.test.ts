// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { toolProgressSchema } from "@zcode/shared/zcode-protocol-v4";
import { ToolCallProgressIndicator } from "@/ToolCallBlocks/ToolCallProgressIndicator.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

afterEach(cleanup);

/** spec 155:长等待可见性。Bash 字节计数与 TaskOutput 等待上限都经
 * row.progress(toolProgressSchema)到达渲染器;这里钉住 schema 容纳三要素。 */
describe("长等待可见性(spec 155)", () => {
  it("progress schema 容纳 bytes/message/elapsedMs 三要素", () => {
    const parsed = toolProgressSchema.parse({
      bytes: 1280,
      message: "阻塞上限 120s · 输出文件 4.2KB",
      elapsedMs: 42_000,
      updatedAt: 1,
    });
    expect(parsed.bytes).toBe(1280);
    expect(parsed.message).toContain("阻塞上限 120s");
    expect(parsed.elapsedMs).toBe(42_000);
  });

  it("bytes 缺席仍合法(非 Bash 工具的心跳只有 elapsedMs)", () => {
    const parsed = toolProgressSchema.parse({
      elapsedMs: 15_000,
      updatedAt: 2,
    });
    expect(parsed.bytes).toBeUndefined();
  });
});

function renderIndicator(progress: Parameters<typeof ToolCallProgressIndicator>[0]["progress"]) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ToolCallProgressIndicator, { progress }),
    ),
  );
}

describe("长等待可见性(spec 155)渲染", () => {
  it("Bash 零字节显示「暂无输出」，有字节显示「已收」", () => {
    const silent = renderIndicator({
      bytes: 0,
      elapsedMs: 12_000,
      updatedAt: 1,
    });
    expect(silent.container.textContent).toContain("暂无输出");
    cleanup();

    const active = renderIndicator({
      bytes: 1280,
      elapsedMs: 12_000,
      updatedAt: 1,
    });
    expect(active.container.textContent).toContain("已收 1.3KB");
    expect(active.container.textContent).not.toContain("暂无输出");
  });

  it("TaskOutput 心跳的「已等待」只出现一次", () => {
    // CLI 侧 message 只描述上限与规模；elapsedMs 单独渲染成「已等待 N 秒」。
    const { container } = renderIndicator({
      elapsedMs: 15_000,
      message: "阻塞上限 120s · 输出文件 4.2KB",
      updatedAt: 1,
    });
    const text = container.textContent ?? "";
    expect(text).toContain("已等待");
    expect(text.split("已等待").length - 1).toBe(1);
    expect(text).toContain("阻塞上限 120s");
    expect(text).toContain("输出文件 4.2KB");
    // 时长在前、规模说明在后，避免读成「已等待…已等待」。
    expect(text.indexOf("已等待")).toBeLessThan(text.indexOf("阻塞上限"));
  });

  it("没有 elapsedMs 时 message 原样显示，不补前导分隔符", () => {
    const { container } = renderIndicator({ message: "准备中", updatedAt: 1 });
    expect(container.textContent).toContain("准备中");
    expect(container.textContent).not.toContain("· 准备中");
  });
});
