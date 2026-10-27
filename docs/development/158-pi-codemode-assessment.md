# 158 · Pi Codemode 吸收评估（工具面折叠 + 双层 token 账本）

状态:**评估完成,立项待拍板**(2026-10-27)。结论先行:**机制成立、收益真实但集中**——
请求侧收益与「每轮工具数」成正比(本机实测:中位 14、插件重会话 78 个工具/轮);
结果侧收益(大输出先过滤再进模型)对所有重输出会话普遍有效。设计难点不在桥本身,
在 **permission 语义**(脚本内组合调用必须过既有审批闸)。推荐形态:**node_repl 加
`tools` 桥**;MVP 约 3-5 天,建议排在 ACP(153)立项之后。

## 背景与源头

Pi(earendil-works/pi,MIT,TS,~118k stars,10 月发 1.0)是「极简+可造」系 harness。
其 Codemode 把「N 个工具 JSON schema 每轮随请求发」折叠成「1 个 codemode 工具:
模型写 JS,在 QuickJS 沙箱里经 `tools.*` 组合调用任意工具」。机制出处:
pi.dev/docs/latest/codemode;token 数字出处:v1.0.0 release notes 原话
"About 40% fewer prompt tokens",具体例 GPT-5.6 默认工具+codemode 请求
~5,300 → ~3,300 tokens。博文(earendil.com/posts/you-said-no-mcp/)自认局限:
权限/审批模型未做、MCP 组合仍未完全交付。

## 机制拆解:双层 token 账本

**请求侧(schema 账本)**——省的是「每轮重复发的工具定义」:

1. N 个工具 schema → 1 个 `codemode` 工具 + TS 声明速查,速查有硬预算
   (`codemode.inlineBudget` 默认 3000 tokens);
2. MCP 工具默认 `deferred`:完全不列进描述,脚本内 `searchTools()`(BM25)/
   `describeTool()` 按需发现 → 工具描述恒定 → **prompt cache 前缀稳定**(附加收益);
3. `mode:"only"` 可对模型完全隐藏工具(只可经脚本调用)。

**结果侧(输出账本)**——省的是「工具输出的过程噪音」:

- 脚本内可见的工具输出上限 1 MiB(超长取首尾 512KiB+省略标记),而模型直读
  只有 2000 行/50KB;脚本过滤/聚合后**只有脚本自身输出进模型**(默认 10k token 上限);
- 「跑 20 个搜索挑 3 条」类链路只付结论的钱,不付过程的钱。

**沙箱**:QuickJS-WASM,async 函数体;无 Node API/FS/网络/timer,只经
`tools`/`models` 两对象出世界;256MB VM;全进程 2 worker、60s 等位;禁嵌套。
无 timer 是特性:脚本必然终止在某个工具调用上(结构防挂死)。

## 本机实测(ZCode-CE 真实请求样本)

| 指标              | 实测值                                               | 来源                                  |
| ----------------- | ---------------------------------------------------- | ------------------------------------- |
| 每轮工具数        | 中位 **14**,最大 **78**(插件重会话)                  | 47 个 model-io 转储、1,182 次真实请求 |
| 跨会话不同工具    | 89 个                                                | 同上                                  |
| 内置工具契约      | 54 份,~316KB TS 源(≈0.4-0.8k tokens/工具线上 schema) | contracts/src/tools/                  |
| schema 请求侧占比 | 78 工具时 ≈8-17k tokens/轮;14 工具时 ≈2-5k           | 折算                                  |

结论:请求侧收益**集中在插件重会话**(documents/pdf/pptx/xlsx/cua/browser 全开时,
schema 占单轮请求可达 10-20%);中位会话收益有限。**结果侧收益不受此限**:
bash/browser 内容抓取类流程的输出噪音是另一座金矿。

## 方法映射表(Pi 概念 ↔ ZCode 现有)

| Pi 概念                    | ZCode 现有                                   | 映射难度         | 备注                                                                                                 |
| -------------------------- | -------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| codemode 工具(JS 组合调用) | node_repl(宿主侧受控 JS,每调用一次性 Worker) | 中               | 同一执行模式加 `tools` 桥即得;不新建运行面                                                           |
| `tools.*` 绑定             | 无(工具面只在 agent 进程内)                  | 中               | 需反向通道:agent 侧起 tools broker,worker 连接(同 browser/CUA broker 模式)                           |
| inlineBudget TS 速查       | 无                                           | 低               | 绑定生成器按工具契约渲染声明,预算截断                                                                |
| deferred + searchTools     | 无(MCP 工具全量进每轮)                       | 中               | 发现接口走同一 broker;BM25 可先用简单关键词评分起步                                                  |
| QuickJS 能力沙箱           | Node Worker(restrictProcess)                 | 差异             | 不换运行时:Worker 已禁网/受限;Pi 的 QuickJS 是「无宿主可依赖」下的选择                               |
| 权限(未做)                 | permission service + needsApproval 审批流    | **高(核心难点)** | 见下节                                                                                               |
| 观测(Pi 无)                | UI 按 per-tool-call 渲染卡片                 | 中               | 桥内逐调用发结构化事件,否则审计面静默丢失                                                            |
| dynamic workflows          | 已有(spec 体系内)                            | 不映射           | DW 是 subagent 编排(重、独立 runtime);Codemode 是主循环工具调用的 token 经济(轻、进程内)。互补不互替 |

## Permission 设计(核心难点,三方案)

ZCode 的工具审批是**每次调用过闸**(needsApproval → 用户批准/拒绝)。脚本把
K 次调用折进 1 个 cell 后,闸怎么过:

1. **策略预批(保守,MVP 推荐)**:codemode 只暴露无审批/只读工具(read/grep/
   glob/webfetch 等),needsApproval 工具(bash/edit/write)在 codemode 描述中
   标注不可用。收益打七折,但零审批语义歧义,可先落地量收益。
2. **桥内逐调用过闸**:每个 `tools.*` 调用走既有 permission broker;需要审批时
   挂起该次调用等用户裁决,脚本 promise 阻塞。语义最正;风险=审批等待超出
   worker 心跳/超时预算,需给「脚本内审批等待」单独的时限与 UI(复用 turn 内
   审批卡)。
3. **脚本级预批(不推荐)**:批准整个脚本=批准其全部副作用,与逐调用审批的
   粒度契约冲突,且失败不回滚(Pi 亦然),审计无法归因。

推荐路径:1 → 2 渐进。1 的量测数据决定 2 值不值得做。

## 观测面

桥对每次 `tools.*` 调用发与现役工具同构的结构化事件(tool.scheduled/running/
completed),UI 无需新卡片类型;脚本自身的 stdout/错误进 cell 输出。验收要求:
任何一次 codemode cell 在会话时间线里能看到其中每个工具调用的完整审计轨迹。

## MVP 切分(约 3-5 天)

1. 绑定生成器 + tools broker + Worker 桥(1.5 天):从工具契约渲染 TS 声明,
   agent 侧 broker 路由到工具执行器;
2. 策略预批暴露 + inlineBudget 截断(0.5 天);
3. 观测事件与 UI 复用(0.5 天);
4. 结果侧过滤验证:bash 长输出经脚本过滤的端到端用例(0.5 天);
5. 验收场景:(a) 78 工具会话请求体 schema 字节可测下降 ≥50%;(b) 只读工具
   组合链单 cell 完成且逐调用可审计;(c) needsApproval 工具在 codemode 面不可见;
   (d) 脚本死循环被 worker 超时终结,已执行的调用副作用如实上报。

## 风险与边界

- prompt cache:折叠后描述恒定是收益,但工具集合随 MCP 连接变化时 Pi 用
  deferred 保恒定——ZCode 需同样把 MCP 工具从静态描述摘除,否则 cache 反而碎裂;
- 错误恢复:Pi v1.0 专门做了「教模型恢复的错误」(close-match 建议、参数形状
  提示)——桥的错误文案要同样设计,否则模型在脚本路径里的重试成本高于原生路径;
- 不做:models.\* 多模型调用、图片生成、主题/扩展生态——与 ZCode 形态无关。

## 决策点(需拍板)

1. 立项与否、排在 ACP(153) 之后的优先级确认;
2. MVP 采用方案 1(策略预批)是否接受;
3. 收益首测场景选定:建议拿「全插件开启 + 78 工具」会话做 A/B(请求体字节)。

## 实施状态(2026-10-27)

用户已拍板按方案 1 起步。**第一单元已落地并提交**(契约+桥层,休眠态,零行为
变更——broker 未注入时 `codemode.assertAvailable` 抛明确不可用):

- 共享契约 `packages/shared/src/codemode/nodeReplToolsBroker.ts`:env 键
  (`ZCODE_NODE_REPL_TOOLS_BROKER_SOCKET/TOKEN`)、describe/invoke 请求响应
  schema、工具描述符;exports 子路径 `./node-repl-tools-broker`。
- 桥 `apps/zcode-cli/packages/node-repl-host/src/tools-bridge.ts`:worker 全局
  **`codemode`**(`describe()` / `invoke(name, args)` / `declarations()` /
  `assertAvailable`),env 缺失即明确不可用;server.ts 的
  createInProcessNodeReplExecutor 已注入。
- 渲染器 `tools-bindings.ts`:TS 声明速查 + inlineBudget 整块截断
  (`ZCODE_NODE_REPL_TOOLS_INLINE_BUDGET` 可覆写,默认 3000);
  测试 12 例全绿(tools-bindings 7 + tools-bridge 5)。

**第二单元(已落地并提交)**:bootstrap 侧 broker 服务端 + 策略预批 Port + 接线。

- 服务端 `app/node-repl-tools-broker.ts`:镜像 browser broker(readLine 1MiB 上限/
  token 时序安全认证/EPIPE 收敛为取消/uuid 回显);`injectNodeReplToolsBroker`
  向 node_repl 注入 socket+token env。
- 策略预批 Port `app/node-repl-tools-port.ts`:包装 **AgentRuntime 的
  ToolRegistry + ToolExecutor**(`codemodeToolSurface` 只读消费面,core 侧新增
  getter);describe/invoke 双端过滤 `needsApproval === true`;invoke 经
  executor.execute(其内部 permission-flow 照常权威裁决),结果取模型可见
  output 的文本口径(`isError = !success`)。
- 接线 `create-app.ts`:broker 在 runtime config 解析前创建并注入 env;Port 用
  `getRuntime()` 前向引用(worker 只在 turn 内调用,彼时 runtime 已就绪);
  dispose 经 session-facade 资源清理对 `["node_repl_tools_broker", ...]` 注册,
  启动失败路径同步关闭。
- 测试 6 例全绿(inject 定向/describe 策略过滤/invoke 往返/审批类拒绝/token
  拒绝/Port 未绑定)。两例既有红与本仓无关:bundle-smoke(Temp 写入 Access
  denied,环境性)与 mcp-server 的 CUA 凭据捕获断言——stash 实验证明二者在
  HEAD(无 codemode 改动)上同形态复现,属整版合并后的既有红(pitfall #8 形态),
  另案处理;边界守卫的既有违规 `mcpDisabledTools.ts`(单文件传递引入,HEAD 上
  已红)已如实登记进允许面,守卫回绿。

**第三单元(已落地并提交)**:发现面 + 端到端验证。

- 发现面:`resolveJsToolDescription` 增加 `codemodeEnabled` 输入——broker env 已注入时,
  js 工具描述明确授权并教学 codemode 用法(描述是模型每次选工具都读到的唯一文案,
  server instructions 不被 MCP 集成消费,必须挂描述);`isToolsBrokerConfigured()`
  供 server.ts 判定。观测面由构造成立:Port 的 invoke 走 executor.execute,其内部
  call-runner 照常发 started/result 结构化事件,UI 审计轨迹与原生工具同构。
- 端到端测试 `codemode-e2e.test.ts` 3 例全绿:真 socket broker peer(协议逐字节
  共享 schema)+ 真 MCP 运行时(InMemoryTransport + 真 Worker)+ 真 env 注入——
  实测 `tools/list` 描述含提示、脚本 `codemode.invoke` 拿到工具输出、
  `codemode.declarations()` 渲染速查。
- 既有红甄别(stash 实验证明 HEAD 无 codemode 改动即复现,另案):bundle-smoke
  为本机安全软件对 Temp 新写 .mjs 的写入拦截(环境性);mcp-server 的 CUA 凭据
  捕获断言为整版合并后既有红。

**状态:MVP 功能闭环完成**。剩余为规模化验收(78 工具会话请求体字节 A/B、
deferred 工具发现)与发布(随下次介质出包)。
