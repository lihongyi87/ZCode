/**
 * 逐模型步自适应思考档（experimental，默认关闭）。
 *
 * 动机：agent 循环里大量模型步是「工具续跑」——上文以工具结果收尾，模型只需要
 * 决定下一步读/改哪里。这类步的高档思考 token 对质量贡献小，却按输出 token 计费
 * 并直接拖慢到答案的墙钟时间（思考 token 也走解码）。首个模型步（新用户输入后）
 * 与综合类步保持用户配置档位不变。
 *
 * 契约通道：`ModelRequest.options.reasoningLevel` 支持**逐请求**覆盖（adapters 的
 * model-option-map 在每次请求体上应用 reasoningLevel map），因此本路由不需要改
 * 会话级模型绑定，只在本步请求上降档。
 *
 * 降档规则：`optionSpecs.reasoningLevel.values` 按供应商配置为升序列表（低→高），
 * 续跑步取「当前档的前一档」，绝不越过用户配置两档以上；列表长度不足 2 或当前
 * 已是最低档时不降。UI 展示的思考档位仍是会话配置值（本覆盖只影响请求体）。
 *
 * 开关：环境变量 `ZCODE_ADAPTIVE_REASONING=1|true`。默认关闭——这是行为改动，
 * 质量回归需经 bench 验证后再默认开启（仓库铁律：效果没数据不默认生效）。
 */

export interface AdaptiveReasoningInput {
  enabled: boolean;
  /** 会话配置的当前档位（model.options.reasoningLevel）。 */
  currentLevel?: string;
  /** 供应商声明的升序档位列表（optionSpecs.reasoningLevel.values）。 */
  supportedLevels?: readonly string[];
  /** 本步请求最后一条非 system 消息是否为工具结果（= 续跑步）。 */
  endsWithToolResult: boolean;
}

/** 已知思考档等级表。供应商 values 实测全部升序（zcode-builtin 15 种排序均如此），
 * 但这是配置惯例不是契约——第三方自建 provider 可能乱序。降档按等级表裁决，
 * 全是未知名或无法比较时放弃（宁可不省，不可反向升档）。 */
const REASONING_LEVEL_RANK: Readonly<Record<string, number>> = Object.freeze({
  none: 0,
  disabled: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
});

function rankOf(level: string): number | undefined {
  return REASONING_LEVEL_RANK[level];
}

/** 降档后的档位；返回 undefined 表示本步不覆盖（保持会话配置）。 */
export function resolveAdaptiveReasoningLevel(input: AdaptiveReasoningInput): string | undefined {
  if (!input.enabled || !input.endsWithToolResult) return undefined;
  const levels = input.supportedLevels;
  if (!Array.isArray(levels) || levels.length < 2) return undefined;
  const currentRank = input.currentLevel !== undefined ? rankOf(input.currentLevel) : undefined;
  if (currentRank === undefined || currentRank === 0) return undefined;
  // 从当前档向低找：取等级严格更低的最近一档（不依赖 values 数组顺序）。
  let fallback: string | undefined;
  let fallbackRank = -Infinity;
  for (const level of levels) {
    const rank = rankOf(level);
    if (rank === undefined || rank >= currentRank) continue;
    if (rank > fallbackRank) {
      fallbackRank = rank;
      fallback = level;
    }
  }
  return fallback;
}

/** 判断请求消息是否以工具结果收尾（工具结果在投影里是 user 角色的 toolResult 块）。 */
export function requestEndsWithToolResult(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "system") continue;
    // 工具结果在投影后的请求里是独立的 role:"tool" 消息（含 toolCallId/toolName，
    // 见 message-history 的 tool result entry 与 transform 的 case "tool"）——
    // red-team 修正：v1 只查 user+toolResult 块，真实请求上永不命中，降档从未触发。
    if (message.role === "tool") return true;
    if (message.role !== "user") return false;
    const content = message.content;
    if (typeof content === "string") return false;
    if (!Array.isArray(content)) return false;
    return content.some((block) => {
      if (block === null || typeof block !== "object") return false;
      const type = (block as { type?: unknown }).type;
      return type === "toolResult" || type === "tool_result";
    });
  }
  return false;
}

/** 环境开关读取（独立出来便于测试注入）。 */
export function isAdaptiveReasoningEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.ZCODE_ADAPTIVE_REASONING;
  return value === "1" || value === "true";
}
