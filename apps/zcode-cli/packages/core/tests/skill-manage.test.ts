import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SKILL_MANAGE_INPUT_SCHEMA,
  skillManageDirectory,
  skillManageToolEntry,
} from "../src/tool/handlers/skill-manage.js";

/** spec 152:SkillManage handler 行为(临时 HOME 隔离,不触真实用户目录)。 */
describe("SkillManage handler", () => {
  let tempHome: string | undefined;
  let savedSkillsHome: string | undefined;

  afterEach(() => {
    if (tempHome) {
      rmSync(tempHome, { force: true, recursive: true });
      tempHome = undefined;
    }
    if (savedSkillsHome !== undefined) {
      if (savedSkillsHome === "") delete process.env.ZCODE_SKILLS_HOME;
      else process.env.ZCODE_SKILLS_HOME = savedSkillsHome;
    }
  });

  const withTempHome = (run: (home: string) => Promise<void>) => async () => {
    tempHome = mkdtempSync(join(tmpdir(), "zcode-skill-manage-"));
    savedSkillsHome = process.env.ZCODE_SKILLS_HOME ?? "";
    process.env.ZCODE_SKILLS_HOME = tempHome;
    await run(tempHome);
  };

  const toolCallId = "call_test";

  it(
    "create 写入 frontmatter+正文,路径在 ~/.zcode/skills 下且可被 discovery 扫描",
    withTempHome(async (home) => {
      const result = (await skillManageToolEntry.handler!(
        {
          action: "create",
          name: "deploy-checklist",
          description: "Pre-deploy verification steps",
          body: "## When to Use\nBefore shipping.\n## Procedure\n1. run tests\n## Pitfalls\nDon't skip.\n## Verification\ngreen CI",
        },
        {
          toolCallId,
          toolName: "SkillManage",
        } as never,
      )) as { path: string; chars: number };
      const expectedDir = join(home, ".zcode", "skills");
      expect(result.path).toContain(expectedDir);
      expect(result.path.endsWith(join("deploy-checklist", "SKILL.md"))).toBe(true);
      const file = readFileSync(result.path, "utf8");
      expect(file).toContain("name: deploy-checklist");
      expect(file).toContain("description: Pre-deploy verification steps");
      expect(file).toContain("created_by: skill_manage");
      expect(file).toContain("## Procedure");
      // discovery 回环的 roots 扫描断言在 adapters 侧 skills 测试(core 不反向依赖 adapters)。
    }),
    30_000,
  );

  it(
    "create 已存在同名即拒绝(查重,指向 patch)",
    withTempHome(async () => {
      await skillManageToolEntry.handler!(
        {
          action: "create",
          name: "dupe",
          description: "first",
          body: "## Procedure\none",
        },
        { toolCallId, toolName: "SkillManage" } as never,
      );
      await expect(
        skillManageToolEntry.handler!(
          { action: "create", name: "dupe", description: "second", body: "## Procedure\ntwo" },
          { toolCallId, toolName: "SkillManage" } as never,
        ),
      ).rejects.toThrow(/already exists.*patch/s);
    }),
    30_000,
  );

  it(
    "patch 恰好一次替换;零次/多次出现拒绝;缺技能指向 create",
    withTempHome(async (home) => {
      await skillManageToolEntry.handler!(
        { action: "create", name: "patched", description: "d", body: "## Procedure\nstep A then step B" },
        { toolCallId, toolName: "SkillManage" } as never,
      );
      const patched = (await skillManageToolEntry.handler!(
        { action: "patch", name: "patched", old_text: "step A", new_text: "step A-prime" },
        { toolCallId, toolName: "SkillManage" } as never,
      )) as { chars: number };
      expect(readFileSync(join(skillManageDirectory(home), "patched", "SKILL.md"), "utf8")).toContain(
        "step A-prime",
      );
      expect(patched.chars).toBeGreaterThan(0);

      await expect(
        skillManageToolEntry.handler!(
          { action: "patch", name: "patched", old_text: "not-there", new_text: "x" },
          { toolCallId, toolName: "SkillManage" } as never,
        ),
      ).rejects.toThrow(/not found/);
      await expect(
        skillManageToolEntry.handler!(
          { action: "patch", name: "patched", old_text: "step", new_text: "S" },
          { toolCallId, toolName: "SkillManage" } as never,
        ),
      ).rejects.toThrow(/2 times/);
      await expect(
        skillManageToolEntry.handler!(
          { action: "patch", name: "missing", old_text: "a", new_text: "b" },
          { toolCallId, toolName: "SkillManage" } as never,
        ),
      ).rejects.toThrow(/does not exist/);
    }),
    30_000,
  );

  it("body 超限拒绝;name 非法被 schema 拒绝", () => {
    expect(() =>
      SKILL_MANAGE_INPUT_SCHEMA.parse({
        action: "create",
        name: "Bad_Name",
        description: "d",
        body: "b",
      }),
    ).toThrow();
    expect(() =>
      SKILL_MANAGE_INPUT_SCHEMA.parse({ action: "create", name: "ok-name", description: "d", body: "x".repeat(33_000) }),
    ).toThrow();
  });
});
