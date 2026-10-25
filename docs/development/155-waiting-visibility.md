# 155 · 长等待可见性——Bash 字节计数 / TaskOutput 等待上限与规模

状态:**已实现**(2026-10-25)。动机:用户视角「正在执行/正在获取任务输出看起来卡死」
——真实案例为本仓多 agent 开发会话自身(模型把命令接管道/重定向导致零输出流,
TaskOutput 阻塞等待 10 分钟只有转圈)。

## 三件

1. **Bash 字节计数可见**:运行中 Bash 的 ToolCallProgress 载荷本就带 outputBytes/
   elapsedMs,但 v4 投影(projectToolActivity)只搬 outputPreview,其余全丢——
   工具条「已等待 Ns」只剩本地计时。补:progress 事件映射 row.progress.bytes
   (+updatedAt),渲染器(ToolCallProgressIndicator)在已等待旁显示已收字节
   (0B=真静默可见)。**投影不得要求 outputPreview 成功**:静默命令(sleep 等)没有
   stdout/stderr 就没有 preview,旧实现在此处整条丢弃,恰好在最需要「暂无输出」
   的场景下不显示——preview 与 progress 必须各自独立判空。
2. **TaskOutput 等待上限+规模前置**:阻塞等待心跳(15s)补 message=
   「阻塞上限 ≤Xs · 输出文件 Y」——终点可见(不再是无限转圈)、规模可见;
   v4 投影补 TaskOutput 行的 progress 映射(此前被 toolName==="Bash" 门整体丢弃,
   等伤心跳从未到达 v4 UI)。message 不自带「已等待」:该语义由 elapsedMs 字段承担,
   渲染器先显示「已等待 N 秒」再并列 message,两边都写会重复成
   「已等待…已等待 15 秒」。
3. **agent 行为引导**:TaskOutput 工具描述补「预期等待 >60s 优先 block=false 轮询」。

## 非目标

前台 Bash 超时自动转后台(改变 Bash 工具语义,影响面大,不做)。纯等待命令
(sleep)的**命令级**自动转后台是另一机制,见 spec 156。

## 验收

- 渲染器单测:indicator 字节显示/无字节不显示;TaskOutput 等待文案含上限;
  「已等待」在一次渲染中只出现一次且排在 message(Schema 只保证字段可容纳,
  挡住重复必须靠渲染断言)。
- 投影单测:Bash progress→row.progress.bytes;TaskOutput progress→elapsedMs+message;
  零输出 Bash 进度(无 outputPreview)仍产出 row.progress.bytes=0。
- 介质重出后真机观感:长管道命令显示「暂无输出」递增秒数,TaskOutput 显示
  「已等待 N 秒 · 阻塞上限 Xs · 输出文件 Y」。

## 构建注意

桌面内置 agent 由 `prepare:agent-bundle` 先调 `scripts/build-desktop-agent-cli.mjs`
（turbo `build:desktop-agent --filter=@zcode/cli`）重建 CLI，再由 `stage-agent-bundle.mjs`
把 `apps/zcode-cli/packages/cli/dist/zcode.cjs` 复制到 `bundled-agents/<平台>/glm`。
该构建读的是 `packages/core/dist/index.js`，因此改 `packages/core/src` 后必须让 core 的
`tsc` 产物更新（`pnpm --dir apps/zcode-cli/packages/core build`），否则刷新的只是外层
bundle、里面仍是旧逻辑。turbo 命中缓存时重建几乎瞬时，改完务必核对
`cli/dist/zcode.cjs` 的时间戳与实际文案，不要假设一定重建。
