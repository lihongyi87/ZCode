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

/** 降档后的档位；返回 undefined 表示本步不覆盖（保持会话配置）。 */
export function resolveAdaptiveReasoningLevel(input: AdaptiveReasoningInput): string | undefined {
  if (!input.enabled || !input.endsWithToolResult) return undefined;
  const levels = input.supportedLevels;
  if (!Array.isArray(levels) || levels.length < 2) return undefined;
  const currentIndex = input.currentLevel !== undefined ? levels.indexOf(input.currentLevel) : -1;
  // 未配置档位（供应商默认）或已是最低档：不降。
  if (currentIndex <= 0) return undefined;
  return levels[currentIndex - 1];
}

/** 判断请求消息是否以工具结果收尾（工具结果在投影里是 user 角色的 toolResult 块）。 */
export function requestEndsWithToolResult(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "system") continue;
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
