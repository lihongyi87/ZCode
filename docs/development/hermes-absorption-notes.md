# Hermes 机制调研备忘（2026-09-24）

> 调研对象：[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
> （MIT，248k★，"The agent that grows with you"）。本文记录与本仓库相关的
> 机制发现、**为什么暂不实现**、以及将来启用它们的前提条件。结论由通读
> `agent/prompt_cache_boundary.py`、`prompt_cache_scope.py`、`context_pin.py`、
> `context_engine.py`、`memory_manager.py`、`turn_context_compaction.py` 得出。

## 一、缓存率相关

### 1. 构建方登记稳定前缀（prompt_cache_boundary.py）

Hermes 让 skill/cron/webhook 构建器在组装消息时**登记稳定脚手架前缀**，
缓存规划器在登记边界放 cache 断点（LRU + 4MB 字符上限）。优于请求时解析
标记：标记可能合法出现在技能正文里，分隔符启发式会缩小缓存前缀或吞进挥发字节。

**暂不实现的原因**：本仓库的 system 提示按 section 分桶、各自带断点
（stable/dynamic/meta-user 边界/滚动尾），**当前没有任何构建器把「稳定脚手架 +
挥发尾」拼进同一条消息**——注册表今天没有消费者。启用前提：出现此类构建器
（例如技能正文展开为 user 消息且尾部带每次不同的状态字节）。

### 2. 压缩世代的 cache scope 稳定化（prompt_cache_scope.py）

压缩换代铸出新 session_id 会把 provider 侧缓存桶孤儿化；Hermes 把 cache
scope 解析回压缩世系根（/new 换新，fork 隔离）。

**适用前提**：仅对**按 key 路由缓存**的 provider（openai 系 `prompt_cache_key`）
有意义。本仓库 anthropic 协议缓存是内容前缀制（压缩必然改写前缀，key 稳定化
救不了），openai-compatible 端点是否支持该字段待协议验证。列为协议研究项。

## 二、记忆机制相关

### MemoryManager 架构（provider 插件 + prefetch/sync 分离）

内置 provider 恒在 + 至多一个外部插件；turn 前按 query **prefetch**（外部
provider 带超时与卡死跳过）、turn 后 **sync** 写入（后台单 worker，按
write/prefetch 持久级分池 drain）；`describe_recall()` 给用户一行「召回了 N 条」
的透明指示；召回结果超限时溢写为文件防前缀膨胀；`<memory-context>` 包装带
「非新用户输入」系统注记。

**与待办 B（向量召回）的关系**：本仓库的记忆召回升级应以 Hermes 的
prefetch/sync 分离 + 透明化为形态参照，但需要先解决一个设计前提——
本仓库的记忆清单在**会话启动时构建注入**（无 query 可排序），而 Hermes 的
prefetch 是 **turn 级**的。因此向量召回的第一步不是打分器，而是「记忆注入
从 build 时移到 turn 时」的注入时机改造。排序打分（0.7×余弦 + 0.3×中文
二元组 + 未配 embedding 退关键词）在其后。

### 压缩前记忆检查点（pre-compress checkpoint API）

压缩前给记忆 provider 一次抢救状态的机会。**本仓库无此缺口**：压缩提示词
已强制逐节保留约束/全部用户消息/待办（compact/prompt.ts），且记忆为文件制
（MEMORY.md + manifest），不随压缩丢失。

## 三、其他已核实的对应关系（无需动作）

| Hermes                                     | 本仓库                                       | 结论                             |
| ------------------------------------------ | -------------------------------------------- | -------------------------------- |
| context_pin（用户钉窗口值）                | 个人层 modelConfigRules（glm-5.2 已钉 1M）   | 已有                             |
| 三段 turn-start 压缩（idle/阈值/溢出重臂） | microcompact idle 阈值 + auto/micro/reactive | 已有                             |
| thinking 集中参数表                        | model-option-map CEL（更通用）               | 已有且更优                       |
| 记忆 egress 消毒（redact + 头尾截断）      | 未实现                                       | 可作为记忆注入升级的一部分一并做 |
