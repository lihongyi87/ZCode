# 159 · DSH spill 吸收:工具结果外溢默认化(首尾保留+取回指引)

状态:**已实现**——`fitContentHeadTailWithSuffix` 纯函数 + `serializeOutput` 通用截断分支接线;新测试 8/8(`tests/tool-result-spill.test.ts`),周边回归 31/31(bash-result-mapping / tool-search-result-budget / multimodal-tool-result-p0 / runtime-tool-result-settlement),CLI core typecheck 通过
来源:`deepseek-ai/deepseek-harness` 的 `dsh-spill` 家族(`spill` 存储服务 / `spill-local` 本地后端 / `spill-policy` 工具结果策略,MIT)。**语义移植,非逐字节拷贝**——落点、预算模型与文案按 ZCode 分层重写,不进 `copied-components.json`(先例:spec 150 缓存兜底映射、spec 157 session_log)。

## 它解决什么

工具输出超过模型上下文预算时,现行默认路径(非 artifact 策略工具,138 个中占 130 个)是 **head 截断**——被省略的中段对模型永久不可见,模型无法按需取回。DSH spill-policy 的解法:超预算的全文先落到上下文之外的会话私有文件,模型收到「按原序保留的首尾 + 省略标记 + 完整结果路径与取回指引」,需要时用 read/grep 取回省略部分。信息零丢失,且替换后内容仍在预算内(KV cache 只追加,新可见内容位于可重用前缀之后)。

## 与 ZCode 现状的差距(2026-10-27 摸底)

| 环节       | ZCode 现状                                                                                                        | 差距                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 唯一所有者 | `serializeOutput`(core/tool/executor/result-serialization.ts)                                                     | 无——接线点现成                                      |
| 存储       | `artifactStore.writeToolResultArtifact`(adapters/storage):会话目录+随机 UUID 名+`zcode-artifact://` URI+retention | 无——与 spill-local 同语义(session 私有、名不可预测) |
| 触发面     | 仅 8 个工具显式 `strategy:"artifact"`(bash/grep/glob/agent/task-output/node-repl 等)                              | **其余 130 个工具超预算走 head 截断**               |
| 预览形态   | head 或 tail 二选一(`preview.direction`)                                                                          | 无首尾同时保留,无省略区间标记                       |
| 取回指引   | artifact 策略的 `<persisted-output>` 信封有路径+2KB 头预览                                                        | 通用路径无指引(模型不知道能取回)                    |

## 设计

### 接线(改 `serializeOutput` 通用截断分支,唯一所有者不变)

最终 fallback(现行 `fitContentWithSuffix` head 截断)之前:

1. 该工具无既有 artifact(策略 artifact 工具走自己的分支不受影响)、`deps.artifactStore` 在场 → 尝试把**全文**写入 artifactStore(retention 取 `budget.artifact?.retention ?? "session"`,与策略路径同一存储);
2. 写入成功 → 替换内容 = `首尾按原序保留 + 省略标记 + 取回指引后缀`,总字节 ≤ `maxModelBytes`;
3. 写入失败/无 store → **回退现行 head 截断**(fail-open:信息可见性较此前只增不减,工具调用不因存储故障失败)。

### 首尾分配(纯函数 `fitContentHeadTailWithSuffix`)

- 取回指引后缀优先完整保留(指引丢失=省略内容永久不可达,不可截);
- 剩余预算头:尾 = 2:1(头部通常是结构/开头上下文,尾部是错误/结论,权重更高);
- 头尾之间插省略标记;预算装不下标记时退回纯 head。

### 取回指引文案

```
[Tool output spilled by resultBudget: originalBytes=N, maxModelBytes=M, fullOutput=<path>. Retrieve omitted parts with Read (offset/limit) or search with Grep.]
```

与现行 `[Tool output truncated by resultBudget: ...]` 同风格,模型可执行。

## 与 DSH 的如实差异

- **存储失败语义**:DSH spill-policy「无法保存可恢复内容时保留原结果」;我们回退截断。我们默认预算 100KB,保留原结果会把 10MB 级 stdout 原样放进上下文,击穿预算模型——不可采纳。
- **文字图片共享 token 预算**:不吸收。官方 CUA 帧保护路径(`OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION`)独立且早于本分支;通用路径的图片块只以占位文本进入序列化内容。
- **按需启用**:DSH 靠 `maxInlineTokens` 配置按需挂载;我们对无显式 resultBudget 的工具**默认启用**(默认预算即触发线,与现行默认截断同触发条件,行为升级而非新增开关)。

## 验收

- 纯函数:短于预算内容原样返回;超预算时首尾按原序保留、总字节(含指引)≤ 预算;UTF-8 多字节不截半。
- 集成(`serializeOutput` 直测,夹具沿用 bash-result-mapping.test.ts 的 `minimalToolExecutorDeps`/RecordingArtifactStore 模式):
  ①无 resultBudget 工具+大输出+store 在场 → store 收到全文写入,替换内容含首/尾/`fullOutput=`/取回指引,`returnedBytes ≤ maxModelBytes`,`truncated=true`;
  ②store 抛错 → 回退 head 截断(`[Tool output truncated by resultBudget`),不抛;
  ③无 store(纯 CLI 无存储)→ 同②;
  ④显式 artifact 策略工具(bash)行为不变(回归,`<persisted-output>` 信封照旧)。

## 遗留(后续项,不阻塞)

- 会话引用场景:被截断 transcript 落同一存储(DSH session-reference 用法)——待 compact/引用链路需要时接。
- 图片结果外溢(附件存储+结果文件记录图片路径)——待多模态工具超预算成为实际问题。
