# 151 · LSP 语义工具族(批一:definition ✅;批二:references/call_hierarchy/rename ✅)

## 背景与来源

七仓 harness 全景考察(记忆 `harness-landscape-survey`,2026-10-23)结论:LSP 语义工具族是
ZCode 唯一「同类都有而我们没有」的能力维度。源头 Charm Crush(FSL-1.1-MIT)——**只借鉴
思路,不搬代码**(FSL 禁竞争性使用)。批一交付 `LspDefinition`(只读、零审批);批二交付
`LspReferences`/`LspCallHierarchy`(只读零审批)与 `LspRename`(需审批+写路径)。

## 设计

### 形态:per-language server + per-request 文档同步

- **LspPort**(contracts):`definition({languageId, filePath, line, character}) → LspLocation[]`;
  `availableLanguages()`。坐标 **1-based**(模型对 0-based 易错),adapter 内转 LSP 0-based。
- **NodeLspAdapter**(adapters/src/lsp):JSON-RPC over stdio(Content-Length 帧),server 进程
  按 languageId 懒启动、进程生命周期复用(初始化握手一次);**每请求 didOpen(读盘全文)
  → definition → didClose**——无增量同步状态,server 视图始终=磁盘,简单且正确(慢一点
  是可接受的代价;批二 rename 再评估长驻同步)。
- **languageId 推断**:扩展名映射(ts/tsx/js/jsx→typescript,py→python,go/rust/java/cs 同理)。
  未配置该语言的 server → 显式错误(模型可见),不静默降级。
- **配置**(照 embedding 端点模式:可选增强,显式启用):CLI `config.json` 的
  `lsp.servers: { <languageId>: { command, args? } }`;`features.lsp` 缺省关。
  示例:`{"lsp":{"servers":{"typescript":{"command":"typescript-language-server","args":["--stdio"]}}}}`。
- **工具**:LspDefinition,readOnly/needsApproval:false/sideEffectScope:none,注册门
  `includeLsp`(port 在场且有可用语言才注册)。
- 超时 20s/请求;server 死亡下次请求重启;stderr 进错误信息。

### 状态所有者

server 进程与握手状态归 adapter(单所有者);文档内容权威=磁盘(工具读文件路径经
resolveWorkspacePath 归一,与 Edit/Read 同规则)。

## 验收

- ✅ 假 LSP server 夹具(最小 LSP 协议实现)集成测试:initialize→didOpen→definition→didClose
  全链,断言位置返回与 1-based 往返;未配置语言的显式错误。
  (`adapters/tests/lsp-adapter.test.ts`,2/2;夹具还抓出并修复两个实现 bug:
  stdout 帧解析按行读导致末条响应滞留死锁、Windows 下 file URL→路径丢盘符。)
- ✅ 真实 typescript-language-server 实测(2026-10-25,`lsp-real-server.test.ts`,
  门控 ZCODE_LSP_SERVER_BIN):tsserver 6.0.3 + tls 6.0.2 下 definition/references/
  rename 跨文件与 callHierarchy 全部通过。实测驱动两处打磨:① tsserver 返回小写
  盘符,adapter 路径归一化补大写盘符;② tsserver 冷启动异步加载项目,首查可能拿到
  不完整结果——真实 IDE 等项目就绪信号,最小适配层以有界轮询表达(测试内建
  pollUntil;产品侧模型对不完整结果自然重试)。环境:在**仓库外**的 scratch 目录装
  typescript@6 + typescript-language-server,设 ZCODE_LSP_SERVER_BIN 指向其 cli.js。
  ⚠️ 不要在仓库内/仓库根 cwd 装包:npm 会沿目录向上命中仓库根并把依赖写进
  pnpm-lock(实测把 vscode-jsonrpc 钉到 5.0.1,langium 的 lib/common/ 子路径
  解析失败,vite build 全挂;`git checkout pnpm-lock.yaml && pnpm install` 可恢复)。
- ✅ typecheck/lint/fmt/architecture 全绿;架构例外按治理登记
  (`architecture-policy.yaml` 的 lsp-semantic-tools 条)。
- ✅ 批二(2026-10-25):LspReferences/LspCallHierarchy(只读零审批)+LspRename
  (needsApproval+workspace 写路径,两阶段应用:全部文件先算后写,避免半套改动)。
  集成测试夹具覆盖 references/callHierarchy/preRename+rename 跨文件 WorkspaceEdit
  (changes 形态);applyLspTextEdits 纯函数测试覆盖同行多编辑/跨行折叠/越界报错。
  checkpoint/rewind:rename 输出带 fileMutations(逐文件 before/after/结构化 diff),
  emitFileMutationCheckpoint 扩展多文件形态——每个改动文件独立 checkpoint 事件并
  登记 turn file changes,workspace rewind 可整体回滚一次 rename。
  - 批二时修复的夹具外 adapter 缺陷:fromRanges 是无 uri 的纯 Range,复用
    definition 归一化会全量丢弃,已单独映射。

## 与既有文档的关系

- 150(DSH):并行吸收线;149(飞鱼):无交集。
- AGENTS.md「能力来源与取舍」:属自研类(思路参考 Crush,许可边界已登记)。
