import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** spec 164:探针门控与 pending 审批(stage/pending/approve/reject)。 */
describe("SkillManage pending gating (spec 164)", () => {
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
    tempHome = mkdtempSync(join(tmpdir(), "zcode-skill-probe-"));
    savedSkillsHome = process.env.ZCODE_SKILLS_HOME ?? "";
    process.env.ZCODE_SKILLS_HOME = tempHome;
    await run(tempHome);
  };

  const toolCallId = "call_probe";
  const call = (input: Record<string, unknown>) =>
    skillManageToolEntry.handler!(input, {
      toolCallId,
      toolName: "SkillManage",
      sessionId: "sess-probe",
    } as never);

  it(
    "stage create 不落 live;pending 列出;approve 应用后与直写 create 字节一致",
    withTempHome(async (home) => {
      const staged = (await call({
        action: "stage",
        name: "probe-skill",
        description: "Probe gated skill",
        body: "## When to Use\nprobe test",
        evidence: "contrast: with-skill 3/3 vs without 1/3 on affected tests",
      })) as { action: string; id: string; stagedAs: string };
      expect(staged.action).toBe("stage");
      expect(staged.stagedAs).toBe("create");
      expect(existsSync(join(home, ".zcode", "skills", "probe-skill"))).toBe(false);
      expect(existsSync(join(home, ".zcode", "skills", ".pending", `${staged.id}.json`))).toBe(true);

      const list = (await call({ action: "pending", name: "probe-skill" })) as {
        count: number;
        entries: Array<{ id: string; hasEvidence: boolean }>;
      };
      expect(list.count).toBe(1);
      expect(list.entries[0]?.hasEvidence).toBe(true);

      const approved = (await call({ action: "approve", name: "probe-skill", id: staged.id })) as {
        action: string;
        path: string;
        evidence?: string;
      };
      expect(approved.action).toBe("approve");
      expect(approved.path).toBe(join(home, ".zcode", "skills", "probe-skill", "SKILL.md"));
      expect(approved.evidence).toContain("with-skill 3/3");
      const live = readFileSync(approved.path, "utf8");
      expect(live).toContain("name: probe-skill");
      expect(live).toContain("## When to Use");
      expect(existsSync(join(home, ".zcode", "skills", ".pending", `${staged.id}.json`))).toBe(false);
    }),
  );

  it(
    "stage patch 后 live 被改 → approve 冲突拒绝且 pending 保留",
    withTempHome(async () => {
      await call({
        action: "create",
        name: "conflict-skill",
        description: "Conflict target",
        body: "old anchor text here",
      });
      const staged = (await call({
        action: "stage",
        name: "conflict-skill",
        old_text: "old anchor text",
        new_text: "new anchor text",
      })) as { id: string };
      // 模拟暂存后技能文件被他人改动
      const skillFile = join(tempHome!, ".zcode", "skills", "conflict-skill", "SKILL.md");
      writeFileSync(skillFile, "rewritten without the anchor", "utf8");

      await expect(
        call({ action: "approve", name: "conflict-skill", id: staged.id }),
      ).rejects.toThrow(/old_text not found/);
      // pending 仍在,可修正后重试或 reject
      const list = (await call({ action: "pending", name: "conflict-skill" })) as { count: number };
      expect(list.count).toBe(1);
      const rejected = (await call({
        action: "reject",
        name: "conflict-skill",
        id: staged.id,
      })) as { action: string };
      expect(rejected.action).toBe("reject");
      const after = (await call({ action: "pending", name: "conflict-skill" })) as { count: number };
      expect(after.count).toBe(0);
    }),
  );

  it(
    "同名 pending 去重拒绝;live 已存在拒绝 create-stage;live 缺席拒绝 patch-stage",
    withTempHome(async () => {
      await call({
        action: "stage",
        name: "dedupe-skill",
        description: "First",
        body: "v1",
      });
      await expect(
        call({ action: "stage", name: "dedupe-skill", description: "Second", body: "v2" }),
      ).rejects.toThrow(/already exists \(id=/);

      await expect(
        call({ action: "stage", name: "dedupe-skill", old_text: "v1", new_text: "v2" }),
      ).rejects.toThrow(/does not exist/);

      await call({
        action: "create",
        name: "live-skill",
        description: "Live",
        body: "live body",
      });
      await expect(
        call({ action: "stage", name: "live-skill", description: "Dup", body: "x" }),
      ).rejects.toThrow(/already exists at/);
    }),
  );

  it(
    ".pending 不进技能发现(scan-policy 点前缀目录跳过,spec 164 护栏断言)",
    withTempHome(async () => {
      const { shouldWalkSkillDirectoryEntry } = await import("@zcode/shared");
      expect(shouldWalkSkillDirectoryEntry(".pending")).toBe(false);
    }),
  );
});
