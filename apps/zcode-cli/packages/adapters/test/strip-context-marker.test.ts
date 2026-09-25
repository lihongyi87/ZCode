import assert from "node:assert/strict";
import test from "node:test";
import { stripContextMarkerSuffix } from "../src/model/model-execution.js";

/**
 * [1m] 窗口标记后缀剥离测试：第三方标准 API 拒收 [1m] 后缀（实测
 * api.deepseek.com 拒收 deepseek-v4-pro[1m]），发送前剥离；智谱系网关
 * 理解该后缀，原样保留。
 *
 * 运行：cd apps/zcode-cli/packages/adapters && node --import tsx --test test/strip-context-marker.test.ts
 */

test("api-key 接入：剥离 [1m] 后缀", () => {
  assert.equal(stripContextMarkerSuffix("deepseek-v4-pro[1m]", "api-key"), "deepseek-v4-pro");
  assert.equal(stripContextMarkerSuffix("glm-5.2[1m]", "api-key"), "glm-5.2");
  assert.equal(stripContextMarkerSuffix("plain-model", "api-key"), "plain-model");
});

test("智谱系网关：保留 [1m] 后缀（网关理解该约定）", () => {
  assert.equal(stripContextMarkerSuffix("glm-5.2[1m]", "zhipu-coding-plan-api-key"), "glm-5.2[1m]");
  assert.equal(stripContextMarkerSuffix("glm-5.2[1m]", "zhipu-account"), "glm-5.2[1m]");
});

test("未声明接入类型：保守剥离（第三方默认语义）", () => {
  assert.equal(stripContextMarkerSuffix("deepseek-v4-pro[1m]", undefined), "deepseek-v4-pro");
});

test("非 [1m] 后缀不动（避免误伤其他方括号约定）", () => {
  assert.equal(stripContextMarkerSuffix("model[preview]", "api-key"), "model[preview]");
  assert.equal(stripContextMarkerSuffix("model[1m]x", "api-key"), "model[1m]x");
});
