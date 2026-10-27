// Codemode 工具速查渲染器（spec 158）：把策略预批工具面渲染成模型可读的 TS 声明速查，
// 按 token 预算整块截断。纯函数、无 IO——输入描述符来自 tools broker 的 describe 响应。

/** 估算文本 token 数：与 spec 158 的实测口径一致（≈3.6 字节/token）。 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

/** 包名 → JS 合法标识符：非法字符折叠为下划线（mcp__dev-radius__search → mcp__dev_radius__search）。 */
export function toBindingIdentifier(toolName: string): string {
  const sanitized = toolName.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized;
}

export interface CodemodeToolBindingInput {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface RenderedToolDeclarations {
  /** TS 速查全文（已按预算截断；不含桥的使用说明前缀）。 */
  declarations: string;
  /** 进入速查的工具名（输入顺序）。 */
  included: string[];
  /** 超出预算被截掉的工具名——调用方应提示模型走 describe 按需发现。 */
  omitted: string[];
}

/**
 * 渲染工具声明速查。预算只约束声明区本身；桥的使用说明前缀由调用方自理。
 * 截断粒度是整块工具：永不输出半截声明，被截掉的工具名如实回传。
 */
export function renderCodemodeToolDeclarations(
  tools: CodemodeToolBindingInput[],
  budgetTokens: number,
): RenderedToolDeclarations {
  const included: string[] = [];
  const omitted: string[] = [];
  const blocks: string[] = [];
  let usedTokens = 0;
  const seenIdentifiers = new Map<string, number>();

  for (const tool of tools) {
    let identifier = toBindingIdentifier(tool.name);
    const seen = seenIdentifiers.get(identifier) ?? 0;
    seenIdentifiers.set(identifier, seen + 1);
    if (seen > 0) identifier = `${identifier}_${seen + 1}`;

    const schemaText = tool.inputSchema ? JSON.stringify(tool.inputSchema) : "";
    const docLines = [
      tool.description ? `* ${tool.description.replaceAll("*/", "*\\/")}` : undefined,
      schemaText ? `* schema: ${schemaText}` : undefined,
    ].filter((line): line is string => line !== undefined);
    const block =
      docLines.length > 0
        ? `/**\n${docLines.map((line) => ` ${line}`).join("\n")}\n */\n`
        : "";
    const signature = `declare function ${identifier}(args: Record<string, unknown>): Promise<{ output: string; isError: boolean }>;`;
    const blockTokens = estimateTokens(block + signature);
    if (usedTokens + blockTokens > budgetTokens) {
      omitted.push(tool.name);
      continue;
    }
    usedTokens += blockTokens;
    included.push(tool.name);
    blocks.push(block + signature);
  }

  return { declarations: blocks.join("\n"), included, omitted };
}
