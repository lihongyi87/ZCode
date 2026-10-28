# 162 · SessionSearch:agent 跨会话全文检索(spec 160 P1 落地)

状态:**已实现**——契约+store 只读查询+handler+运行时装配(结构探测注入,bootstrap 零改动);集成测试 4/4(真迁移+内存库:scope 隔离/软删过滤/当前会话排除/通配符字面匹配/大小写不敏感/非文本 part 过滤/limit+truncated),adapters+core+bootstrap 全链 tsc 通过
来源:Hermes Agent 学习循环评估(spec 160)P1——「FTS5 会话搜索,原文返回不摘要」的语义移植(注意:上游用 FTS5 索引,本实现 MVP 用 SQL 预滤,见「与上游差异」)。

## 它解决什么

agent 目前没有跨会话记忆检索面:上周在另一个任务里查过的结论、调试过的坑,本会话无法回忆。KbSearch 只覆盖知识卡语料;agent memory 只覆盖主动沉淀过的事实。会话正文本身就是最大的经验库——给 agent 一个只读检索工具,「我们之前是不是讨论过 X」类问题就有了兜底(Hermes 分工:记忆管要点,搜索回忆细节)。

## 数据与所有权(为什么这样接)

- 会话事实归 CLI db.sqlite(session-management 技能 §1):`message` 表存元信息,`part` 表存正文(`data` JSON 里的 TextPart.text / ToolPart 等)。**本工具只读,零写入,不建第二份事实,不做迁移**——schema 与写路径完全不动。
- 不给 `SessionStorePort` 大接口加方法(所有实现者都要跟着改):`SqliteSessionStore` 上新增公开只读方法 `searchSessionContent`,port 走独立小接口 `SessionHistorySearchPort`(contracts),bootstrap 装配(镜像 kbSearchControlPort 模式)。
- 隔离纪律:`scope:"workspace"`(默认)按 `session.directory = 当前工作目录` 过滤;`scope:"all"` 检索本机全部未删除会话。`time_deleted IS NULL` 过滤软删除(I9);当前会话默认排除(避免把正在进行的上下文又检索回来),`includeCurrentSession` 显式打开。

## 检索语义(MVP)

- 输入:`query`(1..500 字面量子串,SQL 通配符转义)、`scope`、`limit`(1..50,默认 20)、`includeCurrentSession`。
- 两段式:**SQL 预滤**(`part.data LIKE '%q%' ESCAPE`,SQLite C 速度,命中上限 400 行,按 time_created 降序)+ **JS 精确匹配**(`decodePartRow` 解码后只对 TextPart.text 等文本字段做大小写不敏感子串匹配——SQL 命中可能是 JSON 键名噪音,JS 段保证片段来自真实正文),片段=命中位置前后各 240 字符。
- 输出:`results[{sessionId, title, directory, timeCreated, messageId, partId, snippet}]` + `truncated`(预滤上限截断时真)。只回片段,不回全文;配合 Read(若未来暴露会话导出)或引导用户打开该会话。
- 无命中/库不可用:返回空 results 或明确 note,**不抛错**(检索是增强,不是关键路径)。

## 与上游差异(如实)

- Hermes 用 FTS5 索引(~20ms);我们 MVP 无索引,LIKE 全扫描——770MB 级库上单次调用可能到秒级。可接受的理由:调用频率低(模型按需),且换来零迁移零副本。**升级路径已登记**:性能不可接受时做旁路只读 FTS5 索引(派生缓存纪律:版本锚定+增量重建+自述文件,先例 .kb-index),不动正库。
- Hermes 有 discovery/scroll/browse 三形态;MVP 只有 discovery(查询+片段),browse(读某历史会话全文)留后续。
- 查询词含引号/反斜杠/换行时 JSON 转义会导致 SQL 预滤漏检(JS 段也拿不到)——描述里引导用普通词组,如实记录为 MVP 限制。

## 落点

| 层        | 文件                                                                                                                                           | 内容                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| contracts | `src/tools/session-search.ts`                                                                                                                  | 名称/输入输出 schema(zod+JSON)/`SessionHistorySearchPort` |
| adapters  | `storage/session-store/repositories/session-content-search.ts` + `sqlite-session-store.ts`                                                     | 只读查询方法(SQL 预滤+JS 精确匹配)                        |
| core      | `tool/handlers/session-search.ts` + `handlers/index.ts` + `tool/types.ts` + `executor/types.ts`/`impl.ts` + `runtime/helpers/runtime-tools.ts` | handler(镜像 kb-search)、上下文端口字段、装配             |
| bootstrap | store 装配处 → executor deps                                                                                                                   | `sessionHistorySearchPort` 注入                           |

## 验收

- 纯函数/SQL 层:通配符转义(`%_` 字面查询)、软删除过滤、scope 过滤、当前会话默认排除、limit/truncated、片段窗口、大小写不敏感、非文本 part 不产出结果。
- 集成:真 sqlite 夹具建 2 会话(含目标文本/不含),断言命中与隔离;handler 无端口时报能力不可用(镜像 kbSearch)。
- 门禁:CLI tsc(contracts 先 build)、lint、vitest。
