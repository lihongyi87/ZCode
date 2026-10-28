# 164 · SkillManage 探针门控与 pending 审批(spec 160 P2/P3 落地 · Harness² 机制吸收)

状态:**已实现(MVP)**——契约 action 扩为六值(stage/pending/approve/reject+既有 create/patch,含 JSON Schema 同步);handler 抽 applyCreate/applyPatch 共享函数;pending 库 `~/.zcode/skills/.pending/`;冲突守卫(approve 时 old_text 失配→报错保留 pending);SkillManage 描述新增 evidence-gated 指引(先验证再 stage,对比结果进 evidence)。测试 8/8(4 既有回归+4 新增:stage 不落 live/pending 列表/approve 字节级一致/冲突守卫+reject/去重与语义守卫/.pending 扫描护栏断言);全链 tsc EXIT=0;lint 0 错误
来源:Harness² 对比探针(spec 163)的机制 + Hermes pending 审批流(spec 160 P3)的形态 + 本仓 SkillManage(spec 152)的既有基座。

## 问题

SkillManage 现在 create/patch **直写** `~/.zcode/skills/`(needsApproval 权限闸一次性)。三个缺口:①无人值守流(off-peak/proactive/subagent)写入要么阻塞等批、要么不写,没有"先挂起稍后批"的中间态;②写入不带证据——技能为什么这么写、验证过没有,无据可查;③patch 无冲突守卫——暂存后技能文件被人改过,应用时才发现失败。这就是 spec 160 P2(自动复盘不敢放)/P3(pending 审批)悬而未决的根子。

## 设计(MVP)

### pending 暂存库

`~/.zcode/skills/.pending/<id>.json`。**点前缀目录被技能扫描策略天然跳过**
(`shouldWalkSkillDirectoryEntry` 只放行 allowlist 点目录——`packages/shared/src/skill-scan-policy.ts` 既有护栏,本 spec 不改它,补一条回扫断言测试)。条目 JSON:
`{id, name, action: "create"|"patch", description?, body?, old_text?, new_text?, evidence?, sessionId, timeCreated}`。

### 契约扩展(`contracts/src/tools/skill.ts`)

action 枚举扩为 `create|patch|stage|pending|approve|reject`:

- `stage` = create/patch 语义 + 全部同名必填校验,但**写 pending 不写 live**;新增可选 `evidence`(≤2000 字符,探针证据:任务/对比结果/bench 判定)。同名 live 已存在时 create-stage 拒绝;同名 pending 已在时拒绝(避免堆积)。
- `pending` = 列出暂存(id/name/action/描述/时间/有无证据),无输入参数(name 仍必填但忽略——schema 单形态所限,文档注明)。
- `approve` = 按 id 应用到 live(复用 create/patch 同一套护栏:exists 检查、old_text 唯一性、大小上限);**冲突守卫**:应用失败(old_text 不再唯一/缺失、create 目标已存在)时报错并**保留 pending**。成功后删除 pending 条目。
- `reject` = 按 id 丢弃。

### 门控不变量(防自我瓦解)

`approve`/`reject` 是模型可调动作,但 SkillManage 整体 `needsApproval: true`——**每次调用都过用户权限闸**,模型无法绕过用户自我批准。无人值守上下文由 permission broker 按既有策略收敛。

### 价值闭环

①无人值守/off-peak 复盘可以 stage 不阻塞(spec 160 P2 的安全落盘位);②批量审批+证据链(用户看 pending 列表逐条批);③patch 冲突守卫;④证据字段=Harness² 对比探针的数据位——**MVP 由 agent 自主填**(它有 Bash/子代理,可以自己跑 bench 把判定贴进 evidence),**phase 2** 把这一步自动化(in-handler 子代理对比 runner,证据通过自动 approve)。

## phase 2 遗留(登记,不实现)

`stage` 的 `probe` 参数:`{tasks: string[], verifier?: string}`——handler 内部起两个子代理(带/不带新技能)跑同任务,verifier 命令(如受影响单测/断语校验)判定对比结果,通过则自动 approve。需要子代理端口进 handler 上下文(当前 SkillManage 是纯 fs 工具),成本/超时模型另立。

## 验收

- stage→approve:create 链路落到 live SKILL.md(与直写 create 字节一致);patch 链路应用替换。
- 冲突守卫:stage patch 后 live 文件被改(old_text 失配)→ approve 报错且 pending 仍在。
- pending 列表/reject/同名 pending 拒绝/同名 live create-stage 拒绝/evidence 往返。
- `.pending` 不进技能发现(shared scan-policy 既有行为,补断言测试钉住)。
- 全部走 `ZCODE_SKILLS_HOME` 临时目录隔离(既有夹具模式)。
