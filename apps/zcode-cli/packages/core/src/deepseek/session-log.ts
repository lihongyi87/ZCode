/**
 * DeepSeek `dsh_session_log` 请求字段的运行时装配(spec 157)。
 *
 * 每次 DeepSeek 模型请求前:从当前 canonical 消息序列 fold + 按水印打包增量,
 * 产出注入值与 2xx 确认回调。水印存进程内存(keyed by sessionId)——语义是
 * at-least-once(宁重复不跳过,服务端按 afterSeq 幂等),进程重启后水印丢失
 * 只代价一次全量重发,正确性无损;持久化留后续项。
 *
 * 语义移植自 @deepseek-ai/dsh-session-log-deepseek(Apache-2.0),端点接受性已在
 * api.deepseek.com 实测(200,2026-10-26,见 spec 157)。
 */

import {
  buildDeepSeekSessionLog,
  type DeepSeekSessionLogRequestTransaction,
  type DeepSeekSessionLogWatermark,
  type ModelInputMessage,
} from "@zcode/contracts";

/** 进程级水印:同 session 的后续请求增量续传。 */
const watermarks = new Map<string, DeepSeekSessionLogWatermark>();

/** 开关:默认关;`ZCODE_DEEPSEEK_SESSION_LOG=1` 开启。 */
export function isDeepSeekSessionLogEnabled(): boolean {
  return process.env.ZCODE_DEEPSEEK_SESSION_LOG === "1";
}

export function isDeepSeekSessionLogProvider(providerId: string): boolean {
  return providerId.toLowerCase().includes("deepseek");
}

function resolveSessionLogMaxBytes(): number {
  const parsed = Number(process.env.ZCODE_DEEPSEEK_SESSION_LOG_MAX_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8 * 1024 * 1024;
}

/** 测试与运维观察用;生产流程不依赖。 */
export function peekDeepSeekSessionLogWatermark(sessionId: string): DeepSeekSessionLogWatermark | undefined {
  return watermarks.get(sessionId);
}

export function createDeepSeekSessionLogTransaction(input: {
  sessionId: string;
  providerId: string;
  messages: readonly ModelInputMessage[];
}): DeepSeekSessionLogRequestTransaction | undefined {
  if (!isDeepSeekSessionLogEnabled()) return undefined;
  if (!isDeepSeekSessionLogProvider(input.providerId)) return undefined;

  const built = buildDeepSeekSessionLog({
    sessionId: input.sessionId,
    messages: input.messages,
    watermark: watermarks.get(input.sessionId),
    maxBytes: resolveSessionLogMaxBytes(),
  });
  if (!built) return undefined;

  // accept 必须幂等:adapter 内部对同一请求的多次尝试(代理重试等)都算同一份
  // 载荷的投递;只有 core recovery 构造的新请求才会基于新水印产出新 transaction。
  let accepted = false;
  return {
    value: built.value,
    throughSeq: built.throughSeq,
    accept: () => {
      if (accepted) return;
      accepted = true;
      watermarks.set(input.sessionId, built.watermark);
    },
  };
}
