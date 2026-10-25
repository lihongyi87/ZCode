// ============================================================
// Skills Section Builder
// ============================================================

import type { SkillLoadOutcome, SkillMetadata } from "@zcode/contracts";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

const DEFAULT_SKILL_METADATA_BUDGET = 20_000;
/**
 * 单行描述字符上限。250 会把长描述的尾部触发词切掉（奇门 349 字，尾部含
 * 「盲测复盘库 / 231 案例 / 十一体系诊断路由 / 杨公风水 1080 局」），而这些词
 * 恰是区分相近体系的判据。400 在 60 技能快照下只增加约 1.8 K 字符，仍在 20 K
 * 预算内（docs/development/140-qimen-skill-leverage.md P0-2）。
 */
const MAX_DESCRIPTION_CHARS = 400;

interface SkillsSectionOptions {
  outcome: SkillLoadOutcome;
  metadataBudget?: number;
}

export function buildSkillsSection(options: SkillsSectionOptions): ContextSection | null {
  if (options.outcome.skills.length === 0) {
    return null;
  }

  // 学习循环触发指令(spec 152):三种时刻沉淀技能。固定追加在降级逻辑之后
  // (预算外固定成本 ~500 字符);技能数为 0 时整段缺席,触发说明由 SkillManage
  // 工具描述自身承载。
  const content = `${buildSkillsContent(
    options.outcome.skills,
    options.metadataBudget ?? DEFAULT_SKILL_METADATA_BUDGET,
  )}

${SKILL_MANAGE_PROMPT_BLOCK}`;

  return {
    name: "Skills",
    source: "skills",
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

const SKILL_MANAGE_PROMPT_BLOCK = [
  "## Persisting new skills",
  "",
  "When a multi-step workflow worked and is worth repeating, you hit errors or dead",
  "ends and found the working path, or the user corrects your approach — save it as a",
  "personal skill with the SkillManage tool (requires user approval). Lessons, not",
  "logs: store a generalizable rule plus one line of why. New skills are invocable as",
  "/<name> from the next session.",
].join("\n");

/** P6 短描述档字符数（三级降级的第②档）。 */
const SHORT_DESCRIPTION_CHARS = 120;

/**
 * P6 三级优雅降级（防 names-only 悬崖）：技能数增长越过预算时，旧实现把
 * **全表**一次性跌成 names-only，体系路由断崖式退化（当前 60 技能 ≈16.6K，
 * 距 20K 预算仅 3.4K 余量）。三级都在构建期一次性定档——会话内前缀稳定，
 * 不逐轮随 query 重排（skills_listing 属前缀源，重排=缓存全冲刷）：
 *   ① 全量描述（≤250 字符）放得下 → 原样；
 *   ② 放不下 → 全表换短描述（≤120）再试；
 *   ③ 仍放不下 → 头部尽量多的短描述行 + 尾部 names-only（保字母序，确定性）。
 */
function buildSkillsContent(skills: SkillMetadata[], budget: number): string {
  const lines = ["The following skills are available for use with the Skill tool:", ""];

  const sortedSkills = [...skills].sort((a, b) =>
    skillDisplayName(a).localeCompare(skillDisplayName(b)),
  );
  const fullLines = sortedSkills.map((skill) => formatSkillLine(skill, MAX_DESCRIPTION_CHARS));
  const full = [...lines, ...fullLines].join("\n");
  if (full.length <= budget) {
    return full;
  }

  const shortLines = sortedSkills.map((skill) => formatSkillLine(skill, SHORT_DESCRIPTION_CHARS));
  const short = [...lines, ...shortLines].join("\n");
  if (short.length <= budget) {
    return short;
  }

  const namesOnlyFrom = (from: number) =>
    sortedSkills
      .slice(from)
      .map(
        (skill) => `- ${skillDisplayName(skill)}${bareAliasSuffix(skill)} (file: ${skill.path})`,
      );
  const truncatedNote =
    "Descriptions truncated for the least-fitting tail; load a skill to see its full SKILL.md:";

  let used = lines.join("\n").length + truncatedNote.length + 2;
  const kept: string[] = [];
  let keptCount = 0;
  for (const line of shortLines) {
    const tail = namesOnlyFrom(keptCount + 1).join("\n");
    if (used + line.length + 1 + tail.length > budget) break;
    kept.push(line);
    used += line.length + 1;
    keptCount += 1;
  }
  return [...lines, ...kept, truncatedNote, ...namesOnlyFrom(keptCount)].join("\n");
}

function formatSkillLine(skill: SkillMetadata, maxDescriptionChars: number): string {
  const description = skill.whenToUse
    ? `${skill.description} - ${skill.whenToUse}`
    : skill.description;
  const trimmed =
    description.length > maxDescriptionChars
      ? `${description.slice(0, maxDescriptionChars - 1)}...`
      : description;
  return `- ${skillDisplayName(skill)}: ${trimmed}${bareAliasSuffix(skill)} (file: ${skill.path})`;
}

function skillDisplayName(skill: SkillMetadata): string {
  return skill.qualifiedName ?? skill.name;
}

function bareAliasSuffix(skill: SkillMetadata): string {
  return skill.qualifiedName && skill.qualifiedName !== skill.name
    ? ` (also loadable as ${skill.name})`
    : "";
}
