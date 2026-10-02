/**
 * 清理字符串中的孤立 Unicode 代理项（unpaired surrogates）。
 *
 * 背景：LLM tokenizer 可拆出半个 emoji 的代理项（如 \ud83d 无 \ude01 配对），
 * 这些孤立代理进入 API 请求体后，GLM 网关（Python）在 UTF-8 编码时报
 * "surrogates not allowed" 并返回 500。ZCode 侧必须在文本进入历史前消毒。
 *
 * 有效代理对（高代理后跟低代理）原样保留；孤立高代理、孤立低代理替换为
 * U+FFFD（替换字符），确保后续 UTF-8 编码永远合法。
 */
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizeLoneSurrogates(text: string): string {
  if (!text) return text;
  return text.replace(LONE_SURROGATE_PATTERN, "\uFFFD");
}
