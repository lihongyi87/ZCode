import assert from "node:assert/strict";
import test from "node:test";

import { buildSkillsSection } from "../src/context/sections/skills.js";
import type { SkillMetadata } from "@zcode/contracts";

/**
 * P6 技能 listing 三级降级回归：超预算不再全表跌 names-only（悬崖），
 * 而是全量→短描述→头部全量+尾部 names-only；构建期定档（确定性）。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/skills-section.test.ts
 */

const skill = (name: string, description: string): SkillMetadata =>
  ({
    name,
    qualifiedName: undefined,
    path: `F:\\skills\\${name}\\SKILL.md`,
    description,
    whenToUse: undefined,
  }) as unknown as SkillMetadata;

const LONG_DESCRIPTION = "紫微斗数断盘技能，覆盖十二宫位、四化飞星、大限流年推演，含占州派与飞星派双轨口径，支持合盘与流月细化。".repeat(2);

function makeSkills(count: number): SkillMetadata[] {
  return Array.from({ length: count }, (_, i) => skill(`skill-${String(i).padStart(3, "0")}`, LONG_DESCRIPTION));
}

test("预算内：全量描述原样（不回归）", () => {
  const section = buildSkillsSection({ outcome: { skills: makeSkills(3) } as never, metadataBudget: 10_000 });
  assert.ok(section?.content.includes("紫微斗数断盘技能"));
  assert.ok(section!.content.includes("skill-000"));
});

test("略超预算：全表保留但描述截到短档（不再跌 names-only 悬崖）", () => {
  const skills = makeSkills(30);
  const section = buildSkillsSection({ outcome: { skills } as never, metadataBudget: 12_000 });
  const content = section?.content ?? "";
  // 每个技能都仍有描述（非 names-only）
  for (const s of skills) {
    const line = content.split("\n").find((l) => l.includes(s.name));
    assert.ok(line, `${s.name} 应在 listing`);
    assert.ok(line!.includes(`${s.name}: `), `${s.name} 应保留描述（非纯名字）`);
  }
  assert.ok(content.length <= 12_000, `应在预算内，实际 ${content.length}`);
});

test("大幅超预算：头部保描述、尾部降 names-only，全部技能仍可见", () => {
  const skills = makeSkills(80);
  const section = buildSkillsSection({ outcome: { skills } as never, metadataBudget: 8_000 });
  const content = section?.content ?? "";
  assert.ok(content.length <= 8_000, `应在预算内，实际 ${content.length}`);
  let withDescription = 0;
  for (const s of skills) {
    const line = content.split("\n").find((l) => l.includes(s.name));
    assert.ok(line, `${s.name} 必须仍然可见（names-only 也可见）`);
    if (line!.includes(`${s.name}: `)) withDescription += 1;
  }
  assert.ok(withDescription > 0 && withDescription < skills.length, `应混合档，实际带描述 ${withDescription}/${skills.length}`);
  assert.ok(content.includes("Descriptions truncated"), "降级说明行应在");
});

test("确定性：同一输入两次构建逐字节一致（会话内前缀稳定）", () => {
  const skills = makeSkills(50);
  const a = buildSkillsSection({ outcome: { skills } as never, metadataBudget: 9_000 })?.content;
  const b = buildSkillsSection({ outcome: { skills } as never, metadataBudget: 9_000 })?.content;
  assert.equal(a, b);
});
