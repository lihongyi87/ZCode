# 154 · 订阅式主动编排(proactive orchestration)——多会话自动接力

状态:**spec 完成,实现分期**(2026-10-25 立项)。源头:飞鱼 zcode-feiyu(Apache-2.0,
同族代码可互读;照抄需走 copied-components 登记,本 spec 语义独立成文)。

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

## 非目标

不做 swarm 的自动任务分配策略(订阅由模型/用户显式声明);不做跨机唤醒(远程
工作区排除)。
