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

| 批 | 内容 | 状态 | 落点 |
| -- | ---- | ---- | ---- |
| 一 | A 任务互发 steer 化 + B proactive 深度护栏 | 信封契约与消费端护栏已落地(见下「批一实现状态」);发送路由/接收投递/投影/UI 待接线 | contracts/adapters/core/services/shared/ui |
| 二 | C 图片生成作业链(provider 抽象首接 Minimax,fal 留扩展位;子代理费用门控默认关) | 未开工 | core/tool、services |
| 三 | D 记忆 write-lease(租约+history/diff+撤销;extraction cursor 持久化 migration 0023) | 未开工 | core/memory、adapters/storage |
| 四 | E 遥测统一总开关(复刻 memoryEnabled 跨层链;main 进程 ARMS/数仓出口改读 settings 门) | 未开工 | shared、services、desktop |
| 五 | F 会话导入泛化(来源枚举+附件保留+导入会话只读边界) | 未开工 | services、shared |

## 批一实现状态(2026-10-21)

已落地(commit ②):

- **信封 v2**:`session-mailbox.port.ts` 加可选 `sourceType/sourceCommandId/depth/senderLabel` +
  `SessionMailboxPort.append`(适配器生成 messageId/createdAt,tmp+rename 原子落盘,文件名毫秒前缀保序)
  + `drainUnread` 的 `filter` 谓词(limit 只计命中,非命中留在 unread)+ `isWakeableTaskMessage`
  纯函数(信任锚三件套齐全且 depth≤上限)。可选字段类型非法→解析失败走既有死信语义(整批拒绝,
  与 JSON.parse 损坏同路径);旧格式照常解析。测试 5/5(adapters/tests/session-mailbox.test.ts)。
- **消费端护栏**:`core/hooks/session-mailbox.ts` 按 hook 事件选择性 drain——PostToolUse(忙 steer)
  与 Stop(唤醒)只取可唤醒信封;UserPromptSubmit(人驱动)全量交付。深度上限常量
  `MAX_TASK_MESSAGE_WAKE_DEPTH=4`。注入 XML 携带 `sender_label/depth/source_type` 属性。
- **steer 来源**:`TurnSteerSource` 闭集加 `"task_message"`;runtime-tools 把 hook 透传的
  steerSource 传给 `steerTurn({source})`。

已定设计决策(接线时照此执行):

- **信箱=同进程跨会话传输**:发送侧对 `sess_*` 目标直接 `sessionMailboxPort.append`,不新开
  workspace 事件;唤醒与忙时 steer 由目标会话自身的 drain hook 承担(涌现语义,无需在发送方判断
  忙闲)。跨 host(远程/多窗口)才走既有 `workspace_session_message_send_requested` 事件链
  (host 监听/总线/host 入口全部现成,只差 `deliverSessionMessage` 实现)。
- **depth 来源**:发送时取「当前 turn 的唤醒深度+1」;该状态需在 drain 注入时记录(落点:
  runtime-tools 的 enqueuePendingInput 回调处,随发送路由一起接线)。未接线前所有发送 depth=0,
  护栏退化为「信任锚缺失不唤醒」,不可先放开唤醒链测试。

待接线(下一提交单元):① `core/subagent/runner.ts` 的 `sendMessageToLocalAgent` 增加 `sess_*`
目标路由(append+返回 delivery:"queued");② `deliverSessionMessage` 接收实现(host→services→
目标 CLI;同机走信箱 append,跨机走事件链);③ V4 投影 `origin:"task_message"` +
`originMeta.senderSessionId/senderLabel` 填充;④ UI 来源徽标与 i18n。

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

| 场景 | 期望 |
| ---- | ---- |
| A 向忙的 B 发消息 | B 下一工具批次边界以 guide steer 注入,气泡带「来自任务 X」徽标,V4 行 origin=task_message |
| A 向闲的 B 发消息 | B Stop 唤醒,消息进入上下文 |
| requestId 重复投递 | 总线幂等,目标 mailbox 不双写 |
| depth=5 的消息到达 | 投递成功、可读,但不唤醒不 steer |
| 旧格式信封(无来源字段) | 照常解析可读,永不唤醒 |
| envelope 字段类型非法 | 解析失败走既有死信语义,不崩溃 |

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
