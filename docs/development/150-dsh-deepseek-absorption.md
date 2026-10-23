# 150 · DSH DeepSeek 专属能力吸收:守卫检视 + 缓存 usage 兜底映射

## 背景与来源

DSH(`deepseek-ai/deepseek-harness`,DeepSeek 官方框架,MIT,极活跃的 developer preview)
是本仓既有吸收源(速度药丸、agent team、137 e2e 模式)。本 spec 登记对其 **DeepSeek
专属适配**的吸收决策与落地:什么已存在、什么补齐、什么明确不吸收。

分析基于 2026-10-23 上游 master(0.2.1-rc.2)。DeepSeek 专属面:session-log 上传、
插件清单字段、Search/Fetch API、Flash 模型、guard 家族。

## 决策表

| DSH 能力                                           | 决策         | 理由                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh_session_log`(增量会话日志上传,服务端 KV 预热) | **不吸收**   | 字段绑定 DSH 私有 canonical 会话格式 v1(seedLength/afterSeq/throughSeq/surfaceOp…),项目自述「developer preview,将有破坏兼容变更」,且服务端效果未见于公开 API 文档。复刻 = 把 ZCode 会话事件流耦合到一个快速漂移的外部格式,风险大于收益。**重启条件**:DeepSeek 公开 API 文档正式收录该协议且格式版本稳定 |
| `repeat-tool-reminder`(guard 家族)                 | **无需移植** | ZCode 已有同构实现:`model-anomaly.ts` `detectRepeatedToolCallWarnings`(阈值 3、advisory 注入 `model_anomaly`、预算上限)——检测/注入/事件/配额全部在场。本批只补 streak 检测的单测空白                                                                                                                    |
| OpenAI 端点缓存 usage 映射                         | **落地**     | 见下                                                                                                                                                                                                                                                                                                    |

## 落地一:守卫 streak 检测单测(补空白)

`detectRepeatedToolCallWarnings` 是纯函数但此前无单元测试(仅有 reminder 文案测试)。
新增 `core/tests/repeat-guard-dsh-absorptions.test.ts`(沿用 137 的 DSH 吸收命名):
同签名 streak 递进、阈值触发、异签名重置、预算上限(告警注入配额耗尽仍产出观察)、
阈值≤0 关闭。纯函数断言,不改实现。

## 落地二:DeepSeek 缓存 usage 兜底映射(adapters)

**事实链**:DeepSeek 官方 API 的 usage 同时返回嵌套 `prompt_tokens_details.cached_tokens`
(OpenAI 标准形态,@ai-sdk/openai-compatible 已映射 → cacheReadTokens)与 DeepSeek 特有
顶层 `prompt_cache_hit_tokens/prompt_cache_miss_tokens`。嵌套路径已覆盖现网;但若端点只回
顶层形态(DSH 观测到的形态之一),缓存命中会显示为 0。

**修复**:`runner-normalization.ts` `normalizeUsage` 增加兜底——
`cacheReadTokens = inputTokenDetails.cacheReadTokens ?? raw.prompt_cache_hit_tokens`。
`prompt_cache_miss_tokens` 语义是「未命中」而非「写缓存」,**不映射** cacheWriteTokens。

验收:线缆/单测断言 ①details 在场时优先(details 赢);②仅顶层字段时兜底命中;
③两者皆缺时 undefined。

## 不改的部分

- 内置 DeepSeek 模板(`anthropic-messages + api.deepseek.com/anthropic`)不动——该路径
  缓存映射与计费呈现全通。
- `applyCacheControl`(Anthropic 语义)不适用于 openai 路径,维持现状。
- reminder 接线无新增注入点,`reminder-wiring-guard.test.ts` 无需更新。

## 与既有文档的关系

- 137(DSH e2e 模式):测试工程实践吸收,本 spec 是模型能力吸收,互不覆盖;
- 149(飞鱼吸收):并行吸收线,无交集;
- D:\ZCode-src `AGENTS.md` 能力来源与取舍表:DSH 条目「载荷与工程实现,可搬」——本 spec
  是该表的第一批落地实例。
