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
| 上游开源仓库最新 tag                 | `v3.14.3` = `29628c9`（**开源仓库只有这一个 tag，2026-10-04 复核**）                                                                                                                       | 2026-10-04      |
| 上游 feature 分支                    | `feat/ui-plugin` = `662c30b`（2026-09-29，UI plugins + Gen UI，426 文件 / +55671 行，**未发版**；新增带 patch 的 `@open-pencil/core@0.14.0`）—— **未跟进**（未发版分支，等进 main 再评估） | 2026-10-04 复核 |
| 上游闭源发行包                       | `ZCode-3.14.4-linux-x64.deb` —— 逐字节对比 = 3.14.3 + 阿里云验证码健壮性补丁 + 版本号                                                                                                      | 2026-10-03 到手 |
| 我们领先 / 落后                      | 落后 1 提交（上游把整版压成一个提交；main 无新提交，fetch 复核）；领先数 **未复算**（本机无 upstream 远程，最后一次复算 2026-09-24 得 164，此后本仓库新增提交未计入）                      | 2026-10-04      |

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
