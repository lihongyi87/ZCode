# 149 · 飞鱼能力吸收:任务互发 steer 化 + proactive 深度护栏(总纲)

## 背景与决策

[飞鱼版](https://github.com/showjiangnan/zcode-feiyu)是基于同一上游基线 v3.14.3(`29628c9`)的兄弟
二开仓。经源码对照(2026-10-21),其中六项能力值得吸收;用户裁决:**重写式引入,不拷文件**
——飞鱼是 3.14.3 基线,本仓是 3.16.1 整版合并线,直接拷文件会在下次整版升级时被冲掉
(138 spec 的速度药丸教训)。吸收以本仓现状重新实现,新代码落入既有 managed 模块,
保持对官方的快速合并能力。

本 spec 是总纲:登记六项路线图与状态;每批开工时在本文件补该批契约,实现完成后更新状态表。

## 纪律

- 主线基于官方;本 spec 下所有改动必须可通过 `git merge official/main` 存活:
  不改上游文件的既有行,新增逻辑走新文件或在既有接缝(端口/事件/枚举)上 additive 扩展。
- 每批独立提交单元;`pnpm typecheck`、`pnpm lint`、受影响单测、`pnpm architecture:check --changed` 全绿才提交。

## 批次路线图与状态

| 批  | 内容                                                                          | 状态                                                                                     | 落点                                       |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------ |
| 一  | A 任务互发 steer 化 + B proactive 深度护栏                                    | **完成**(信封/护栏/发送链/可见性/跨机接收侧;仅剩无消费者的跨 host 发起侧 API,待消费场景) | contracts/adapters/core/services/shared/ui |
| 二  | C 图片生成作业链(provider 抽象首接 Minimax,fal 留扩展位;子代理费用门控默认关) | 未开工                                                                                   | core/tool、services                        |
| 三  | D 记忆修订保护(游标持久化+写租约+history/diff 撤销)                           | **D1 游标持久化 + D2 写租约已落地**(见批三实现状态);history/diff+撤销未开工              | core/memory、adapters/storage              |
| 四  | E 遥测统一总开关                                                              | **完成**(后端四出口门 + 通用设置分区 UI 开关 zh/en + 对抗审查修复)                       | shared、services、desktop、ui              |
| 五  | F 会话导入泛化(来源枚举+附件保留+导入会话只读边界)                            | 未开工                                                                                   | services、shared                           |

## 批三实现状态(2026-10-21)

**D1 提取游标持久化(已落地,commit 82af04bf)**:提取调度器的游标此前是进程内闭包变量,
重启即丢——进度回退到「从头判断」,既可能漏也可能重。现以文件式游标落**项目记忆根**
(`.extraction-cursor.json`,与被治理记忆同域、按项目天然隔离):

- 契约:`MemoryExtractionCursorStore{load,save}`(extraction.ts 工厂 options);播种在首个
  snapshot 前异步完成;save 失败只丢持久化(重启可能重复提取一小段,提取幂等),绝不影响
  内存推进;坏文件/缺席=从头,不阻塞调度。
- helper 经 runtime.fileSystemPort 实现(atomic 写);CLI 重启窗口语义见测试 3 用例。
- **决策修订(替代原 migration 0023 计划)**:持久化才是目的;游标与项目记忆同生命周期、
  单写者(每项目一个调度器)、无需跨键查询,文件方案避开 SQLite schema/checksum 风险面。
  未来若需进程间严格互斥再评估升级。
- 测试:memory-extraction.test.ts 20/20(新增 3)。

**D2 写租约(已落地,commit 06cf1db2)**:记忆 .md 是跨会话共享资产(同 workspace 多窗口、
提取子代理),写前查他方新鲜租约(120s TTL)——持有人活跃即拒写(`memory_write_lease_conflict`,
可恢复,带持有人 sessionId 与持有时长);同会话重入不拒;过期=重入。租约文件 `<file>.lease`
不入 manifest(glob 只认 .md)。实现并入 `memory/origin-session.ts`(记忆写协调职责,规避
unmanaged-new-file);write/edit 两 handler 的 writeTextFile 包 acquire→try→finally release。
建议性租约:最后写入冲突仍由 expectedRevision(stale_write)兜底,TTL 兜底崩溃残留。
测试 4 用例(non-memory no-op/获取释放/他方新鲜拒写带持有人/过期与本会话重入)。

**顺带修复推送分支上既有的坏测试**:`memory-origin-session.test.ts` 的 Edit 边界用例自
3.16.1 合并后就红——editHandler 强制先读后改(缺 readFileState 被映射为「File does not
exist」)且 win32 路径归一使 POSIX 假路径键失配。已修:workspace 用 win32 形态覆盖记忆根 +
补 createReadFileState 夹具(复刻 edit-tool-contract 的本地夹具)。同病的 edit-tool-contract
两条(missing-file/deny-rules)经 stash 对照证实 HEAD 上同样红(疑 Linux 绿/Windows 红),
登记不修、留待拥有者处置。

**剩余(批三c)**:history/diff 留档与撤销入口。

## 批四实现状态(2026-10-21)

`telemetryEnabled`(AppSettings,缺省 true=现行为不变)为总闸,四出口门:

1. **Agent OTLP**:`node.ts resolveSpawnEnv` 注入 `ZCODE_MODEL_TELEMETRY_ENABLED=false`
   (CLI telemetry bootstrap 认此 env);改设置后下次 agent spawn 生效。
2. **数仓上报**:`telemetryCore` 新增 `enabled?` 依赖,在 `trackReport` 单点闸
   (app_launch/app_daily_active/reportEvent 三路径唯一汇点)——关闸跳过上报且不触碰
   状态锁/去重账本;main 装配点传 `readTelemetryEnabledFromSettings()`。
3. **ARMS RUM**:`appARMSBootstrap` 的 `enable` 加 settings 文件门。
4. **桌面 OTLP(TTFT/trace)**:main 装配点关闸时传空 env(exporter 因无 endpoint 不启动)。

`readTelemetryEnabledFromSettings()`(appARMSBootstrap 导出,main 复用):启动时读
`~/.zcode/v2/setting.json` 一次,文件缺席/损坏/键缺席=启用(总闸只允许显式关闭);
运行中改设置重启生效(与 spawn env 同语义,已注释登记)。

UI 开关(批四b,已接):放「通用设置」分区(不放「反馈与诊断」——该分区头注释登记了
用户已确认方向「遥测状态只读展示,本分区不提供开启入口」,不推翻)。链:SettingsPage
state+同步+handleTelemetryEnabledChange(updateSharedSettings)→ GeneralSectionContent
Switch 行 → i18n(settings.telemetry[Description],zh/en)。userActionTraceCatalog 的
SETTINGS_USER_ACTION_FEATURES 登记 "settings.telemetry": ["toggle_telemetry"](featureId
是闭合 catalog,keyof 推导,漏登记会 typecheck 报错)。另注:packages/ui 无自身测试脚本,
混合 runner 是根 run-tests.mjs,node:test 文件在 npx vitest 下会误报无套件。

## 批一实现状态(2026-10-21)

已落地(commit ② 信封契约+护栏;commit ③ 发送链):

- **信封 v2**:`session-mailbox.port.ts` 加可选 `sourceType/sourceCommandId/depth/senderLabel` +
  `SessionMailboxPort.append`(适配器生成 messageId/createdAt,tmp+rename 原子落盘,文件名毫秒前缀保序)
  - `drainUnread` 的 `filter` 谓词(limit 只计命中,非命中留在 unread)+ `isWakeableTaskMessage`
    纯函数(信任锚三件套齐全且 depth≤上限)。可选字段类型非法→解析失败走既有死信语义(整批拒绝,
    与 JSON.parse 损坏同路径);旧格式照常解析。测试 5/5(adapters/tests/session-mailbox.test.ts)。
- **消费端护栏**:`core/hooks/session-mailbox.ts` 按 hook 事件选择性 drain——PostToolUse(忙 steer)
  与 Stop(唤醒)只取可唤醒信封;UserPromptSubmit(人驱动)全量交付。深度上限常量
  `MAX_TASK_MESSAGE_WAKE_DEPTH=4`。注入 XML 携带 `sender_label/depth/source_type` 属性。
- **steer 来源**:`TurnSteerSource` 闭集加 `"task_message"`;runtime-tools 把 hook 透传的
  steerSource 传给 `steerTurn({source})`。
- **发送链(commit ③)**:SendMessage 工具此前"有壳无芯"(`subagentPort.sendMessage` 无实现,
  `includeSendMessage` 恒 false,工具从不注册)。现补齐:runner `sendMessageToLocalAgent` 对
  非本地 agent 的 `sess_*` 目标路由到 `sendTaskMessage` 桥;桥(`methods/subagent.ts`)写目标
  会话信箱(`sourceType:"task"`,depth=当前 turn 唤醒深度+1,人驱动 turn=0),返回
  `delivery:"queued"`;忙/闲注入由目标会话自身 drain hook 承担(涌现语义,发送方不判断忙闲)。
  唤醒深度状态在 runtime-tools 的 steer 成功路径记录(`recordTaskMessageWakeDepth`,turnId 绑定)。
  测试 2/2(core/tests/task-message-send.test.ts)。**SendMessage 跨会话投递自此可用。**
- **跨机接收侧(commit ⑤)**:`deliverSessionMessage` 从 unsupported 占位转正——把信封原子
  写进本机目标会话信箱(根目录 `ZCODE_MAILBOX_ROOT ?? ~/.zcode/mailbox`,与 CLI 同构;文件名
  带 messageId,重复投递原子覆盖不双份)。请求契约(shared + services 两侧)加可选来源字段
  (sourceType/sourceCommandId/depth/senderLabel,sourceCommandId 兜底取 requestId)。
  实现走结构性同构而非引入 CLI adapters 依赖(services 不依赖 apps 侧包,分层方向保持)。
  发起侧(跨 host 的 agent 主动发送事件)仍无消费者——UI/agent 的本地互发走信箱直写,已闭环。
- **来源可见性(commit ④)**:`TaskMessageOriginMeta`(contracts)贯穿 steer 全管道——
  `TurnSteerInput/PendingSteerInputInfo/PendingTurnInput/TurnSteerDrained.drainedInputs` 平行可选
  字段 `taskMessageOrigin`(不经 `TurnInputIntentMetadata`:那是完整准入元数据,必填
  sourceCommandId/queueItemId/clientId/kind/admissionSeq 等,hook 无法构造,首次尝试已回退)。
  投影在 userInput 行落 `originMeta.senderSessionId/senderLabel`(行保持 origin=realUser+guided,
  不动 origin 枚举);UI 来源徽标「来自任务 {name} 的自动消息」(zh-CN/en-US)。

已定设计决策(接线时照此执行):

- **信箱=同进程跨会话传输**(commit ③ 已按此实现)。同机跨 workspace 也走文件信箱
  (信箱根是机器级 `~/.zcode/mailbox`,不随 workspace 分)。跨机器(远程 workspace)才走
  `workspace_session_message_send_requested` 事件链——host 监听/总线/host 入口现成,差
  `deliverSessionMessage` 实现与请求契约的来源字段扩展,为后续单元;当前该 stub 无调用方
  (无 emitter),不影响同机路径。
- **depth 状态以 turnId 绑定,宁可少计不可多计**:guide steer 注入与当前 turn 同 id 可计;
  Stop 唤醒产生的新 turn 计 0(链深被低估,护栏只会更保守)。状态并入 runtime-tools.ts
  (避免 core/src/runtime 下新文件触发 unmanaged-new-file)。
- **senderLabel 现缺发送方任务名**(桥暂不感知自身任务展示名),UI 回退显示 fromSessionId;
  补任务名需桥接侧读任务元数据,随跨机单元一起做。

已知降级边界:CLI 重启窗口内已入队未 drain 的任务消息会丢来源标识(快照队列未含
taskMessageOrigin,旧事件回退路径无徽标)——可接受,不为此扩快照 schema。

对抗审查补充(2026-10-21,第二批):

- **steer 拒绝即消息已消费**(既有行为,非本批回归):PostToolUse 路径先 drain(消费即归档)
  再 steerTurn,被拒(no_active_turn/expected mismatch)只打日志,消息不回 unread。护栏使
  拒绝概率极低(PostToolUse 必在活跃 turn 内),但严格语义是「至多一次」。回退未做:需要
  drain 两阶段(peek→ack),待真实丢消息案例再立项。
- **ARMS 直调出口未闸**:desktopMcpTelemetry/desktopStabilityTelemetry 直接调
  armsRum.sendCustom/sendEvent,绕过 init(enable)。总闸对它们是否生效取决于 ARMS SDK
  在 disabled 下的行为(init 不启动则 send 为 no-op)——未验证,列为批四验收项:抓包确认
  关闸后无 ARMS 外发;若 SDK 仍外发,在两文件调用点补同闸。
- **链路级测试补齐**:hook 管道测试(core/tests/session-mailbox-hook.test.ts,2 用例)——
  append→hook drain→Stop 唤醒门(无锚信封留存等人)/PostToolUse steer 元数据
  (source/wakeDepth/fromSessionId)/深度超限不 steer 但人驱动可读。此前只有组件级单测,
  本测试补上组件间接缝。
- **UI 徽标加 origin 限定**(防误标):徽标条件加 origin==="realUser"——originMeta 的
  senderSessionId 字段 backgroundResult 行 schema 上也允许,防御性隔离。
- **遥测闸改启动快照**:enabled 闭包原实现每条上报同步读盘一次,违背「启动读一次」设计;
  改为进程生命周期读盘一次的常量快照,并先于 createTelemetryCore 定义。

不做:ChatGPT 订阅模型接入(逆向订阅,与本仓许可合规取向冲突)。

## 批一契约:A 任务互发 steer 化 + B 深度护栏

### 现状依据(2026-10-21 快照)

已铺好、直接复用:`taskRealtimeBus` 路由(`packages/desktop/src/main/taskRealtimeBus.ts:927-1006`,
requestId 幂等+超时)、host 接收点(`packages/desktop/src/host/index.ts:3202-3239`)、
steer 管线(`apps/zcode-cli/packages/core/src/runtime/methods/steering.ts`、忙时路由
`methods/prompt-admission.ts:52-101`)、mailbox drain hook(`core/hooks/session-mailbox.ts`,
PostToolUse→`steerTurn({delivery:"guide"})`、Stop→`continue:true` 唤醒)、V4 行来源字段
(`packages/shared/src/zcode-protocol-v4/rows.ts:126-159`)、UI 来源徽标插槽
(`packages/ui/src/v4/ConversationRowView.tsx:1407-1426`)。

缺口(本批补齐):mailbox **无任何写入方**(`deliverSessionMessage` 在
`packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:2101-2108` 是 `unsupported()` 占位;
`SessionMessageSendRequested` 事件类型在 `packages/shared/src/zcode-task-types.ts:218-230` 已定义但无
emitter);envelope 无来源/深度字段;`TurnSteerSource` 闭集无任务消息来源;投影与 UI 无
task_message 分支。

### 信封契约(envelope v2,additive)

权威定义:`apps/zcode-cli/packages/contracts/src/interfaces/session-mailbox.port.ts`。
在现有 6 字段(version/messageId/fromSessionId/toSessionId/content/createdAt)上增加**可选**字段,
`version` 保持 1:

- `sourceType?: "task" | "automation" | "offpeak"` —— 来源类别;
- `sourceCommandId?: string` —— 触发本次发送的命令锚点(信任锚,见护栏规则);
- `depth?: number` —— 唤醒链深度,人/自动化发起=0,任务消息触发的再发送=N+1;
- `senderLabel?: string` —— 发送方展示名(任务名),供 UI 徽标。

`parseEnvelope`(`apps/zcode-cli/packages/adapters/src/mailbox/index.ts:67-80`)补可选字段类型校验:
字段在场但类型非法 → 解析失败(按既有死信语义处理);缺席 → 照常解析。**旧格式信封必须照常解析**。

### 交付链与状态所有者

```
A 会话(zcodeTaskService.deliverSessionMessage)
  → services adapter 发 workspace_session_message_send_requested(含 requestId/来源字段)
  → desktop taskRealtimeBus 按 sessionRoutes 路由(requestId 幂等,既有)
  → 目标 host 入口(既有)→ 目标 CLI → SessionMailboxPort.write 写 unread
  → 目标忙:下一工具批次边界 PostToolUse drain → steerTurn(delivery:"guide", intent.source="task_message")
  → 目标闲:Stop hook drain → continue:true 唤醒(受深度护栏约束)
```

- **发送侧所有者**:services adapter(发事件,不落盘);
- **投递所有者**:desktop taskRealtimeBus(幂等去重,requestId 重复投递不双写);
- **落盘所有者**:目标 CLI 的 SessionMailboxPort(unread 目录,一次性 JSON envelope);
- **消费所有者**:core mailbox hook(drain 后移 read,消费即归档);
- **忙时 steer 优先是涌现语义**:不新建路由判断——忙会话靠既有 PostToolUse drain+guide steer,
  闲会话靠既有 Stop 唤醒。

### 深度护栏规则(B)

1. **深度计算**:写入方递增——本 turn 自身是被 depth=N 的任务消息唤醒/注入时,外发消息
   depth=N+1;否则 depth=0。本 turn 的唤醒深度由 runtime 会话状态记录(mailbox drain 注入时写入)。
2. **唤醒上限**:`depth > MAX_TASK_MESSAGE_WAKE_DEPTH`(常量,首版 4)的消息照常投递、照常可读,
   但消费端**不唤醒不 steer**(不产生 continue:true,不入 guide steer)——等人来。
3. **信任锚点**(飞鱼规则复刻):缺 `sourceCommandId` 或缺 `depth` 的信封(旧格式/来源不明)
   可读,**永不**作为 proactive 唤醒依据。
4. 远程工作区:mailbox 是本机文件信箱,天然不跨机,不需要额外排除规则。

### 来源可见性

- `TurnSteerSource` 闭集(`apps/zcode-cli/packages/contracts/src/interfaces/session.port.ts:283`)
  增加 `"task_message"`;mailbox hook 的 steer 注入携带该 intent。
- V4 `userInput.origin` 枚举(`packages/shared/src/zcode-protocol-v4/rows.ts:130`)增加
  `"task_message"`(不复用被 subagent 子回复占用的 `"mailbox"`);投影填充
  `originMeta.senderSessionId/senderLabel`。
- UI:`ConversationRowView` 来源插槽增加 task_message 分支,渲染
  「来自任务 {senderLabel} 的自动消息」(zh-CN/en-US i18n);不推断,只消费协议行字段。

### 验收场景

| 场景                   | 期望                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| A 向忙的 B 发消息      | B 下一工具批次边界以 guide steer 注入,气泡带「来自任务 X」徽标,V4 行 origin=task_message |
| A 向闲的 B 发消息      | B Stop 唤醒,消息进入上下文                                                               |
| requestId 重复投递     | 总线幂等,目标 mailbox 不双写                                                             |
| depth=5 的消息到达     | 投递成功、可读,但不唤醒不 steer                                                          |
| 旧格式信封(无来源字段) | 照常解析可读,永不唤醒                                                                    |
| envelope 字段类型非法  | 解析失败走既有死信语义,不崩溃                                                            |

## 后续批次契约

批二~五开工时在本节按同粒度补契约(状态所有者/事件顺序/验收),不在总纲里预设细节。
当前只登记选型与关键约束:

- **批二 C**:provider 抽象,首接 Minimax(F:\智能体 minimax-vision 同款能力,fal 留扩展位);
  配置照 embedding 端点模式(env,缺失显式降级声明一次,静默降级不允许);
  生成做成可恢复作业;子代理使用有独立费用授权开关,默认关。
- **批三 D**:记忆写入租约(先取租约再写,超越现有 stale_write 事后检测);
  history/diff 留档与撤销;extraction cursor 持久化(migration 0023)。
- **批四 E**:一个 settings 键管四类出口(ARMS RUM/数仓上报/桌面 OTLP/Agent OTLP);
  复刻 memoryEnabled 跨层注入链;main 进程出口改读 settings 门。
- **批五 F**:导入来源从硬编码 `"claudeCode"` 泛化为枚举;importedHistory 保留附件;
  导入会话只读边界标记。

## 与既有文档的关系

- [140](./140-qimen-skill-leverage.md):kb 召回链路,无关;
- [138](./138-qimen-pan-fence.md):围栏契约,无关;
- 会话管理检查清单 skill(session-management):mailbox/任务生命周期改动需对照其不变量;
- AGENTS.md「进程、协议与远程控制」:本批不改变 busy/running admission 归属(CommandInbox 串行
  admission 不动),只在其上增加来源可见性与深度护栏。
