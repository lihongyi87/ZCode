import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* node.ts 的 resolveSpawnEnv 是 1200+ 行容器的内联闭包，为它搭 mock 不划算；
   这里沿用 agentProxyEnv.test.ts 的接线源码断言模式，钉住 win32 CUA 凭据铸造的
   承重顺序。背景：3.15.1 官方化接线（4f7c1a3b）把「recipe 解析失败 →
   BROKER_UNAVAILABLE」带了进来，而 recipe（ZCODE_CUA_WIN_HELPER_RECIPE）是官方
   闭源 helper 的启动材料，开源 trycua 驱动链路不消费——CE 构建因此 Windows
   Computer Use 恒不可用（2026-10-27 实测）。修复=recipe 仅 best-effort 附加，
   铸造的 socket+authority 恒下发（F3-2 懒铸造语义）。 */
describe("node.ts win32 CUA spawn env keeps the F3-2 mint regardless of helper recipe", () => {
  const source = readFileSync(resolve(process.cwd(), "packages/services/src/node.ts"), "utf8");
  const spawnEnvStart = source.indexOf("resolveSpawnEnv: async (");
  const spawnEnvBlock = source.slice(
    spawnEnvStart,
    source.indexOf("...buildAgentTelemetrySpawnEnv({", spawnEnvStart),
  );

  it("mints socket+authority unconditionally, before the recipe decision", () => {
    // 铸造必须在 recipe 解析之前、且不受其结果影响：recipe 是 best-effort 附加项，
    // 不是凭据的前置条件。顺序反了（铸造落进 recipe 成功分支）即为本回归复发。
    const mintAt = spawnEnvBlock.indexOf("[BROKER_SOCKET_ENV]: brokerSocket");
    const recipeAt = spawnEnvBlock.indexOf("await resolveStableCuaWinRecipe()");
    expect(mintAt).toBeGreaterThan(-1);
    expect(recipeAt).toBeGreaterThan(mintAt);
  });

  it("never maps a recipe failure to broker_unavailable", () => {
    // 回归 tripwire：recipe 失败曾把整个 env 替换成 BROKER_UNAVAILABLE，令 bootstrap
    // 不再向 node_repl 注入 ZCODE_CUA_NODE_REPL_HOST=1。spawn env 组装里出现该
    // key 即说明门控回归；若未来确需 broker_unavailable 语义，先重新论证与
    // node-repl-host 注入门控（mcp-config.ts）的联动，再改这条断言。
    expect(spawnEnvBlock).not.toContain("BROKER_UNAVAILABLE_ENV");
    expect(spawnEnvBlock).not.toContain("windows helper recipe could not be resolved");
  });

  it("still attaches the recipe when the helper payload resolves", () => {
    // 官方 helper 在位的形态（带 tools/cua-helper 的产品构建 / ZCODE_CUA_DEV_ROOT
    // 开发链路）不得退化：recipe 必须随 env 下发，供 SDK 首调自 fork helper。
    expect(spawnEnvBlock).toContain('cuaProductHelperEnv["ZCODE_CUA_WIN_HELPER_RECIPE"]');
    expect(spawnEnvBlock).toContain("hostPid: process.pid");
  });
});
