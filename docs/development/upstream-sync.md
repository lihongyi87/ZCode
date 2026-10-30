# 上游同步台账

> **用途**：累积记录"我们与上游的关系"—— 每个上游版本同步了什么、有意未同步什么、以及**确认过不存在**什么。
> **与 release notes 的分工**：release notes 的「同步上游」一节面向用户、只写**本版**且**用户可见**的同步情况；
> 本台账是**跨版本累积**的完整记录（含内部项与依据），供维护者查"我们落后多少、为什么没跟"。
> **不要**把本台账的内容复制进 README —— README 的「与官方开源版的差异」一节已表达"除差异外一致"，再写会重复。

## 记录格式

| 字段         | 含义                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------- |
| 条目         | 同步对象（能力/修复/协议）                                                                  |
| 上游版本     | 来自哪个上游版本                                                                            |
| 来源         | `开源仓库` / `闭源包`                                                                       |
| 依据         | `源码比对`（确信度高）/ `逆向分析`（确信度低，**有源码后应回头复核**）/ `官方 release note` |
| 同步情况     | `已跟进` / `未跟进（有意）` / `部分跟进` / `不适用`（**确认过：上游也不提供**）             |
| 我们何时落地 | 本仓库的版本号或"未落地"                                                                    |

**`不适用` 与 `未跟进（有意）` 的区别很重要**：前者是"查过、上游也没有"，后者是"上游有、我们决定不要"。两者都不能写成"已跟进"。

## 基线（会漂移的值，标快照时刻）

| 项                                   | 值                                                                                                                                                                                         | 快照时刻        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| 我们的 fork 点（merge-base）         | `872ad960`（`feat: open source`）                                                                                                                                                          | 2026-09-24      |
| 上游开源仓库 main                    | 停在 `v3.14.3` = `29628c9`（2026-09-24 起无新提交，fetch 复核）                                                                                                                            | 2026-10-04      |
| 上游开源仓库 main（2026-10-12 复核） | **已到 `v3.15.1` = `aac4756`**（整版 squash：3.14.3→3.15.1 一次跳版，core 252 文件 +10K 行；见下方 v3.15.1 节）                                                                            | 2026-10-12      |
| 上游开源仓库 main（2026-10-20 复核） | **已到 `v3.16.1` = `0a1fc56d`**（2026-10-19 整版 sync 提交，Source-Commit `1f4d7f01`；**未打 tag**——tags 仍只有 v3.14.3 / v3.15.1；4502 文件 +356K/-122K，已整版合并，见下方 v3.16.1 节）  | 2026-10-20      |
| 上游开源仓库 main（2026-10-24 复核） | **已到 `v3.16.2` = `3c5b227`**（2026-10-20 14:23 sync 提交；263 文件 +10.5K/-4K，已整版合并，见下方 v3.16.2 节）                                                                           | 2026-10-24      |
| 上游开源仓库 main（2026-10-30 复核） | **已到 `v3.17.1` = `a60ba6a7`**（2026-10-30 sync；**表面 300 文件，实际 2070 文件删除 + 1007 新增——上游测试架构大迁移**，未合并，见下方 v3.17.1 节）                                       | 2026-10-30      |
| 上游开源仓库最新 tag                 | **`v3.17.1` = `a60ba6a7`**（2026-10-30 sync 直接带 tag——上游自 3.17 起给 sync 提交打版本；tags 共三个：v3.14.3 / v3.15.1 / v3.17.1；2026-10-30 复核）                                      | 2026-10-30      |
| 上游 feature 分支                    | `feat/ui-plugin` = `662c30b`（2026-09-29，UI plugins + Gen UI，426 文件 / +55671 行，**未发版**；新增带 patch 的 `@open-pencil/core@0.14.0`）—— **未跟进**（未发版分支，等进 main 再评估） | 2026-10-04 复核 |
| 上游闭源发行包                       | `ZCode-3.14.4-linux-x64.deb` —— 逐字节对比 = 3.14.3 + 阿里云验证码健壮性补丁 + 版本号                                                                                                      | 2026-10-03 到手 |
| 我们领先 / 落后                      | **落后 1** 提交（`a60ba6a7`/v3.17.1，侦察完成未合并——见 v3.17.1 节裁决要点）；领先 CE 线全部提交。上次领先计数 532（2026-10-24 复核口径）                                                  | 2026-10-30      |

> 复算方式：`git fetch upstream --tags && git merge-base HEAD upstream/main && git rev-list --left-right --count HEAD...upstream/main`。
> **注意**：上游 `v3.14.3` 的**唯一父提交**就是开源提交 `872ad96`，因此"v3.14.3 新增"与"开源基线就有"可以精确切分 —— 比只看一棵树可靠。

## v3.14.3（来源：开源仓库）

| 条目                                                                  | 来源     | 依据     | 同步情况                                                                                                                                                                                                                                       | 我们何时落地                                                                                                                                                                                |
| --------------------------------------------------------------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作流引擎：续跑确定性修复（`replay-order`，ReplaySettleOrder）       | 开源仓库 | 源码比对 | 已跟进（`953f6ea`）                                                                                                                                                                                                                            | fix.3 已落地（`953f6ea`）                                                                                                                                                                   |
| 工作流卡片：性能与稳定性建模（`runIndex` + 时间线缓存）               | 开源仓库 | 源码比对 | 已跟进（`9487ed8`）                                                                                                                                                                                                                            | fix.3 已落地（`9487ed8`）                                                                                                                                                                   |
| 工作流失败语义（`wire-fault` + `fault.subscription.contentRejected`） | 开源仓库 | 源码比对 | 已跟进（`fce07b1`）                                                                                                                                                                                                                            | fix.3 已落地（`fce07b1`）                                                                                                                                                                   |
| 协议 v4：workflowRuns 扩张（op 5→7、实例上限 256→1024、新增 9 文件）  | 开源仓库 | 源码比对 | **已跟进**（2026-09-27，ce.4）                                                                                                                                                                                                                 | `2907feb` —— 整体搬运（10 净新增 + 23 整取 + 4 三方合并零冲突），含 C1 抬界与 M5 老消费者裁剪**同批**（必须：抬界不配套裁剪会把"静默丢实例"升级成"整帧丢"）与自补黄金测试                   |
| IM 机器人（Bot Channel：27 文件 / 13830 行 + BotsDialog 2369 行）     | 开源仓库 | 源码比对 | **已跟进**（服务端能力 `ff544f2`；入站路由 `/bot/**` 默认不注册 `4896f42`+`ee491bf`+`70c3607`；桌面端 UI **ce.5**，spec `docs/development/135-bot-management-ui.md`）—— 默认关闭、用户同意后即可使用；`botDeliveryTarget` 消费链 ce.5 同批打通 | ce.5 已落地（`354d7e7`）：BotsDialog 7 文件 + 6 渠道图标 + 259 i18n 键逐字节搬运，宿主层注入 `imBot`（onEnable 打开 BotsDialog）；消费链 9 处断点按层补齐（`automationRepo` 落库测试 6 条） |
| 上游把 bundled 技能从引用面板过滤掉                                   | 开源仓库 | 源码比对 | **已跟进**                                                                                                                                                                                                                                     | 已落地（`8f5993b`，2026-09-24）—— `skill-reference-catalog.ts` 加 `.filter((skill) => skill.source !== "bundled")`；护栏见 `77001df` 的 `skillReferenceCatalogBundled.test.ts`              |
| headless `--enable-workflow` 开关                                     | 开源仓库 | 源码比对 | **部分跟进** —— 保留官方拼写，但默认值与官方相反（本仓库默认开启）                                                                                                                                                                             | 已落地（本批）—— 另加 `--no-enable-workflow`，见 `official-diff.md`                                                                                                                         |
| `/workflow` 的两处路由分支（CLI 命令中心）                            | 开源仓库 | 源码比对 | **已跟进** —— 11+8 行逐字节照搬；另两处接线 `e3e76e7`；bundled-skills 解析器随 3.14.3 跟进（task-52），**SEA 资产内嵌**（`sea-bundled-skill-assets.mjs` + 运行时按 hash 解包）2026-10-04 补齐，序 10 全部收口                                  | 已落地（2026-09-24 路由；解析器同批；SEA 内嵌 2026-10-04（`23ac2b7`））—— 回归 `bootstrap/test/bundledSkillsSea.test.ts` 7/7                                                                |

### 确认过"上游也不提供"（`不适用`）

| 条目                    | 来源     | 依据                     | 结论                                                                                                                |
| ----------------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 云端 relay              | 开源仓库 | 源码比对（全仓穷尽检索） | **不存在** —— `relayWsUrl`/`relayUrl`/`relayServer`/`cloudRelay`/`wsRelay`/`mid=` 全部 0 命中；`wss://` 仅 5 处回环 |
| 配对服务器 / 设备配对码 | 开源仓库 | 源码比对                 | **不存在** —— 有"码"但全是 IM 身份注册码，非设备配对码                                                              |
| 移动壳 / PWA / 推送     | 开源仓库 | 源码比对                 | **不存在**                                                                                                          |

> 这三条是**防止后人重复怀疑**的记录：官方开源版没有中继、没有配对服务器、没有移动壳；本仓库同样不引入中继。

## v3.14.4（来源：闭源包；开源仓库无此 tag）

> 对比依据：官方 `ZCode-3.14.4-linux-x64.deb`（2026-10-03 到手），与开源 v3.14.3 逐字节对比 ——
> node_modules 22882 文件零差异；协议 / Bot / 工作流 / 远控 / i18n（2080=2080 key）全部零差异。
> **结论：3.14.4 = 3.14.3 + 阿里云验证码健壮性补丁 + 版本号；无必须搬运的载荷。**
> 完整分析见 `.reverse/99-v3144/UPDATE-ANALYSIS.md`。本仓库以 3.14.4 为新基线，发 `3.14.4-ce.1`。

| 条目                                                                          | 来源   | 依据   | 同步情况                                                                                                                                             | 我们何时落地                                                                        |
| ----------------------------------------------------------------------------- | ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 验证码初始化超时分类（`initialization_timeout` + 官方可操作文案）             | 闭源包 | 逐字节 | **已跟进**（CE 形态：`initialization` 失败阶段 + 逐字文案；卡死与快速失败分离，用 instanceof 判定而非文案匹配）                                      | 3.14.4-ce.1（`b92773b`；spec 130「移植官方 3.14.4」G1-G5；9 条新测试）              |
| 合并 provider 配置时先剥离 `x-aliyun-captcha-verify-param` / `-verify-region` | 闭源包 | 逐字节 | **判别结案：不需要改**（四级追踪：基础 requestAuth 唯一生产者 resolveCurrent 的三条分支全部只返回 `{ apiKey }`，官方剥离针对的反馈路径在 CE 不存在） | 3.14.4-ce.1（判别落 `.reverse/99-v3144/UPDATE-ANALYSIS.md` §6 H3：未验证 → 已证实） |
| `initialization_drain`（初始化期排空排队请求）                                | 闭源包 | 逐字节 | **未跟进（有意）**：CE 的串行编排器已逐个处理排队请求、每个 requestId 必应答，无对应失效形态；造新队列是重复状态                                     | 不适用                                                                              |
| 验证码 20 分钟新鲜度守卫                                                      | 闭源包 | 逐字节 | **未跟进（有意）**：CE 按 Document 重新加载 SDK，无持久 init 状态可守卫                                                                              | 不适用                                                                              |

## 源码复核后确认的形态（防重复怀疑）

> 都是**否定式现状**：查过了、不存在或不是那样。写下来的价值就是让后人不必重新怀疑已否决的口径。

| 当前确认的形态                                             | 依据                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方开源版**保留手机远控的协议与传输层接缝、移除产品面**   | `872ad96:packages/shared/src/task-realtime-core.ts:102-103` 已有 `relay_owner`/`relay_bridge` 枚举，`desktopRemoteSessions.ts` 也在基线里；云 relay 从未进入开源版（`relayWsUrl` / `mid=` / 配对码 全仓 0 命中，见上「确认过上游也不提供」） |
| `qrcode@^1.5.4` 是**从开源基线继承的既有依赖**，面板已实现 | `packages/ui/package.json:66` 与上游逐行相同；二维码渲染见 `packages/ui/src/RemoteControlPanel.tsx`（SVG，真浏览器断言过）                                                                                                                   |
| 无头发行包**有**专门 job 构建并挂 artifact                 | `.github/workflows/release.yml` 的 `headless-server-package` job 构建、跑 smoke、挂 artifact（tag 时顺带挂 Release）；需仓库变量 `ZCODE_DIST_BASE_URL`，**未配置时跳过**                                                                     |

> 教训：**逆向时代的结论在有源码后必须回头复核**。本台账的「依据」一栏就是为了让这件事可追踪。

## v3.15.1（来源：开源仓库，2026-10-12 复核新增）

> 官方把 3.14.3→3.15.1 压成单提交 `aac4756`（11736 文件级变更，core 252 文件 +10K 行）。
> 本仓库与官方自 `872ad96`（open source）后平行演化，**整版直接合并不可行**（会覆盖 CE 线
> 全部自研：bots/远程控制/licensing/守护体系），沿用逐块评估策略。主要机制与跟进状态：

| 条目                                                                                                                                                | 官方形态                                                                                                                       | 同步情况                                         | 说明                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 记忆召回（project-memory-recall + recall/selector + prefetch）                                                                                      | 辅助模型 + 严格 JSON Schema 从 manifest 选记忆（每轮一次模型调用，prompt 防关键词误配/去重/保守选择）+ turn 级 prefetch 异步化 | 已有等价自研                                     | 本仓库 embedding 全量融合管线（余弦×0.6+词法×0.4，零模型调用，bench/memory-recall-probe 实测 hit@5 100%/33%）。官方「prefetch 异步化」「按轮限频」两个工程细节可借鉴（未跟进-待评估） |
| ApplyPatch 工具（apply-patch.ts +381）                                                                                                              | patch hunk 形态编辑（`*** Begin Patch`/`@@` 上下文行），编码/行尾保留、revision 冲突检测、失败重读指引                         | 未跟进（待评估）                                 | 本仓库 Edit 已有七级模糊匹配链；patch 形态对 GLM 的收益需 bench 实测后再定                                                                                                            |
| 工作流填洞独立 handler（fill-workflow-hole +373 / resolve +331 / settings-adjustment +200 / script-models +227 / dynamic-workflow-activation +182） | 工作流激活/填洞/模型选择拆分为独立 handler                                                                                     | 部分跟进（本仓库有同族自研 dynamic-workflow 面） | 需逐块比对功能差异                                                                                                                                                                    |
| tool-result-settlement（+283）/ turn-execution-fallback（+259）                                                                                     | 工具结算与 turn 回退执行路径重构                                                                                               | 未跟进（待评估）                                 | call-runner/permission-flow 大改（870/590 行）为本体，牵连面广                                                                                                                        |
| 记忆 dream（memory/dream.ts +239 / project-memory-dream +253）                                                                                      | 记忆整理机制                                                                                                                   | 未跟进（待评估）                                 | 与本仓库 memory 体系（extraction/directory）关系需比对                                                                                                                                |
| 子代理 profile 拆分（profile -276 / profile-frontmatter -243）                                                                                      | profile 解析重构                                                                                                               | 已随 CE 线自有实现                               | 与 CE 自研 subagent 面重叠                                                                                                                                                            |

**整版升级移植**：需要专项工程（预计天级），且必须保住 CE 线与仓库自研全部能力
（bots/远程控制/许可门禁/召回管线/工作流体系）——执行前需维护者拍板。

## v3.16.1（来源：开源仓库 main，2026-10-20 整版合并）

> 整版提交 `0a1fc56d`（Source-Commit `1f4d7f01`，未打 tag）。与 3.15.1 基线（`aac4756`）相比
> 4502 文件、+356395/-121976 行。执行了整版 merge（`upgrade/official-3.16.1` 分支，
> merge-base 即 `aac4756`，增量纯为 3.15.1→3.16.1），141 个冲突逐项裁决：
> 57 个上游主导取上游、33 个 CE 主导取我们、35 个双侧小改手工并、16 个 UD 接受上游删除
> （侧栏/任务区/WebRemoteControl 任务索引组件被上游重构移除）。

### 实质裁决（合并时定案）

| 条目                                                                       | 上游形态                                                                                                                                    | 裁决                                                                                                                | 依据                                                                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| ToolSearch/DeferredToolCall                                                | 协议级实现：mode 配置门控（auto/native/local/off）、native 走 provider 端 tool_reference + Anthropic beta header、DeferredToolCall 包装协议 | **采上游，弃 CE 预算制 deferral**（`helpers/tool-deferral.ts` 停用）                                                | 上游覆盖更完整（CE 版只解决声明面预算）；CE 当时修的「ToolSearch 泄漏进声明面导致 GLM 空搜」由上游 off 门控承接 |
| 远程控制命名族                                                             | `RemoteControl*` 全面更名 `WebRemoteControl*`（含 v2 relay 面）                                                                             | **更名以上游为准**；CE 自托管 Web 服务面（`WebService*`/连接面三条）通过 platform/globals **并集**保留              | CE 的自托管形态（桌面 spawn 服务端 + `?token` 连接）与上游云 relay 形态本就是两条线                             |
| bot×project 绑定                                                           | botsService 新增 projectService 注入与 project 关联执行                                                                                     | **未跟进（deps 收形未消费）**                                                                                       | CE bots 线以安全加固为差异化重点；上游功能待评估后单独落地                                                      |
| 上游 3.16.1 UI 重构（侧栏/任务区/composer 工具栏/chat-input-toolbar 拆分） | 组件级重构，多文件删除/新增                                                                                                                 | **跟随上游**（CE 在旧组件上的微改随删除丢弃，未发现丢失功能性 CE 特性；qimen/liuren 围栏在 ai-elements 下未受影响） | 整版跟随优于在旧组件上背维护债                                                                                  |

### 33 个取我们文件的上游侧差量

合并时以 CE 版为准的 33 个文件，其上游侧差量未丢弃：`git diff 65a77561^2 65a77561 -- <file>`
可随时取回（`65a77561` 的第二父即 `0a1fc56d`）。逐文件选择性吸收时以此为基准，不需要重跑 diff。

### 验证与格式化

- typecheck 0 错误（合并后首跑 124 错，全部为 CE 文件适配上游更名 API，已逐点修复）
- lint 0 error / fmt:check 绿（2171 个上游文件按本仓 oxfmt 配置重排，独立提交 `99062adb`）
- licenses 重生成：3.16.1 依赖树移除了 7 个 stale 登记（hash.js/saxes/https/fontkit/brotli/dfa/png-js）
- CE 接线存活扫描通过：qimen/liuren 围栏、速度药丸、bot 附件三道防护、常时比较、
  cacheHitRatio 保活观测等关键标记均在合并树上

## v3.16.2（来源：开源仓库 main，2026-10-24 整版合并）

> 整版提交 `3c5b2276`（2026-10-20 sync，**未打 tag**——上游 tags 仍只有 v3.14.3 / v3.15.1）。
> 与 v3.16.1 sync（`0a1fc56d`）相比 263 文件 +10549/-4087 行；**根依赖零变化**
> （package.json 仅版本号），licenses 无需重生成。merge-base 即 `0a1fc56d`，
> 21 个冲突逐项裁决：

| 条目                                                                           | 上游形态                                                                                          | 裁决                                                                                                                                                                                                                      | 依据                                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 「在分屏打开」入口下线                                                         | `splitPaneEntryContext` 只留拖拽闸门（2026-10-16 上游产品决定），TaskListItem 菜单项/文档同步收口 | **跟随上游下线**。该功能是上游的而非 CE 自研（文件自开源基线起只由上游提交），CE 无增量可保                                                                                                                               | `docs/v4-split-pane-workbench.md` 已改记「入口已全部下线」；既有拆分布局仍按原文档渲染、不做迁移   |
| 任务项反馈入口（TaskListItem）                                                 | 直连反馈中心 draft（`openFeedbackSubmit` + 官方工单字段 type/module/severity）                    | **保留 CE 渠道化反馈**（`useFeedbackEntryAction`：GitHub Issues 默认/自定义/关闭三态），在上游新版文件上重植 CE 版 handler                                                                                                | CE README「社区反馈」差异项；官方工单链路对社区版不可达是该改造的动因（hook 头注释）               |
| composer 工具栏 fit（`useComposerToolbarFit`）                                 | 重写：新增 `iconOnly` 模式 + priority 阶梯                                                        | **跟随上游**。CE 侧无自研差异（COLLAPSE_STEPS 阶梯本就来自官方 3.14.1，82259218）                                                                                                                                         | 上游契约测试 composer-toolbar-layout 全绿                                                          |
| Bash 执行适配器生命周期                                                        | `node-execution-adapter-run/lifecycle` 关闭/退出语义强化（+147 行，测试 +259）                    | 整体跟进                                                                                                                                                                                                                  | —                                                                                                  |
| workflow 并发治理 + 协议 transport/plugins                                     | `workflow-concurrency-governor`、`zcode-protocol` plugins/transport 小改                          | 整体跟进（自动合并）                                                                                                                                                                                                      | —                                                                                                  |
| e2e 性能复现三件套（conversation-session-runtime-communication-performance）   | 上游删除（official/main 全树零痕迹）                                                              | **接受上游删除**（CE 侧仅 fmt 动过）；同批删除失去源文件的上游指针测试 workbenchPointerPositionTracker                                                                                                                    | —                                                                                                  |
| 台账三件（upstream-snapshot.json / third-party inventory / policy exceptions） | 双侧演化                                                                                          | snapshot 键集并集 + **全部 pin 按合并树重锚**（files/historicalFiles 语义=当前树 blob，5+5 个不在树上的历史 pin 原样保留）；inventory 双侧条目并集；policy 保留 CE v3.16.1 豁免 + 并入上游 side-pane-full-view 快捷键豁免 | 架构检查过（仅剩 spec 151 LSP WIP 未跟踪文件违规，非本合并引入）                                   |
| README 更新日志                                                                | 加 v3.16.1 / v3.16.2 两行                                                                         | 取 CE 版（CE README 无「更新」节，发版信息走 release-notes；上游版本史由本台账承载）                                                                                                                                      | —                                                                                                  |
| **补 3.16.1 遗漏：`docs/knip` 第三方登记**                                     | 上游把 knip 文档站镜像（ISC）与内置字体（OFL/MIT）作为 copied components 登记，随 3.16.1 文件进树 | **补登记**：4 个 knip 组件条目移植进 `third-party/copied-components.json`，notices/inventory 重生成（22 组件 / 3312 输入）。3.16.1 合并时该文件取了 CE 侧导致登记丢失，文件裸奔 4 天，本轮 licenses:freshness 暴露后修复  | 搬运必须连许可一起登记（根 AGENTS.md「能力来源与取舍」）；这也是 licenses:freshness 护栏存在的意义 |

### 验证

- typecheck 0 错误（首轮 3 错全部源于 TaskListItem 初次裁决保留了已下线的分屏入口调用，重裁决后清零）
- lint 0 error；fmt:check 合并文件全绿（8 个失格文件均属未提交的 NSIS WIP，非本合并引入）
- CE 接线存活扫描：九项重植台账的 zcode-cli 侧接线文件集与合并前逐文件一致（唯一交集
  `server-operations.ts` 为上游 subagent 会话种类收形，CE adaptiveReasoning 标记 7 处完好）；
  品牌（BCode-CE / BES 图标）、qimen/liuren 围栏、速度药丸、遥测总开关、workspace-registry
  护栏全部在位
- 单测：ui 目标套件（composer-toolbar-layout / savedWorkflowsSection / v4WorkspaceDraftPane）绿；
  adaptiveReasoningWiring 2 例、dangerousCommandPolicyWiring 1 例为**既有红**（其期望的源码标记
  `withAutoThoughtLevelOption` / `adaptiveReasoningEnabled` / `dangerousCommandPolicy` 在合并前的
  ca7c2edc 即已不存在，非本合并引入）；shared 的 zcodeProtocol.test「parses CE side-effect
  capability keys」同属既有红（`sideEffectScope`/`readOnly` 在合并前后都不在
  `packages/shared/src` 的 schema 里，与上方台账「captcha-retry 枚举收窄需另开工单」同族）
- 全量套件（2134 文件 / 17 包，跑在**含未提交 WIP** 的工作树）：41 文件失败，逐项分诊：
  环境类（本机 `node_modules/electron` 安装损坏，webRemoteControl/serverRemote 等拉起
  Electron 的用例全部因此挂，报错自身即要求重装；依赖重装后需复验）；WIP 类
  （nsis-install-section-patch 属未提交的 NSIS 工作）；**3.16.1 合并二次冲掉的 CE 接线**
  （adaptiveReasoningWiring / dangerousCommandPolicyWiring / toolCallBlocks 的
  ToolRunningProgressProvider 挂载——护栏红即是断线信号，已按下方 2026-10-24 节重植）；
  既有红类——品牌提交把 RootStartupLoading 内联 SVG 换成 BCode 位图后测试仍断言 `<svg`；
  3.16.1 fmt 提交（99062adb）把 conversation-session-docker-automation-plan.md 表格对齐后
  打断骨架逐字节断言（该骨架是 E2E 登记脚本的运行时消费点，已恢复骨架并豁免 oxfmt）；
  userActionTraceCatalog 计数护栏 16→17（149 批四b `settings.telemetry` 入册未同步计数）；
  **待专项复诊**——上游「新代码+新测试」对在本机红（serviceManager 管道超时探针、
  zcodeTaskIndexSyncer 索引清理、remoteAssetRelease 归档拷贝数）与 bots×project 绑定的
  上游测试（该功能台账登记为未跟进，测试随 3.16.1 进树即红：吸收功能或隔离测试待裁决）；
  serverInfoHttp / staticRoutePathContainment 为既有红（http.ts 合并前后仅 fmt 差异）
- **修复一项 3.16.1 合并遗留**：上游 `0a1fc56d` 为根 package.json 新增的
  `prepare:remote-assets:linux` 脚本在 3.16.1 合并整取 CE 版时丢失，配套
  stageRemoteAssetsCli「wires the root Linux command」用例随之红了 4 天；本轮补回脚本，
  用例 8/8 绿，licenses 链路同步重生成

## CE 接线重植台账（apps/zcode-cli 九项断线，2026-10-18 处置）

> 背景：3.15.1 merge 官方整版覆盖部分既有文件，把「CE 新文件在既有文件里的引用接线」冲掉
> （CE 净新增文件全部幸存）。下表为逐项判定与处置；判定口径 = `origin/main` 与 `HEAD`
> 各自 `git grep -l <基名>` 的引用文件差 + 升级历史（`origin/main..HEAD`）区分「冲掉」与「已重做」。

| CE 能力（文件基名）                                                     | 判定        | 处置与依据                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| adaptive-reasoning（core/src/model/）                                   | 冲掉        | 已重植：model.ts 的 import + 降档解析块 + generateText/streamText 改走 requestWithOptions（aac47556 整版覆盖 model.ts，30bfcee1 重建时漏）                                                                                                                                                                                            |
| cache-stability（core/src/model/）                                      | 冲掉        | 已重植：model.ts 的 trackProviderRequestStabilityForRuntime 接线 + 变异 info 日志（同上）                                                                                                                                                                                                                                             |
| sanitize-surrogates（core/src/model/）                                  | 冲掉        | 已重植：model.ts 三处（text_delta/reasoning_delta/最终 text）+ task-output-bash.ts 读文件内容消毒（两文件均被官方版覆盖）                                                                                                                                                                                                             |
| cache-keep-alive（core/src/runtime/methods/）                           | 冲掉        | 已重植：methods/index.ts 补 proto 绑定 + turn.ts 补 turn 起止的 cancel/schedule。internal.ts 的接口声明已在（5abb5886），但绑定与调用点缺失=死接口。注意 main 的 `= sendCacheKeepAliveRequestImpl` 直赋是潜在 bug（impl 首参 runtime、接口无参调用会传 undefined），重植时改为 this 透传包裹                                          |
| captcha-retry（adapters/src/model/）                                    | 误报·链外断 | apps/zcode-cli 内 5→5 无变化（import/instantiate/isCaptchaRejection 全在，b9a534ce 已重植转发链）。真实断点在写权限外：`packages/shared/src/request-security-edition/verification-policy.ts` 的 `requestVerificationReasons` 丢 `"captcha-retry"`，zcode-protocol 枚举随之收窄——需另开工单修复                                        |
| entrypoint-candidates（bootstrap/src/app/）                             | 冲掉        | 已重植：bundled-plugins.ts 删官方自带的本地 candidateBaseDirs 副本、改走共用枚举器（b3e64c22 的统一被 a44830f1 取官方版时回退；两实现当前逐行同义，不重植则未来调整候选目录时静默分叉）                                                                                                                                               |
| memory-recall-reminder（core/src/runtime/methods/）                     | 冲掉        | 已重植：turn-loop.ts 的 memory_recall 注入块 + source.ts 注册 + 护栏扩展（1b16b518 重植五层时漏了这层；官方 semantic-recall 分支被关在 default-index，此链是唯一动态记忆召回）。tests/system-reminder-source.test.ts（官方契约测试，钉死了无 CE 源的清单，且不被 run-tests.mjs 执行）随之保持红——与 1b16b518 时同款既有红，非本次引入 |
| get-context-remaining（contracts/src/tools/ + core/src/tool/handlers/） | 冲掉        | 已重植：handlers/index.ts 补 import + builtInTools 条目（01908867 在官方底座上重建该文件时漏；f41088b0 是 origin/main 侧原始提交，非升级分支重做）。contracts 侧 barrel 一直在场                                                                                                                                                      |
| replay-order（dynamic-workflow/src/engine/）                            | 已重做      | 不恢复：engine.ts 持有 replaySettleOrder、新 engine-resume.ts 承接 recoverSettleOrder、scheduler 经 host.holdForReplay 释放，全链在位；「减少的引用」只是 scheduler\*.ts 的注释指针从 replay-order.ts 改指 docs/execution-engine.md。回归 replayOrderResume 3/3 + replay-settle-order 12/12 绿                                        |

### 自适应思考的 UI / 设置链路（2026-10-18 补）

上表第 111 行只重植了 core 路由；`adaptiveReasoningEnabled` 的 UI → services → 协议 → bootstrap
链路仍被 3.15.1 覆盖冲掉（`thoughtLevelOptions` 的 auto helper 失去调用方、services 不读 App 设置、
bootstrap 不写 runtimeConfig），用户侧表现为「自动档消失、设置不生效」。已回植并用
`packages/ui/test/adaptiveReasoningWiring.test.ts` 钉死六个消费点；细节见
`docs/development/142-adaptive-reasoning-restore.md`。

同一形态的断线还有工具策略：`AppSettings.dangerousCommandPolicy` 可保存但无人读取，
`ToolExecutorDeps.dangerousCommandPolicy` 是死字段。已按同一链路回植并加
`dangerousCommandPolicyWiring.test.ts`，见 `docs/development/143-dangerous-command-policy-wiring.md`。

### 工作区注册表 RPC 接线（2026-10-18 补）

`4f7c1a3b`（3.15.1 升级 2b·1）把 `packages/services/src/node.ts` 与
`packages/client/src/remoteServiceAccess.ts` 整文件取官方版，官方版没有 CE 的工作区注册表：
Local Host 不注册 `IWorkspaceRegistryService`，RPC 客户端也没有 `workspaceRegistryService`
proxy。运行日志实测 `Unknown channel: workspace-registry` → 侧栏
「工作区列表读取失败：Channel name 'workspace-registry' timed out after 1000ms」。
已恢复服务注册与客户端出口，`workspaceRegistryWiring.test.ts` 增加两段源码护栏；
接线说明同步到 `docs/development/workspace-registry.md`。

### UI/设置三链路二次断线重植（2026-10-24 处置）

> 3.16.1 merge（65a77561）把 spec 141/142/143 已回植的三条 packages/ui、shared、services 侧
> 链路**再次**冲掉（apps/zcode-cli 侧的协议/bootstrap/core 段幸存，所以 typecheck 全绿、
> 只有护栏测试红——这正是护栏存在的意义）。三条同根因：整文件取上游版时，
> 「CE 功能在既有文件里的接线」无冲突标记地丢失。

| 链路                                              | 用户侧表现                                                | 重植内容                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 141 运行中工具进度（ToolRunningProgressProvider） | 「已等待 Ns」消失、pending 工具也画进度条                 | `ToolCallBlocks.tsx` 重挂 provider（上游覆盖该文件时挂载丢失；context/Layout/Indicator 本体幸存）                                                                                                                                                                                          |
| 142 自适应思考档（adaptiveReasoningEnabled）      | 思考档选择器「自动」档消失；App 设置不再到达 session 偏好 | `thoughtLevelOptions.ts` 重加 withAutoThoughtLevelOption 三导出 + `thoughtLevelLabels.ts` 补 auto 词条 + `V4ComposerToolbar.tsx` 接线（适配上游重构后的 thought picker）+ `validationAppSettings.ts` 双段 schema + `protocol.ts` AppSettings 类型 + `services/node.ts` 读取行；i18n 键幸存 |
| 143 危险命令策略（dangerousCommandPolicy）        | 设置页保存的策略不再进入 Bash 审批链                      | `services/node.ts` 读取行 + `protocol.ts` AppSettings 类型（协议/bootstrap/core 段幸存）                                                                                                                                                                                                   |

验收：三道护栏 + thoughtLevelOptions + composer-toolbar-layout + toolCallBlocks 共 148 项全绿；
typecheck 0 错。教训入册：**每次整版合并后必须跑全部 wiring 护栏**（三道护栏当时都红，
但被误读为「标记从未存在」——用 `git log -S` 追添加/丢失历史即可避免误判）。

## v3.17.1（来源：开源仓库 main，2026-10-30 侦察完成，**未合并**）

> 整版提交 `a60ba6a7`（2026-10-30「chore: sync ZCode source」，**首次给 sync 打 tag `v3.17.1`**）。
> merge-base `3c5b227`（v3.16.2 已合并）。**表面 300 文件 +12.5K/-2.2K 是 GitHub compare API 的截断视图**
> （files[] 上限 300）；本地 `git diff --diff-filter=D` 复核真实差量：**删除 2070 + 新增 1007**。

### 真实形态：上游测试架构大迁移

- **删除 2070**：`packages/ui/test`(1057) / `packages/desktop/test`(300) / `packages/services/test`(288) /
  `packages/shared/test`(148) / `server`/`zcode-server-cli`/`client`/`web`(合计 ~85) 等——**旧 Vitest 单测面被整体撤除**。
- **新增 1007**：`packages/ui/test/browser/manual-review/pending/*`（browser 测试新形态，与本仓
  `packages/desktop/test/e2e/conversation-session/manual-review/pending/` 同源同构）、
  `apps/zcode-cli/packages/*/tests`（adapters/git-snapshot-hardening、mcp-node-fallback、
  provider-builtin-tool-compat 等新能力测试）、`packages/desktop/test/e2e/*`(365, 上游吸收了与 CE 平行的 E2E 体系)。
- 上游删除清单里混有 **CE 自研测试**（spec 155 toolCallProgressBytes、memoryService、zcodeProtocol CE keys 等）
  ——合并时**不能盲目接受上游删除**，须逐目录甄别 CE 特有测试并保留/迁移。

### 功能面（合并时的新能力入口）

| 域                                                   | 入口                                                                        | 备注                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| MCP node-fallback                                    | `adapters/src/mcp/node-fallback.ts` + `docs/design/v2/mcp-node-fallback.md` | 新设计文档                                                                           |
| provider-builtin-tool-compat                         | `adapters/src/model/provider-builtin-tool-compat/`（contract/module 形态）  | 模型内置工具兼容层，与 CE provider 线同域                                            |
| session-data-files                                   | `adapters/src/storage/session-data-files/`（contract 形态）                 | 会话数据文件新仓储                                                                   |
| session-features-header                              | `docs/design/v2/model/session-features-header.md`                           | 模型请求新 header                                                                    |
| node-repl-call-ledger                                | `docs/design/v2/tool/20-node-repl-call-ledger.md`                           | 与 CE Codemode 线（spec 158）同域，合并时对照                                        |
| git-snapshot                                         | `adapters/src/context/git-snapshot.ts` +363                                 | 快照能力扩充                                                                         |
| session-store schema                                 | `schema.baseline.sql` +548 / `repositories/sessions.ts` +191                | **按 session-management skill 纪律处理**（migration 四处同步/逐表哈希单测/只加不删） |
| session-lifecycle / workspace-mcp-trust / local-ttft | `bootstrap/src/` 多目录 contract 形态                                       | 合并时重点对照 CE 的 server.ts/session-facade 接线                                   |

### 合并裁决预演（2026-10-30 试合并后回退，结论保留）

试合并 `git merge official/main`：505 冲突（189 UU + 304 UD + 12 其他）。304 个 UD 的主体是
「上游删除的旧测试」——但**不能批量接受**：需先按目录甄别 CE 特有测试（甄别清单见上）。
预计裁决量与 3.16.1 合并（141 冲突）同量级或更大，且 304 个 UD 需要的甄别工作量是新增项。
**执行建议：单开专注会话做，先跑 `git diff --diff-filter=D 3c5b227 official/main` 生成甄别清单，
再分类：CE 特有测试保留 / 上游迁移的跟随新形态 / 两边都有的取上游新形态。**
回退时 `git merge --abort` 已验证干净（工作区恢复 c43aee09）。
