// ============================================================
// Skills Section Builder
// ============================================================

import type { SkillLoadOutcome, SkillMetadata } from "@zcode/contracts";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

const DEFAULT_SKILL_METADATA_BUDGET = 20_000;
const MAX_DESCRIPTION_CHARS = 250;

interface SkillsSectionOptions {
  outcome: SkillLoadOutcome;
  metadataBudget?: number;
}

export function buildSkillsSection(options: SkillsSectionOptions): ContextSection | null {
  if (options.outcome.skills.length === 0) {
    return null;
  }

  const content = buildSkillsContent(
    options.outcome.skills,
    options.metadataBudget ?? DEFAULT_SKILL_METADATA_BUDGET,
  );

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
  const lines = [
    "The following skills are available for use with the Skill tool:",
    "",
  ];

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
      .map((skill) => `- ${skillDisplayName(skill)}${bareAliasSuffix(skill)} (file: ${skill.path})`);
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
