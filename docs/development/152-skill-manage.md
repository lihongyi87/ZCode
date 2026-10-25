# 152 · SkillManage——经验到技能的自主写入(学习循环批一)

## 背景与来源

Hermes Agent(NousResearch,MIT)考察(2026-10-25,记忆 `harness-landscape-survey` 复核)
的「learning loop」中,ZCode 已有等价物:后台记忆提取(149 批三管线)、常驻上下文记忆
(自动记忆库+融合召回)、会话检索(sessions-index)。**唯一缺口 = 「经验→技能」的自主
写入路径**:模型在跑通多步流程/踩坑找到正路/被用户纠正之后,自主把可复用的做法沉淀为
用户级技能,跨会话可直接 `/调用`。这是程序性记忆(怎么做),与既有陈述性记忆(是什么)
互补;ZCode 的 Skill 工具是只读调用,skill-creator 插件是用户面工具,均无模型自主写入。

## 设计

### 工具:SkillManage(needsApproval)

- 入参:`action: "create" | "patch"`;create 带 `name`/`description`/`body`,patch 带
  `name`/`old_text`/`new_text`。name 限 `[a-z0-9-]`(目录安全)。
- 写入目标:`~/.zcode/skills/<name>/SKILL.md`(skills discovery 原生扫描的用户级根,
  `resolveDefaultSkillRoots` 的 user scope)。
- create:已存在即拒绝并提示改用 patch(查重);body 上限 32k 字符(Hermes
  oversized-body 阈值同量级);frontmatter 由 handler 生成(name/description/metadata
  标记来源),正文建议节顺序(When to Use / Procedure / Pitfalls / Verification)由
  工具描述承载,不强校验。
- patch:`old_text` 必须在现有正文中**恰好出现一次**,否则拒绝(与 Hermes 同语义);
  目标不存在时报错指向 create。
- 审批:`needsApproval: true` + `sideEffectScope: "system"` + `riskLevel: "medium"`
  ——写入用户家目录(工作区之外),走现成 permission broker,无需新审批 UI。
- 生效时机:skills discovery 在会话启动时扫描,**新建技能自下次会话起可 `/调用`**;
  工具输出显式告知此边界(当次会话内模型仍可 Read 该文件引用内容)。

### 提示词:创建触发指令

Skills 段(context/sections/skills.ts)末尾追加固定指令块(约 500 字符,预算外固定
成本):多步流程跑通/踩坑找到正路/被用户纠正三种时刻 → 用 SkillManage 沉淀;「lessons
not logs」——可泛化的规则 + 一行为什么。技能数为 0 时不注入(空库场景由工具描述
自身承载触发说明)。

## 非目标

- 不做 linter/curator 整理(Hermes 的 anti-pattern 警告与整理器,后置评估);
- 不做 pending 暂存目录(`/skills approve`)——审批走 permission broker 已覆盖
  「用户把关」诉求,双轨审批是重复状态;
- 不做 agentskills.io Hub 安装/信任分级(生态面,另行评估)。

## 验收

- ✅ handler 测试(core/tests/skill-manage.test.ts,4/4):create 写入
  frontmatter+正文、已存在拒绝(指向 patch)、patch 恰好一次替换、多次/零次出现
  拒绝、缺技能指向 create、body 超限/name 非法拒绝。测试隔离经
  ZCODE_SKILLS_HOME(临时 HOME),不触真实用户目录。
- ✅ discovery 同源:写入根 = `resolveDefaultSkillRoots` 的 user scope 根
  (~/.zcode/skills),adapter 侧 skills 测试覆盖 roots 扫描。
- ✅ 提示词块:skills 段末尾「Persisting new skills」指令(context-builder 测试)。
- ✅ typecheck/architecture 全绿;审批走 permission broker(needsApproval)。

## 状态

已落地(2026-10-25)。遗留后置:linter/curator 整理、pending 双轨审批、Hub 生态。
