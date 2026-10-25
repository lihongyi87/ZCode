# 154 · 订阅式主动编排(proactive orchestration)——多会话自动接力

状态:**P1 已实现并接线(缺省关闭,env 开启)**(2026-10-25)。源头:飞鱼 zcode-feiyu(Apache-2.0,
同族代码可互读;照抄需走 copied-components 登记,本 spec 语义独立成文)。

## 开启方式(P1)

```text
ZCODE_MESSAGE_ENABLED=1                    # 消息面(既有信箱开关)
ZCODE_PROACTIVE_ORCHESTRATION=1            # 总开关(缺省关)
ZCODE_PROACTIVE_WORKSPACES=D:\ws;D:\ws2    # 逐工作区同意名单(逗号/分号)
ZCODE_PROACTIVE_POLL_INTERVAL_MS=5000      # 可选:派发间隔
```

三重缺省关闭:env 总开关、消息面(无信箱即无事件源)、持久面能力(sessionStore
实现 ProactiveStorePort)。任一缺席不构造调度器,零开销。

**使用**:会话 B 调 `ProactiveSubscribe` 工具声明「当 sess_A 发来 mailbox_message
时用 prompt 唤醒我」;A `SendMessage` 给 B 发消息后,宿主调度器(5s 循环)peek→
发布事件→生成 trigger→经 `enqueueDeferredInput` 注入 B——人工只发第一条命令,
协调链自动接力。**P1 边界:只唤醒已驻留(已打开)的会话**;冷会话的 trigger 按
退避重试至上限 rejected,消息本身由既有 mailbox drain hook 在下次打开时交付。

## 问题

多会话协调开发缺「自动接力」:会话 B 收到会话 A 的信箱结果后**不会自己动**,
要人去 prompt 它。飞鱼补的正是这层——人工只发第一条命令,之后的协调链自动接力。

## 机制全景(读自飞鱼源码,语义照此实现)

### 1. 订阅模型(orchestration state)

会话在 session_entry(type=`orchestration state 键`)持有编排状态:
`proactive: { status: "running", subscriptions: [{id, event, sourceId, prompt}], generation }`。
订阅 = 「当 sourceId 发生 event 事件时,用 prompt 唤醒我」。generation 随订阅变更递增。

### 2. 事件发布(publishProactiveEvent)

事件种类:`mailbox_message` / `automation_due` / `task_completed` / `task_failed`
(automation_due 期望源生命周期 turn_started,completed→turn_complete,failed→turn_error;
同事务把源事实写入 session_entry `runtime/proactive_source`——无第二 outbox 队列,
重启直接 claim 既有 trigger)。语义:

- eventId 幂等(`insert or ignore`),深度 ≥ MAX_PROACTIVE_CAUSAL_DEPTH 直接丢弃;
- 源会话必须是同工作区的 task root;
- 目标匹配:同工作区、非 archived、task root 类型、**编排状态里有匹配订阅**
  (event+sourceId)且 proactive.status=running 的其他会话;
- trigger 生成:triggerId=sha256(eventId+target+subscription.id+generation)
  幂等;commandId=`task-app:<source>:proactive:<triggerId>`(信任锚,prompt 来自订阅)。

### 3. 触发表与派发(claim/settle)

proactive_trigger:state=pending/dispatching/delivered/rejected,attempts 上限 8
(超过转 rejected 终止退避),retry_at 退避,owner_id/lease_until 单消费者认领,
generation 防并发重放。派发循环(每工作区 ~5s):claim → 经 task-app interaction
API 发 prompt(delivery: queue,retryCommandId=commandId——旧消息可读不得猜为
depth=0)→ settle。

### 4. 深度与信任

- 深度链:proactiveDepthForSource(sourceCommandId) 回溯自动链已接力层数;
- 缺 sourceCommandId 的旧消息:可读但**不得自动唤醒**;
- MAX_PROACTIVE_CAUSAL_DEPTH 封顶;
- 远程工作区硬排除;proactiveWorkAllowed **逐工作区同意**(设置面)。

### 5. 编排模式(coordinator/swarm)

会话可运行在 coordinator/swarm 模式:工具面按模式选型(coordinator 必须有子代理
派单工具,swarm 成员隐藏 Agent 成员名参数)。这是订阅的另一面——谁当协调者、
谁是队员。

## 实现分期

- **P1(核心闭环,~2 天)**:migration(proactive_event/proactive_trigger)+仓储
  (publish/claim/settle/depth)+mailbox 读面(peekUnread/markRead)+dispatcher
  (mailbox_message 一种事件)+订阅协议方法+proactiveWorkAllowed 配置(缺省关,
  config 开启)+集成测试。依赖:session_entry 编排状态写入。
- **P2(~1 天)**:automation_due/task_completed/task_failed 三事件(生命周期
  溯源)+编排模式工具面选型。
- **P3**:同意开关设置 UI;codex/编辑器联动评估。
- 许可:拷贝/改写飞鱼实现须登记 copied-components.json(Apache-2.0)。

## 落地状态(2026-10-25)

**P1 已完成并接线**(缺省关闭,env 开启;开启方式见文首):

- `migration 0027_proactive_orchestration` 建 `proactive_event`(eventId 主键
  幂等 + 溯源 source_command_id/depth)与 `proactive_trigger`(state/attempts/
  retry_at/owner_id/lease_until/generation,唯一索引 event+target+subscription)。
- 契约:`contracts/interfaces/proactive-orchestration.ts` —— 事件/订阅/trigger
  数据形状 + `canProactivelyWake`(来源锚点+深度护栏) + triggerId/commandId 派生
  + `MAX_PROACTIVE_CAUSAL_DEPTH`/`MAX_PROACTIVE_TRIGGER_ATTEMPTS`/
  `PROACTIVE_TRIGGER_LEASE_MS`。
- 仓储:`adapters/.../repositories/proactive-orchestration.ts` —— publish(幂等,
  只对 event+sourceId 双匹配的订阅生成 trigger)、claim(owner 租约单消费者,
  过期租约自愈,**按事件工作区过滤**避免跨区认领)、settle(delivered/rejected 终态,
  失败退避至上限 8 次)、depth(沿 commandId 回溯)、generation 变更与目标会话
  不可用时清理。
- mailbox 读面:`peekUnread`(只读不移动,供 dispatcher 判定)与 `markRead`
  (幂等,按 messageId 移动到 read)。
- dispatcher:`adapters/src/proactive/dispatcher.ts` 的
  `runProactiveDispatcherTick` —— peek → 护栏 → publish → claim → 注入 → settle,
  错误隔离(单目标失败不影响其他,进入退避)。
- 同意闸门:`adapters/src/proactive/policy.ts` 的
  `resolveProactiveOrchestrationPolicy` —— **双重闸门**:总开关 `enabled` 缺省
  false,且 `allowedWorkspaceKeys` 未列入的工作区一律拒绝(开启但名单为空=全拒)。
- 编排状态读写:`adapters/src/proactive/orchestration-state.ts` ——
  `readOrchestrationState`(坏数据返回 null 不抛错,单个坏订阅被丢弃而非整条作废)与
  `writeSubscriptions`(generation 自动递增,旧 trigger 随之失效)。
  session_entry 类型常量 `SESSION_ENTRY_ORCHESTRATION_STATE = "orchestration state"`。
- 宿主接线:`adapters/src/proactive/host-wiring.ts` ——
  `deriveWorkspaces`(按 directory 分组,过滤 subagent/已归档/空目录/远程)、
  `createProactiveDispatcherDeps`(peek 只读、`enqueueDeferredInput` 注入)。
- 调度器:`adapters/src/proactive/scheduler.ts` —— 生命周期内唯一派发触发者;
  关闭时 no-op 无定时器、串行跳过重叠轮、单轮异常不终止循环、dispose 幂等。
- 持久面端口:`contracts/interfaces/proactive-store.port.ts` 的 `ProactiveStorePort`,
  由 `SqliteSessionStore` 实现并委托仓储——bootstrap 层通过端口访问,不直接持 db。
- 测试:57 例(仓储 15 / mailbox 9 / dispatcher 9 / policy 6 / 接线层 12 / 调度器 6),
  migration 在完整迁移链上验证通过。

**本段实现过程中测试抓出的两个真实缺陷**(已修复):claim 的 `workspaceKey`
参数未进 SQL(会跨工作区认领);dispatcher 的 eventId 未含目标维度(多目标时
第二目标被幂等跳过)。

**接线(2026-10-25 第二批)**:

- 分层修正:dispatcher/host-wiring/scheduler 全部经 `ProactiveStorePort` 访问
  持久面(不再直接持 db);adapters 新增 `@zcode/adapters/proactive` 子路径出口。
- `server.ts` 挂载:`createProactiveSchedulerIfPossible()`(feature-detect
  ProactiveStorePort+编排状态读写能力)→ `createProactiveSchedulerFromEnv`
  (env 解析+同 root mailbox)→ start;shutdown 时先 dispose。
- 注入路径:`context.sessions.get(sessionId).app.enqueueDeferredInput(prompt,
  {delivery:"queue"})`;会话不驻留时抛错退避。
- 订阅工具 `ProactiveSubscribe`(contracts schema + core handler):
  整体替换订阅集合/status 切换/generation 递增;订阅 id 由工具分配。
- 测试:64 例(仓储 15/mailbox 9/dispatcher 9/policy 6/接线 12+端到端 1/
  调度器 6/工具 6)。端到端用例钉住 writeSubscriptions→mailbox→dispatcher→
  注入→幂等全链。

**实现中测试抓出的三个真实缺陷**(均已修):claim 的 workspaceKey 未进 SQL
(跨区认领);dispatcher eventId 未含目标维度(多目标幂等跳过);writeSubscriptions
新写缺省 paused 与工具缺省 running 分叉(写入后永远不派发)。

**P2 已实现(2026-10-25)——三事件生命周期溯源**:

- 事件发布与订阅匹配分离:发布者(runtime/automation 入口)只记事实(targets 空),
  dispatcher tick 物化环节按「当前」订阅补生成 trigger(仓储 materialize/
  unmatched,唯一索引幂等,回看窗口 1h——订阅是向前看的契约,不追溯旧事件)。
- `task_completed`/`task_failed`:`recordTurnUsageFact`(turn 终态统一收口)发布,
  completed/error 分别对应,cancelled 不发布(用户中止既非完成也非失败);
  deps.proactiveStore 由 create-app feature-detect 注入,发布失败只记 warn。
- `automation_due`:automation 到点派发 turn 时(server-operations 的
  activeAutomationId 分支)发布,eventId 以 runId 幂等。
- 物化护栏:事件同样过 canProactivelyWake(缺 sourceCommandId 不物化)。
- 测试:仓储 4 例(dispatcher 11 例含物化端到端/runtime 5 例),全量 75 例绿。

**P2-B 编排模式(coordinator/swarm)不做**(2026-10-25 裁决):现有 Agent 工具
(派单)+SendMessage(成员互发)已覆盖 coordinator/swarm 的能力本体;飞鱼差异仅在
「工具面按角色收窄」(swarm 成员隐藏 Agent 成员名参数),需要 subagent 参数
schema 动态化,影响面大而无当期用例。重启条件:多会话编排实际使用中出现
成员误用协调者工具的真实事故。

## 非目标

不做 swarm 的自动任务分配策略(订阅由模型/用户显式声明);不做跨机唤醒(远程
工作区排除)。
