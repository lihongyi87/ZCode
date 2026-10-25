# 153 · ACP 接入面评估(app-server ↔ Agent Client Protocol)

状态:**评估完成,立项待拍板**(2026-10-25)。结论先行:**可行且值得做**——映射面
干净,有官方 TypeScript SDK,推荐「CLI 内置 ACP 入口」形态,v1 MVP 约 3-5 天。

## 背景与生态

ACP(Zed 发起)已成为编辑器↔agent 的开放标准:JetBrains 官方合作(2025-10 起)、
Google(Gemini CLI 参考实现)、GitHub 背书、**45+ agents 接入**(Claude/Codex CLI/
Cursor/Goose/OpenCode/OpenHands/Qwen/Kimi 等,见 agentclientprotocol.com/get-started
/agents)。对比:竞品已全员在列,ZCode 缺席=该生态里不可见。吸收源头评估均 MIT/
Apache 系,Zed SDK 为 MIT。

## 协议速览(2026-10,v2 draft + v1 stable)

- **传输**:stdio 上 newline 分帧的 JSON-RPC 2.0(无 Content-Length 头,与 LSP 不同);
  client 把 agent 作为子进程拉起(command/args 配置)。
- **握手**:`initialize`(协议版本=整数 major,能力交换,clientInfo/agentInfo,
  authMethods)。v1 稳定;v2 draft 中(migration 文档在案)。
- **agent 必须实现**:`session/new`、`session/prompt`(内容块数组,接受即插入并返回
  messageId)、`session/cancel`、`session/update` 流(见下)。
- **agent 可选**:`session/load`(resume)、`session/set_mode`、`logout`。
- **client 侧方法(agent 调用)**:`session/request_permission`;`fs/read_text_file`、
  `fs/write_text_file`、`terminal/*`(需 client 能力声明);`elicitation/create`。
- **session/update 变体**(sessionUpdate 判别符):agent_message(\_chunk)、
  agent_thought(\_chunk)、tool_call(\_update)(pending→in_progress→completed/failed
  - title/kind)、tool_call_content_chunk、plan_update、available_commands_update、
    usage_update(tokens used/size + ISO-4217 cost)、state_update
    (running/idle/requires_action + stopReason)、compaction_update 等。
- **stop reasons**:end*turn/max_tokens/max_turn_requests/refusal/cancelled/error
  (自定义须 `*` 前缀)。

## 方法映射表(ACP ↔ ZCode 现有)

| ACP 面                                    | ZCode 现有                            | 映射难度 | 备注                                                                               |
| ----------------------------------------- | ------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| initialize/capabilities                   | CLI 启动握手 + runtime 配置           | 低       | agentCapabilities:仅 loadSession;不声明 fs/terminal(执行在 agent 侧自有工具)       |
| session/new                               | session create(runtime 会话)          | 低       | ACP sessionId ↔ ZCode sessionId 映射表(adapter 持有)                               |
| session/prompt                            | session/send + CommandInbox 准入      | 低       | 文本块拼接;图片块按 promptCapabilities 决定是否声明                                |
| session/update: agent_message_chunk       | 流式 text/reasoning delta 事件        | 低       | 直转                                                                               |
| session/update: tool_call(+update)        | tool.scheduled/running/completed 事件 | 中       | kind 分类映射(read/edit/delete/execute/think/fetch/other);title 取工具摘要行       |
| session/update: plan_update               | plan 模式/todos                       | 中       | 语义近似,priority/status 枚举对齐                                                  |
| session/update: usage_update              | turn usage(contextWindow/cache 统计)  | 低       | 概念同构(tokens used/size+cost)                                                    |
| session/update: available_commands_update | slash 命令目录                        | 低       | 已有目录推送                                                                       |
| session/update: compaction_update         | compact 事件                          | 低       | 已有 compact 生命周期                                                              |
| session/request_permission                | permission broker(交互审批)           | 中       | ACP 选项枚举(allow_once/always…)↔ ZCode 审批选项;state_update requires_action 配合 |
| session/load                              | session resume(session store)         | 中       | ZCode resume 需按持久化会话重建运行时,ACP 侧映射 id                                |
| session/set_mode                          | collaboration mode(build/plan 切换)   | 低       |                                                                                    |
| session/cancel + stopReason cancelled     | turn cancel/abort                     | 低       | 取消语义已有;须报 cancelled 而非 error                                             |
| fs/_、terminal/_(client 侧)               | ZCode 自有 fs/terminal 工具           | 不映射   | 能力不声明,执行留在 agent 侧;ACP client 的 fs 是给「无自有工具的 agent」用的       |
| steer/队列/检查点/rewind                  | ZCode 独有(CommandInbox/queue/rewind) | 不映射   | ACP 无对应概念;MVP 阶段不可见,不做妥协                                             |

## 两种设计

1. **CLI 内置入口** `zcode acp`(推荐):在 apps/zcode-cli 加 ACP 入口,进程即
   agent(ZCode runtime 内嵌)。依赖官方 TypeScript SDK(@zed-industries/
   agent-client-protocol,MIT)做帧/类型。优点:无中间进程、会话语义最直、
   与 app-server 共用一套 runtime;缺点:CLI 直接背 ACP 兼容责任。
2. **独立 adapter 进程**(Claude Code 模式):`zcode-acp` 桥接进程翻译 ACP ↔
   ZCode 自有 stdio 协议。优点:ZCode 协议零改动;缺点:双层进程/双份流翻译、
   会话状态跨进程映射、长期双维护。

**推荐 1**。ZCode 协议仍在快速演进,翻译层会把每次协议变化放大成两处维护;
内置入口让 ACP 面与 runtime 同步演进。

## 工作量与风险

- **v1 MVP(session/new+prompt+update 流+cancel+permission+slash+usage)
  约 3-5 天**:SDK 承担传输/分帧/类型;主要工作量在 tool_call kind 映射、
  permission 选项对齐、session/load 的 resume 重建。
- 风险:① v2 仍在 draft(先钉 v1,SDK 已分层);② 协议演进维护面(内置入口
  方案已最小化);③ ZCode 特有体验(steer/队列/检查点)在 ACP 客户端不可表达
  ——定位为「编辑器内轻量面」,完整体验仍走 ZCode 客户端,不构成阻塞。

## 建议

立项,**形态=CLI 内置 `zcode acp` 入口 + 官方 TS SDK,钉 v1**。顺序:
MVP(上述 3-5 天)→ 真编辑器(Zed)互联实测 → 再评估 v2/会话列表/删除等扩展。
