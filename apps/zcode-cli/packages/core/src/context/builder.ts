// ============================================================
// Context Builder - System prompt assembly
// ============================================================

import type { ModelInputMessage } from "@zcode/contracts";
import type {
  ContextMetaUserAttachment,
  ContextSection,
  ContextBuildResult,
  ContextBuilderConfig,
  EnvInfo,
} from "./types.js";
import type { ToolRegistry } from "../tool/registry.js";
import { estimateTokens } from "./utils.js";
import { buildCliPrefixSection } from "./sections/cli-prefix.js";
import { buildIdentitySection } from "./sections/identity.js";
import { buildWorkflowActorIdentitySection } from "./sections/workflow-actor.js";
import { buildEnvInfoSection, buildGitSystemContextSection } from "./sections/env-info.js";
import { buildSkillsSection } from "./sections/skills.js";
import { buildRequestUserContextSection } from "./sections/request-user-context.js";
import { buildCurrentDateSection } from "./sections/current-date.js";
import { buildMemorySection } from "./sections/memory.js";
import { buildDesktopContextSection } from "./sections/desktop.js";
import {
  buildContextManagementSection,
  buildDynamicBehaviorSection,
  buildOutputStyleSection,
  buildSessionGuidanceSection,
} from "./dynamic-sections.js";

// -----------------------------------------------
// Context Builder
// -----------------------------------------------

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" as const };
/** Skill 工具的注册名（与 tool/handlers/skill.ts 的 metadata.name 同字面；contracts 没有常量）。 */
const SKILL_TOOL_NAME = "Skill";

export class ContextBuilder {
  private config: ContextBuilderConfig;
  private customSections: ContextSection[] = [];

  constructor(config: ContextBuilderConfig) {
    this.config = config;
  }

  /**
   * 保留兼容入口。工具说明由 model request 的 tools 字段承载，不再镜像进 system prompt。
   */
  setToolRegistry(_registry: ToolRegistry): this {
    return this;
  }

  setEnvInfo(envInfo: EnvInfo): this {
    this.config = {
      ...this.config,
      envInfo,
    };
    return this;
  }

  /**
   * 添加自定义 section（用于后续扩展）
   */
  addSection(
    section: Omit<ContextSection, "chars" | "tokens" | "injectionTarget" | "cacheHint"> &
      Partial<Pick<ContextSection, "injectionTarget" | "cacheHint">>,
  ): this {
    this.customSections.push({
      ...section,
      injectionTarget: section.injectionTarget ?? "system",
      cacheHint: section.cacheHint ?? "dynamic",
      chars: section.content.length,
      tokens: estimateTokens(section.content),
    });
    return this;
  }

  /**
   * 构建 context，返回结构化结果
   */
  build(): ContextBuildResult {
    const sections: ContextSection[] = [];
    const activeOutputStyle = this.config.outputStyle?.prompt.trim()
      ? this.config.outputStyle
      : undefined;
    const customSystemPrompt = this.config.customSystemPrompt?.trim();
    const hasCustomSystemPrompt = Boolean(customSystemPrompt);
    // 工作流子代理身份：第三条路径。与
    // customSystemPrompt 互斥——两者同在只可能是接线错误（persona 该经 workflowActor 进来，
    // 不该再塞 systemPrompt），大声失败而不是默默二选一。
    const workflowActor = this.config.workflowActor;
    if (workflowActor !== undefined && hasCustomSystemPrompt) {
      throw new Error(
        "ContextBuilder: workflowActor and customSystemPrompt are mutually exclusive",
      );
    }
    const isWorkflowActor = workflowActor !== undefined;

    // 1. CLI / product prefix. Keep this as the short leading identity block.
    // 「You are ZCode, an interactive coding agent」对一个
    // 只对脚本说话、可能连读文件工具都没有的子代理是错的身份，且走在正确身份段前面。
    if (!isWorkflowActor) {
      sections.push(buildCliPrefixSection());
    }

    // 2. Stable agent behavior or custom prompt body
    // 默认 identity 段不在此处（stable 桶头部）推送——它每个 agent 不同（主代理 /
    // explore / 输出风格变体），放 stable 头部会让主代理与子代理从 stable body
    // 第一个字符就分叉，跨 agent 的 provider KV 缓存前缀共享归零。已移至
    // dynamic 桶尾部（gitSystemContext 之后），共享段先行、identity 垫底。
    if (hasCustomSystemPrompt) {
      sections.push(
        createSection({
          name: "Custom System Prompt",
          source: "custom_system_prompt",
          injectionTarget: "system",
          cacheHint: "stable",
          content: customSystemPrompt ? `\n${customSystemPrompt}` : "",
        }),
      );
    } else if (workflowActor !== undefined) {
      // 工作流 actor 身份留在 stable 原位：actor 会话单人单身份，无跨 agent
      // 共享前缀诉求，且它替换的是整套默认体系。
      sections.push(buildWorkflowActorIdentitySection(workflowActor));
    }

    // 3. Dynamic system context
    // custom prompt 不是只替换
    // stable body，而是跳过默认 system prompt 体系和 systemContext；否则用户提供
    // custom prompt 后仍会混入 Session Guidance / output style 等动态 system 段。
    // 工作流子代理跳过其中面向「与用户对话」的三段（desktop、Dynamic Behavior、session
    // guidance——契约里已把 Report outcomes faithfully 搬过去），保留 memory 与其后各段。
    if (!hasCustomSystemPrompt) {
      if (!isWorkflowActor && this.config.presentationSurface === "zcode_desktop") {
        sections.push(buildDesktopContextSection());
      }

      // behaviour part right after stable sp...
      if (!isWorkflowActor) {
        sections.push(buildDynamicBehaviorSection());
      }

      // Session-specific guidance
      const sessionGuidanceSection = isWorkflowActor
        ? null
        : buildSessionGuidanceSection(
            this.config.guidanceToolNames ?? [],
            (this.config.skills?.skills.length ?? 0) > 0,
          );
      if (sessionGuidanceSection) {
        sections.push(sessionGuidanceSection);
      }

      // Memory
      if (this.config.memoryRoot) {
        const memorySection = buildMemorySection(this.config.memoryRoot);
        if (memorySection) {
          sections.push(memorySection);
        }
      }
      sections.push(buildEnvInfoSection(this.config.envInfo, this.config.model));

      // Output Style
      const outputStyleSection = buildOutputStyleSection(activeOutputStyle);
      if (outputStyleSection) {
        sections.push(outputStyleSection);
      }

      // Context Management
      sections.push(buildContextManagementSection());

      const gitSystemContextSection = buildGitSystemContextSection(this.config.envInfo);
      if (gitSystemContextSection) {
        sections.push(gitSystemContextSection);
      }

      // identity 垫底（cacheHint 已改 dynamic）：见步骤 2 的迁移注释。放共享段
      // 之后，主代理与子代理的 system 前缀得以共享到 identity 之前。
      if (!hasCustomSystemPrompt && workflowActor === undefined) {
        sections.push(buildIdentitySection(activeOutputStyle));
      }
    }

    // 4. Skills appear as a meta user system-reminder, matching provider block layout.
    // guidanceToolNames 是 runtime 当下的
    // 工具表；一个 Skill 工具未注册的工作流子代理被告知「以下技能可经 Skill 工具使用」，
    // 只会让它相信自己有一个没有的工具。表缺席（测试 / 旧调用方）时保持既有行为。
    if (this.config.skills && this.skillToolAvailable()) {
      const skillsSection = buildSkillsSection({
        outcome: this.config.skills,
        metadataBudget: this.config.skillMetadataBudget,
      });
      if (skillsSection) {
        sections.push(skillsSection);
      }
    }

    // 5. Meta user context: workspace instructions/project memory first, date second.
    const requestUserContextSection = buildRequestUserContextSection({
      userInstructions: this.config.userInstructions,
      memoryIndexContent: this.config.memoryIndexContent,
      memoryRoot: this.config.memoryRoot,
    });
    if (requestUserContextSection) {
      sections.push(requestUserContextSection);
    }

    const currentDateSection = buildCurrentDateSection(this.config.currentDate);
    if (currentDateSection) {
      sections.push(currentDateSection);
    }

    // 6. Custom sections
    sections.push(...this.customSections);

    const orderedSections = orderSectionsForInjection(sections);

    // 计算总计
    const totalChars = orderedSections.reduce((sum, s) => sum + s.chars, 0);
    const totalTokens = orderedSections.reduce((sum, s) => sum + s.tokens, 0);

    const systemMessages = this.assembleSystemMessages(orderedSections);
    const metaUserAttachments = this.assembleMetaUserAttachments(orderedSections);

    return {
      sections: orderedSections,
      totalChars,
      totalTokens,
      systemMessages,
      metaUserAttachments,
    };
  }

  private skillToolAvailable(): boolean {
    const names = this.config.guidanceToolNames;
    return names === undefined || names.includes(SKILL_TOOL_NAME);
  }

  private assembleSystemMessages(sections: ContextSection[]): ModelInputMessage[] {
    const messages: ModelInputMessage[] = [];

    const cliPrefixContent = buildSectionContent(
      sections.filter(
        (section) => section.injectionTarget === "system" && section.source === "cli_prefix",
      ),
    );
    if (cliPrefixContent) {
      messages.push({
        role: "system",
        content: cliPrefixContent,
        // 不打 cache 断点：断点配额有限（Anthropic 4 个），cli-prefix 的缓存写
        // 恒被紧随其后的 stable body 断点覆盖（断点语义=覆盖 0..X 前缀），单独
        // 标记它纯属浪费配额。省下的配额给了 meta-user 边界断点（AGENTS.md/
        // context_prefix 尾部），见 provider-request-messages 的 finalize。
      });
    }

    const stableBodyContent = buildSectionContent(
      sections.filter(
        (section) =>
          section.injectionTarget === "system" &&
          section.cacheHint === "stable" &&
          section.source !== "cli_prefix",
      ),
    );
    if (stableBodyContent) {
      messages.push({
        role: "system",
        content: stableBodyContent,
        cacheControl: EPHEMERAL_CACHE_CONTROL,
      });
    }

    const dynamicSystemContent = buildSectionContent(
      sections.filter(
        (section) => section.injectionTarget === "system" && section.cacheHint === "dynamic",
      ),
    );
    if (dynamicSystemContent) {
      messages.push({
        role: "system",
        // ZCode by design：Main Agent 的 dynamic system block 自带左边界，所有 provider 保持一致。
        content: `\n\n${dynamicSystemContent}`,
        cacheControl: EPHEMERAL_CACHE_CONTROL,
      });
    }

    return messages;
  }

  private assembleMetaUserAttachments(sections: ContextSection[]): ContextMetaUserAttachment[] {
    const attachments: ContextMetaUserAttachment[] = [];

    const skillsContent = buildSkillsMetaUserBody(
      sections.filter(
        (section) => section.injectionTarget === "meta_user" && section.source === "skills",
      ),
    );
    if (skillsContent) {
      attachments.push({
        source: "skills_listing",
        content: skillsContent,
      });
    }

    const contextContent = buildContextMetaUserBody(
      sections.filter(
        (section) => section.injectionTarget === "meta_user" && section.source !== "skills",
      ),
    );
    if (contextContent) {
      attachments.push({
        source: "context_prefix",
        content: contextContent,
      });
    }

    return attachments;
  }
}

function orderSectionsForInjection(sections: ContextSection[]): ContextSection[] {
  return [
    ...sections.filter(
      (section) => section.injectionTarget === "system" && section.cacheHint === "stable",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "system" && section.cacheHint === "dynamic",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "meta_user" && section.cacheHint === "stable",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "meta_user" && section.cacheHint === "dynamic",
    ),
  ];
}

export function buildContextMetaUserBody(sections: ContextSection[]): string | null {
  if (sections.length === 0) return null;

  return [
    "As you answer the user's questions, you can use the following context:",
    buildSectionContent(sections),
    "",
    "      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
  ].join("\n");
}

export function buildSkillsMetaUserBody(sections: ContextSection[]): string | null {
  const content = buildSectionContent(sections);
  if (!content) {
    return null;
  }

  return content;
}

function buildSectionContent(sections: ContextSection[]): string {
  return sections.map((section) => section.content).join("\n\n");
}

function createSection(input: {
  name: string;
  source: ContextSection["source"];
  injectionTarget: ContextSection["injectionTarget"];
  cacheHint: ContextSection["cacheHint"];
  content: string;
}): ContextSection {
  return {
    ...input,
    chars: input.content.length,
    tokens: estimateTokens(input.content),
    preview: input.content.slice(0, 100),
  };
}

// -----------------------------------------------
// Factory
// -----------------------------------------------

export function createContextBuilder(config: ContextBuilderConfig): ContextBuilder {
  return new ContextBuilder(config);
}
