# 157 · DeepSeek `dsh_session_log` 增量会话日志(DSH 吸收)

状态:已实现,**默认开启**(`ZCODE_DEEPSEEK_SESSION_LOG=0` 显式关闭)
来源:`deepseek-ai/deepseek-harness` 的 `@deepseek-ai/dsh-session-log-deepseek` + `@deepseek-ai/deepseek-llm-api-extensions`(Apache-2.0)。**语义移植,非逐字节拷贝**——wire 契约、水印语义、maxBytes 截断语义与上游对齐;实现按 ZCode 分层重写,故不进 `copied-components.json`(该登记只收逐字节拷贝,先例:spec 150 的缓存兜底映射)。

## 它解决什么

DeepSeek 服务端可用请求携带的会话日志做 **KV 缓存预热**:每次请求附带自上次确认水位之后的会话表面事件增量(at-least-once),服务端按 `session.id` 聚合。对长会话多轮 agent 是免费的缓存命中率提升——**不进 messages、模型零 token 成本**,对不支持该字段的其他 provider 无影响。

## 端点接受性(风险锚点,已实测消除)

- 2026-10-26 用本机配置的真实 `sk-` key 实测 `https://api.deepseek.com/chat/completions`:基线请求、带完整 v1 形状字段、空 events 三探针全 200;用 `buildDeepSeekSessionLog` 真实 fold 产物(含 `surfaceOp`/`sourceEventSeqs`/`tool/result` 词表)两轮全量+增量请求也全 200。
- 结论:官方端点接受该顶层未知字段。此前「anthropic 端点是否拒收」的疑虑基于错误前提——ZCode 的 DeepSeek 接入走 `openai-responses`/chat 兼容路径,不是 anthropic-messages。

## wire 契约(v1,对齐上游 README)

顶层请求字段 `dsh_session_log`(与 model-input 字段平级):

```
{ version: 1, sessionFormatVersion, session: { version, id, createdAt },
  afterSeq, throughSeq, events: [{ type, seq, time, data, surfaceOp, sourceEventSeqs }] }
```

- 事件词表(服务端认识的表面事件):`system/message`、`user/message`、`assistant/message`、`tool/result`;`surfaceOp: "append"`;`sourceEventSeqs` 指回来源。
- 水印:`afterSeq` = 上次 2xx 确认的 seq;**at-least-once**:宁重复不跳过,服务端按 seq 幂等。maxBytes(默认 8MiB)装不下时省略字段并在下个请求重试;首事件单独超限同此。
- `maxBytes` 计数含 envelope 与逐事件 JSON UTF-8 字节;不可序列化事件计 `Infinity`(阻止该前缀)。

## ZCode 侧设计(与 DSH 的架构差异)

DSH 有独立 canonical 事件流 + 扩展注册表(Cordis Service);ZCode 直接用**每次模型请求现成的 `ModelInputMessage[]`**(canonical 模型表面历史)做确定性 fold,不需要独立事件流:

| 环节                   | 位置                                                                                   | 说明                                                                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| fold/指纹/打包(纯函数) | `contracts/src/deepseek/session-log-fold.ts` + `session-log-wire.ts`                   | fold 是纯函数:同一消息序列永远折叠出同一 wire 序列,seq=折叠序号;空文本消息(纯 reasoning/附件)不占 seq                                                                                                        |
| 前缀指纹               | 同上 `computeChainHash`                                                                | **链式 hash**(逐条混入 role+文本头 256 字符,O(n))。锚定前缀而非末条——追加新消息不破坏旧前缀指纹,增量才成立;前缀内变异(编辑/compact/rewind)改变链值→自动从 0 全量重发                                         |
| 水印存储               | `core/src/deepseek/session-log.ts`(进程内存,per sessionId)                             | 语义是 at-least-once:进程重启丢水印只代价一次全量重发,正确性无损。**持久化留后续项**(可落 `local_setting` kv 表,零迁移)                                                                                      |
| 请求装配               | `core/src/runtime/methods/model.ts`(`runModelTextRequest`)                             | 仅 DeepSeek provider(providerId 含 `deepseek`)且开关开启时,构造 `{value, throughSeq, accept}` 挂到 `ModelTextRequest.deepSeekSessionLog`(runtime-only,不进 JSON schema,`statusSink` 同族先例)                |
| fetch 注入             | `adapters/src/model/deepseek-session-log-fetch.ts`                                     | provider fetch 链最外层(拿到 SDK 序列化后的最终 JSON):解析 body→挂顶层字段→发送;**HTTP 2xx 即 accept**(与上游一致,SSE 未消费完也算投递);body 读取 fail-closed(SDK 改非文本 body 必须显式报错,不许静默丢字段) |
| 透传链                 | `runner.ts` → `model-execution.ts`(`resolveRequest`/`resolveSnapshot`/`createFactory`) | `AiSdkModelTextRequest` 继承字段;`resolveForRequest` 两处调用点透传;`kindFetch` 仅对 DeepSeek provider 包装                                                                                                  |

accept 幂等性由两侧共同保证:core 侧 transaction 有 `accepted` 闩(同一请求的多次尝试只记一次),fetch 侧有独立 `accepted` 闩(多次 2xx 只回调一次)。core stream recovery 构造的是新请求→新 transaction→基于最新水印的增量。

## 开关

- **默认开启**(端点接受性已用真实 key 实测,2026-10-26);`ZCODE_DEEPSEEK_SESSION_LOG=0` 显式关闭——预留给「第三方 DeepSeek 兼容网关拒收未知顶层字段」的退路。`ZCODE_DEEPSEEK_SESSION_LOG_MAX_BYTES` 覆盖默认 8MiB。
- 非 DeepSeek provider 一律不注入(providerId 判定);显式关闭时全程零开销(装配函数第一行短路)。
- config 化(设置 UI)留后续:当前仅单人使用,环境变量足够。

## 已知边界

- **水印不持久化**:进程重启后首次 DeepSeek 请求全量重发(8MiB 上限内),之后恢复增量。
- **只投影 text 块**:工具调用参数、图片、reasoning 不进 log(服务端预热主要消费文本表面);`tool/result` 只带文本结果。
- **指纹抽样**:链式 hash 每条只混入文本头 256 字符,前缀中部 256 字符后的等长变异理论上漏检(此时主症状是 KV 缓存失效,log 漂移是次要症状,可接受)。
- compact/rewind/fork 后全量重发一次,之后恢复增量。

## 验证

- 单测 15 个:wire 打包 5(watermark 续传/截断/blockedAtSeq/seq 倒退防护/不可序列化)+ fold 增量 5(词表映射/全量/增量/失配全量重发/无新增跳过)+ fetch 注入 5(顶层注入/非 2xx 不 accept/accept 幂等/Request 对象路径/非 JSON 透传)。
- 真端点 smoke:fold 产物两轮(全量+增量)全 200,accept 水印推进正确。
- 开发中修掉的三个真 bug(测试断言先行就不会溜进主线):① 指纹锚定末条→追加即失配,永远全量重发(改链式前缀 hash);② 水印重置为 0 后 `seq > 0` 过滤把首条事件永远滤掉(改哨兵 -1 + wire afterSeq 归 0);③ pack 守卫把合法的首次全量(afterSeq=0+first.seq=0)当 fold 缺陷拒收(守卫仅在水位 >0 时生效)。
