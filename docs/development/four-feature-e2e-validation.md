# 四件套活体验证记录（2026-09-25）

> 目的：验证自动思考档 + 记忆召回 + 微压缩锚点 + 任务再锚定在真实多步任务上
> 同时生效。方法：headless CLI（真实数据目录）跑多文件顺序读取任务，
> `stream-json` 事件流 + `cli/db/db.sqlite` 的 model_usage + 运行日志三源取证。

## 运行条件

```
ZCODE_ADAPTIVE_REASONING=1
ZCODE_REANCHOR_INTERVAL=3        # 默认 15，短会话验证用
ZCODE_MICROCOMPACT_THRESHOLD_TOKENS=2500
--mode yolo --output-format stream-json
```

## 结果

- **任务成功**：3 个文件顺序读取 + 记忆引用，全部完成，`is_error` 为空。
- **模型步数**：7 步（多步工具循环，步间为工具结果收尾的续跑步）。
- **自适应思考档**：日志出现 4 次
  `[adaptive-reasoning] 工具续跑步降档`——续跑步全部降档执行。
- **记忆召回**：日志出现 `[memory-recall] 相关记忆清单已注入本轮请求`——
  预置的 attention-bench-notes.md（注意力探针结论）被按查询相关性命中注入；
  模型最终回答明确引用了记忆结论与两个 bench 文件互证。
- **任务再锚定**：日志出现 2 次 `[task-reanchor] 已在尾部重申最初任务`
  （第 3、6 模型步，间隔 3）。
- **微压缩锚点**：阈值 2500 下候选组未达清除条件（本次任务工具组较少），
  活体触发留待长会话；机制由 microcompact-anchors 测试 6/6 覆盖。
- **缓存**：本次会话缓存读 31K-45K/步，真实命中率 81-99%
  （GLM 的 input_tokens 含缓存读，命中率 = cache_read ÷ input_tokens）。

## 诊断副产物（已修复）

1. **隔离环境选型渗透根因**：adapters `resolvePath` 把 `~/` 硬解到 homedir，
   `ZCODE_DATA_BASE_DIR` 下 legacy config 导入仍读真实主目录的 `model.main`
   （deepseek-v4-pro[1m]）——已修为优先取数据根。
2. **默认选型 fallback**：`resolveInitialModelSelection` 在无 configuredDefault
   时按 registry 顺序取第一个可选模型——隔离环境把 builtin 层的第一个模板
   当默认。用户可用 personal 层 `defaultModelSelection` 显式指定。
3. **message entry 的 kind 是可选字段**：真实用户消息 entry 不带
   `kind:"message"`，按 kind 判定的代码恒 false（memory_recall / task_reanchor
   曾因此静默跳过）——统一改为 `"message" in entry` 判定。
