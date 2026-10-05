// ============================================================
// GetContextRemaining - 模型可见的上下文余量仪表（吸收自 codex 同名工具）
// ============================================================
// 模型在长任务里能自查上下文余量，自主决定收敛输出、先交付成果、或建议
// 用户压缩/开新会话——与静态的 Context Management 指导文案互补（那里只有
// 行为规范，没有实时数字）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const GetContextRemainingInputSchema = z.object({}).strict();
export type GetContextRemainingInput = z.infer<typeof GetContextRemainingInputSchema>;
export const GetContextRemainingInputJsonSchema = toToolJsonSchema(GetContextRemainingInputSchema);

export const GetContextRemainingOutputSchema = z
  .object({
    /** 当前模型声明的上下文窗口（token）；不可得为 null。 */
    contextWindow: z.number().int().positive().nullable(),
    /** 最近一次模型请求的上下文占用比例（0-100）；尚无请求时为 null。 */
    usedPercent: z.number().min(0).max(100).nullable(),
    /** 估算剩余 token（contextWindow × (1-pressure)）；任一前提缺失为 null。 */
    tokensLeft: z.number().int().nullable(),
  })
  .strict();
export type GetContextRemainingOutput = z.infer<typeof GetContextRemainingOutputSchema>;
export const GetContextRemainingOutputJsonSchema = toToolJsonSchema(GetContextRemainingOutputSchema);
