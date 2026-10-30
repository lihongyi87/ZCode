# 166 · Compaction Precompute——后台预热式自动压缩(spec 165 #2 的实现批次)

状态:第 1 步(拆换入段)已实现(3ac68b6c,applyCompactSummaryResult);第 2-4 步(预热/换入/观测)待实现
来源:OpenCode `session/compaction.ts` 的 precompute 语义(吸收目标);对照发现我们的 keep 窗口已存在,缺口收窄为「预热」单项。

## 问题

自动压缩在上下文逼近阈值(compact policy `shouldCompact`)时**同步**生成摘要——用户在那一个 turn 等一个完整的模型摘要请求(数万 token 输入 + 数千输出),表现为一次明显卡顿(spec 155「等待可见性」族的又一实例)。OpenCode 的解法:上下文**接近**阈值时就在后台开始摘要(「Summarize in the background as the context nears the threshold, so automatic compaction can swap it in」),到点直接换入成品。

## 现状盘点(2026-10-30,实现前调研)

已存在、无需新建的机制:

| 机制                     | 位置                                                                                                                                                                                          | 状态                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| keep 窗口(近端保留预算)  | `selectCompactEntries` 的 `preserveRecentTokenBudget`(默认 20K,spec 148⑥ 吸收 pi)                                                                                                             | ✅ 已实现                   |
| 摘要模型请求(可独立调用) | `runCompactSummaryModelRequest`(compact-summary-model-request.ts,含流式/失败处理)                                                                                                             | ✅ 已是独立函数             |
| 压缩判定                 | `shouldAutoCompact`(compact/policy.ts,threshold/hardCap/熔断)                                                                                                                                 | ✅                          |
| 换入段(摘要之后的一切)   | `compactActiveConversationImpl`(compact-active.ts,810 行)后半段:formatCompactSummaryOrThrow → fileListAnnex → persistedSummary → reminder entries → 落库 → `this.latestConversationMessageId` | ⚠️ 与摘要生成耦合在同一函数 |

## 设计(四件套)

### 1. 拆换入段(实现第一步,纯重构)——✅ 已完成(3ac68b6c)

行为不变已验证:compact 全量套件改动前后失败集合完全一致(14 个既有 Windows 本地失败,与 CI 无关)。

把 `compactActiveConversationImpl` 中从 `formatCompactSummaryOrThrow` 起到函数尾的段落提为:

```ts
async function applyCompactSummary(
  this: AgentRuntimeInternal,
  input: {
    summaryText: string; // 已生成的摘要文本
    entriesForSummary: readonly RuntimeMessageEntry[]; // 本次压缩覆盖的窗
    entries: readonly RuntimeMessageEntry[]; // 全量(含 preserved)
    // …compactTimeline/trigger/phase/attempt 等既有上下文
  },
): Promise<{ displayText; entries; tokenCount }>; // 与现返回值一致
```

行为不变,现有 compact 测试套件(compact-persistence-selection / compact-policy / compact-preserved-inputs 等)全量兜底。

### 2. 预热触发(policy 扩展)

`shouldAutoCompact` 之外新增 `shouldPrecomputeCompact`:达到 **预热阈值**(默认 85%,`AUTOCOMPACT_PRECOMPUTE_PERCENT`)、低于 compact 阈值、且当前无在途/已就绪预热时为真。turn-loop 在 autoCompact 判定处(`turn-loop.ts` `autoCompactIfNeeded` 调用点旁)fire-and-forget 启动预热,**永不等待**(OpenCode 语义:Never waits for it)。

预热内容:与 auto 完全相同的投影/选择(`buildRuntimeProviderRequestMessages` + `selectCompactEntries`)→ `runCompactSummaryModelRequest` → 结果存 runtime 状态:

```ts
interface PrecomputedCompact {
  summaryText: string;
  entriesForSummary: readonly RuntimeMessageEntry[];
  snapshotLastEntryId: string; // 快照边界
  createdAt: number;
}
```

- 只存**一个**槽位(runtime 实例字段),新预热覆盖旧预热。
- 预热失败静默丢弃(只 debug 日志)——预热是纯优化,失败不影响正确性(到点回退同步路径)。
- 预热走与摘要相同的 media/投影管线,保证「预热摘要 = 正常摘要」产物一致。
- abort:turn 结束不取消预热(跨 turn 有效正是其价值);runtime 关闭时丢弃。

### 3. 换入(autoCompactIfNeeded 消费)

到点 `shouldCompact` 时:

1. 取槽位预热,校验**快照一致性**:`entriesForSummary` 的最后 entry id 与当前候选窗的对应位置比对,且快照后新增消息 token ≤ preserveRecent 预算的剩余空间。
2. 一致 → 复用 `summaryText` 调 `applyCompactSummary` 换入(跳过摘要生成,秒级完成);快照之后的新增消息自然落入 preserved 窗(keep 窗口语义已覆盖)。
3. 不一致(消息变异/rewind/快照过老)→ 丢弃预热,回退现有同步路径。
4. 换入后清空槽位。

### 4. 观测

- 换入成功:`compact.precompute.hit` info 日志 + compaction telemetry 加 `precomputed: true` 属性。
- 回退:`compact.precompute.miss` debug 日志(reason: stale/absent/failed)。

## 测试计划

1. 换入段拆分后全量 compact 测试回归(行为不变)。
2. 预热触发:85% 阈值启预热、100% 触发换入、换入命中(telemetry 断言 precomputed)。
3. 失效回退:快照后新增超预算/消息变异 → miss → 同步路径。
4. 预热失败(模型错误)→ 静默 + 到点同步路径正常。
5. 预热不阻塞:预热在途时 turn 正常推进。
6. manual /compact 不消费预热(触发语义不同,保持独立)。

## 量级与批次

- 第 1 步(拆换入段)单独可交付:0.5-1 天,行为不变。
- 第 2-4 步:1-1.5 天。
- 合计 1.5-2.5 天(spec 165 原估不变)。默认开启(预热是纯优化,失败回退同步);如需退路,`AUTOCOMPACT_PRECOMPUTE_PERCENT=0` 关闭。
