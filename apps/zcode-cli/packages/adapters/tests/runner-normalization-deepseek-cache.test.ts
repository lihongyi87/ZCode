import { describe, expect, it } from "vitest";
import { normalizeUsage } from "../src/model/runner-normalization.js";

/** spec 150:DeepSeek 原生顶层缓存字段的兜底映射。 */
describe("normalizeUsage DeepSeek prompt_cache_hit_tokens fallback", () => {
  it("maps top-level prompt_cache_hit_tokens when token details are absent", () => {
    const result = normalizeUsage({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      raw: { prompt_tokens: 10, prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 3 },
    });

    expect(result.cacheReadTokens).toBe(7);
    // miss 语义≠写缓存,不得映射
    expect(result.cacheWriteTokens).toBeUndefined();
  });

  it("prefers inputTokenDetails.cacheReadTokens over the DeepSeek top-level field", () => {
    const result = normalizeUsage({
      inputTokens: 10,
      // AI SDK 层已把嵌套 prompt_tokens_details.cached_tokens 映射进 inputTokenDetails
      inputTokenDetails: { cacheReadTokens: 9 },
      raw: {
        prompt_cache_hit_tokens: 7,
        prompt_tokens_details: { cached_tokens: 9 },
      },
    });

    expect(result.cacheReadTokens).toBe(9);
  });

  it("stays undefined when neither the details nor the DeepSeek field is present", () => {
    const result = normalizeUsage({
      inputTokens: 3,
      raw: { prompt_tokens: 3 },
    });

    expect(result.cacheReadTokens).toBeUndefined();
  });
});
