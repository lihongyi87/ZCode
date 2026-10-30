# 165 · OpenCode 深拆吸收评估(sst/opencode)

状态:评估完成,吸收判断如下(2026-10-30,源码深拆 12 模块 ~3600 行 + 全树 9155 文件)
来源:`sst/opencode`(MIT,223k stars,dev 分支,极活跃)。与 DSH(spec 150/157)、Pi(spec 158)、hermes(spec 152/160)同列第四轮 harness 深拆。

## 架构总览(与 ZCode 的形态差异)

33 个包,Effect-TS 全家桶(不是 ours 的 Zustand/自研 RPC),server/client 彻底分离(HTTP + SSE event-feed,SDK 可跑 workerd/边缘)。**桌面/web GUI 的全部非核心功能都是「GUI 插件」**(terminal/review/files/browser/SSH/WSL/updater),与第三方插件走同一个 `@opencode/plugin/gui` SDK——内置即插件,这条产品架构理念与我们的「插件商店一视同仁」同向,但它做到了 100%(我们桌面内置功能仍是硬接线)。

## 真缺口(ZCode 没有、值得立项,按价值排序)

### 1. Session Affinity——子会话 provider 缓存路由 ⭐ 最低成本高收益

`session/affinity.ts` 全文仅一个函数:**子会话/分叉会话继承父会话的 session ID,把同族会话的模型请求路由到同一 provider 缓存域**:

```ts
export const get = (session) => session.parentID ?? session.fork?.sessionID ?? session.id;
// 注释:children share the parent's, forks the fork source's
```

对照我们:agent team 派单/子代理各自独立 sessionID → 每个子代理的系统提示/工具定义前缀在 provider 侧各起一份缓存。DeepSeek 官方 KV 预热(刚做的 spec 157)按 `session.id` 聚合——同族会话不同 ID 就吃不到共享预热。**吸收=给 `dsh_session_log` 的 wire header 加 parentSession 字段(协议里本来就有这个可选字段!)并在派单时传递家族 ID**;再进一步才是请求头的缓存路由。量级:0.5 天,直接增益多代理并发场景。

### 2. Compaction precompute——后台预热式压缩 ⭐ 体验差异最大

`session/compaction.ts`(1236 行):上下文逼近阈值时**后台先跑摘要**(precompute,「Never waits for it」),到达阈值时自动切换成品——用户无感;我们目前是到阈值才同步压缩,长会话会卡一次明显的等待。配套两个细节同样值得抄:

- **`keep` 保留窗口**:摘要旁保留 N token 最近对话逐字原文(`metadata.keepID` 引用,history 重建时还原),摘要失真问题大幅缓解;
- **overflow 恢复语义**:provider 拒收(上下文超限)时若输出尚未开始,先尝试压缩再重试,而不是直接报错。
  量级:precompute 主干 1-2 天(需异步摘要管线,我们 149 记忆提取已有同构异步管线可复用),keep 窗口 0.5 天。

### 3. CodeMode——工具调用的代码模式(Pi Codemode 的重型版)

`packages/codemode`:**自研受限 JS 解释器**(非 sandbox 真 JS——只实现自己支持的语法子集,工具调用是唯一 IO),模型写一段脚本一次跑 N 个工具调用,省掉每个工具一轮 LLM 往返。三处设计值得记:

- **catalog 分级披露**:系统提示只放部分工具签名 + 全局 `search()` 函数查其余——工具目录本身也是渐进披露,防提示膨胀;
- instructions 明确「哪些工具必须进 execute、哪些是普通直调」的边界提示模板;
- 受限解释器 vs 我们 node-repl(Codemode 工具,spec 158 已落地真 JS):我们的方案表达能力更强但安全边界靠策略引擎;它的方案天然无逃逸。**不替换,可互补**——适合 MCP 大目录场景(几十个 MCP 工具时批量调用)。
  量级:不做解释器(我们已有 node-repl),只吸收 catalog+search 渐进披露模式到 MCP 工具注入(0.5-1 天,MCP 多服务器用户直接受益)。

### 4. max-steps 软着陆

`runner/max-steps.ts`:步数预算耗尽时不硬断,而是注入一条「工具已禁用,只准文本总结」的 assistant 消息再跑最后一轮——产出「已完成/未完成/建议」三段式收尾。我们 goal 时长/预算到点打断(87fa339a)是硬打断+续跑循环;**给 step 上限场景补这个软着陆模板**成本极低(0.5 天,一个 prompt + toolChoice:"none" 的最后一轮),孤儿任务收尾质量明显提升。

## 已有等价(勿重复建设)

| OpenCode                                 | ZCode-CE                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| models.dev 目录 + variant 推理档解析     | 模型注册表 + optionSpecs(我们带 effort/toggle/budget 同款三形态)          |
| compaction auto + buffer(15%/16k)        | 上下文压缩 + 预算策略                                                     |
| retry(退避决策钩子)                      | model recovery + streamIdleTimeout 递增                                   |
| snapshot(git shadow repo 做 undo)        | rewind checkpoint + fileMutations                                         |
| worktree 模块(git worktree 生命周期管理) | 有 worktree 支持且踩过 junction 坑已记录;不引入独立服务                   |
| inbox(会话收件箱/steer 投递)             | CommandInbox 串行 admission                                               |
| run-coordinator(单会话单 busy 期)        | owner/lease + stale run 防护                                              |
| managed-policy(组织策略禁令)             | permission service + toolPolicy                                           |
| usage-limits(Console 配额)               | token-meter/usage 统计(个人用形态不需要)                                  |
| persistent-pty                           | node-pty + 会话恢复                                                       |
| GUI 插件 SDK 全家桶                      | 插件商店 + 装载机制(形态不同:它 Electron IPC 双进程桥,我们 host/renderer) |
| ACP                                      | 已评估(spec 153,立项待拍板)                                               |

## 不吸收 + 理由

- **Effect-TS 架构**:全仓 fiber/Context/Layer 风格,重写等于换骨架,收益为零(架构不是功能)。
- **自研受限解释器**(codemode 内核):我们已有真 JS 的 node-repl,安全边界已有策略引擎;受限解释器的唯一优势(天然无逃逸)对我们是冗余防线。
- **OpenCode Console/identity/usage-limits 云服务面**:个人自托管形态不需要。
- **voice.ts**(语音输入):已有桌面级方案,增量低。

## 与既有 spec 的衔接

- #1(affinity)直接搭 spec 157 的便车:wire 协议 `parentSession` 字段现成,只差赋值与传递。
- #2(precompute)是 spec 155 等待可见性的天然续章:「压缩不再卡等待」正是用户抱怨过的「卡很久」族问题。
- #4(soft landing)与 goal 时长控制(session-target)同族,可并成一个 spec 批次。

## 落地状态(2026-10-30 同日第二批)

- **#1 session affinity:已落地**。`buildDeepSeekSessionLog` 新增 `parentSessionId` 入参 → wire header `parentSession`(协议字段本来就有的可选位);core 装配处从 `this.config.parentSessionId` 读出——子代理 spawn(methods/subagent.ts)与 workflow child(script-workflow-child-runtime.ts)都已传该字段,零新接线。单测:affinity 落 header + 根会话不写两例。
- **#3 max-steps 软着陆:已落地(memory-agent-loop)**。调研发现主循环无 maxTurns 强制(`AgentRuntimeConfig.maxTurns` 是**死字段**:methods/subagent.ts 与 script-workflow-child-runtime.ts 都写入,core 全仓无读者——子代理 4 轮默认限制实际不生效,这是既有状态,登记待议);真实受 maxTurns 约束的循环是 memory-agent-loop(提取/梦幻共用)。软着陆=步数耗尽且最后模型响应仍带 toolCalls 时,追加一轮 `tools: []` 的文本总结请求(user 指令「已完成/未完成/建议」),产出收尾而非静默蒸发。单测 50/50(新增触发/不触发两例,旧两例断言随行为更新)。
- **#2 compaction precompute:立独立批次,本轮不落**。摘要生成与事件记录/重试/媒体投影/compact 工具目录深度耦合在 compact-active.ts 的 810 行函数里,precompute 需要拆摘要管线 + keep 窗口 + 快照偏移 + 失败回退,压在核心稳定性链路上,仓促落地风险大于收益。
- **#4 MCP catalog 渐进披露:已有等价,不建**。MCP 工具注册已带 `shouldDefer: true` + `alwaysLoad` + `searchHint`(core/src/mcp/index.ts)——defer 目录 + 按需加载就是渐进披露,与 OpenCode catalog+search 模式同构。
- 顺手修:`collectDreamTouchedPaths` 的 touched-paths 在 Windows 上产出反斜杠路径(path.resolve 平台行为),统一归一 POSIX 分隔符——审计记录跨平台一致,修复前 dream 测试在 Windows 本地必炸。

## 建议立项顺序

1. ~~session affinity~~ 已落地
2. **compaction precompute + keep 窗口**(1.5-2.5 天,长会话体验最大单项;独立批次)
3. ~~max-steps 软着陆~~ 已落地(memory loop;主循环死字段问题另议)
4. ~~MCP catalog~~ 已有等价
