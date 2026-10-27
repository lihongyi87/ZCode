import { randomUUID } from "node:crypto";
import type { ToolExecutor, ToolRegistry } from "@zcode/core";
import type { NodeReplToolDescriptor, NodeReplToolInvokeResult } from "@zcode/shared";

/**
 * Codemode tools broker 的策略预批 Port（spec 158 方案 1）：
 * describe/invoke 都只面对 `needsApproval !== true` 的工具——审批语义不进脚本路径。
 * invoke 走 ToolExecutor.execute，其内部 permission-flow 照常生效（预批工具本就
 * 无需审批）；结果取模型可见 output 的文本口径，富媒体结果留在原生工具路径。
 */
export interface NodeReplToolsPort {
  describe(): NodeReplToolDescriptor[];
  invoke(input: {
    tool: string;
    arguments: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<NodeReplToolInvokeResult>;
}

export function createNodeReplToolsPort(input: {
  registry: ToolRegistry;
  executor: ToolExecutor;
}): NodeReplToolsPort {
  const policyApprovedEntry = (tool: string) => {
    const entry = input.registry.get(tool);
    if (!entry || entry.metadata.needsApproval === true) return undefined;
    return entry;
  };

  return {
    describe() {
      const descriptors: NodeReplToolDescriptor[] = [];
      for (const name of input.registry.list()) {
        const entry = policyApprovedEntry(name);
        if (!entry) continue;
        descriptors.push({
          name: entry.metadata.name,
          ...(entry.metadata.description ? { description: entry.metadata.description } : {}),
          ...(entry.inputSchema ? { inputSchema: entry.inputSchema } : {}),
        });
      }
      return descriptors;
    },

    async invoke({ tool, arguments: args, signal }) {
      const entry = policyApprovedEntry(tool);
      if (!entry) {
        throw new Error(
          `Tool "${tool}" is not available via codemode (unknown or approval-required)`,
        );
      }
      const result = await input.executor.execute(
        { id: randomUUID(), name: entry.metadata.name, input: args },
        { signal },
      );
      const output =
        typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? "");
      return { output, isError: !result.success };
    },
  };
}
