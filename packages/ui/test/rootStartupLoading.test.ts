import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RootStartupLoading, ZCodeStartupLogoBadge } from "@/root/RootStartupLoading.js";

describe("RootStartupLoading", () => {
  // 2026-10-23 品牌调整：徽章从内联 Z SVG 换成 BCode 位图（无动画语义），
  // 断言从「SVG 存在、无 animate」改为「img 徽章存在、无动画元素」。
  it("静态品牌图标不渲染呼吸动画", () => {
    const html = renderToStaticMarkup(createElement(ZCodeStartupLogoBadge, { animated: false }));
    expect(html).toContain("<img");
    expect(html).toContain('src="');
    expect(html).not.toContain("<animate");
  });
  it("启动阻塞态渲染品牌徽章而不是可见 loading 文案", () => {
    const html = renderToStaticMarkup(createElement(RootStartupLoading, { label: "加载中..." }));

    expect(html).toContain('data-testid="root-startup-loading"');
    expect(html).toContain('aria-label="加载中..."');
    expect(html).toContain("<img");
    expect(html).not.toContain("<animate");
    expect(html).not.toContain(">加载中...<");
  });
});
