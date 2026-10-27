# 161 · Codex app-server 协议互操作评估

状态:评估完成,结论=**暂不实现互操作,登记观察条件**(2026-10-27)
来源:`openai/codex`(**Apache-2.0**,README 明示)。2026-08 OpenAI 将 Codex 定位为开放平台:开源 harness + **app-server(文档化客户端协议)** + 官方 SDK;GitHub/JetBrains 已接其为 IDE 内 "agent provider";`codex exec` 提供非交互结构化输出入口。

## 为什么值得看

这与本项目「app-server 是立身之本」的架构判断同向:业界正在收敛到「对上 app-server 协议、对下 MCP」的连接层形态,且出现了**两条行业标准线**:

| 线                         | 形态                                                                   | 采纳方                                               | 我们的既有结论                            |
| -------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| ACP(Agent Client Protocol) | editor↔agent 标准协议                                                  | Zed、JetBrains 系、Google 系                         | 全景考察(10-25)已评估:**窗口收窄**,暂不接 |
| Codex app-server 协议      | 文档化客户端协议(threads/turns/streamed events/approval requests)+ SDK | GitHub、JetBrains(Codex as agent provider)、Cisco 等 | 本文评估对象                              |

## 互操作的含义与成本

若 ZCode 暴露 Codex 协议兼容面,支持 Codex 协议的 IDE/客户端理论上可以驱动 ZCode 引擎。成本与风险:

1. **协议跟随成本**:Codex 协议随其产品演进(threads/turns 语义即其内部概念),Apache-2.0 允许参考实现,但兼容层是持续跟随义务,不是一次交付;
2. **概念映射损耗**:Codex 的 thread/turn/approval 与 ZCode 的 task/session/turn/owner-lease 模型不同构(我们是 window-scoped Local Host + attachment + 广播同步语义),兼容层要在两种一致性模型间翻译——这正是本项目反复强调「传输≠一致性」的高危区;
3. **双标准并存**:ACP 与 Codex 协议未见收敛迹象,押错边就是弃子;
4. **收益面**:当前桌面/Web/CLI 全部走自家 `zcode-protocol`(严格类型+运行时校验,单一所有者),没有「必须被第三方 IDE 驱动」的现实需求。

## 结论

- **暂不实现**。我们自己的协议就是连接层资产,当前无外部客户端压力;
- **观察条件(满足其一再立项)**:① 出现真实的「用 X IDE 驱动 ZCode」用户需求;② Codex 协议与 ACP 出现合并/收敛信号;③ 我们决定把 ZCode 引擎作为可嵌入组件对外提供。
- 届时路径:参考 openai/codex(Apache-2.0)的 app-server 文档做**语义映射层**(非逐字节,按能力来源表登记 modifiedFiles 若有拷贝);优先级低于 ACP(ACP 是中立标准,Codex 协议是单一厂商线)。

## 参考

- 官宣:https://developers.openai.com/blog/codex-as-a-platform(2026-08)
- 仓库:https://github.com/openai/codex(Apache-2.0)
- 相关:全景考察记忆(ACP 窗口收窄结论);`docs/development/` 各协议 spec
