# 155 · 长等待可见性——Bash 字节计数 / TaskOutput 等待上限与规模

状态:**已实现**(2026-10-25)。动机:用户视角「正在执行/正在获取任务输出看起来卡死」
——真实案例为本仓多 agent 开发会话自身(模型把命令接管道/重定向导致零输出流,
TaskOutput 阻塞等待 10 分钟只有转圈)。

## 三件

1. **Bash 字节计数可见**:运行中 Bash 的 ToolCallProgress 载荷本就带 outputBytes/
   elapsedMs,但 v4 投影(projectToolActivity)只搬 outputPreview,其余全丢——
   工具条「已等待 Ns」只剩本地计时。补:progress 事件映射 row.progress.bytes
   (+updatedAt),渲染器(ToolCallProgressIndicator)在已等待旁显示已收字节
   (0B=真静默可见)。
2. **TaskOutput 等待上限+规模前置**:阻塞等待心跳(15s)补 message=
   「阻塞等待 ≤Xs · 输出文件 Y」——终点可见(不再是无限转圈)、规模可见;
   v4 投影补 TaskOutput 行的 progress 映射(此前被 toolName==="Bash" 门整体丢弃,
   等伤心跳从未到达 v4 UI)。
3. **agent 行为引导**:TaskOutput 工具描述补「预期等待 >60s 优先 block=false 轮询」。

## 非目标

前台 Bash 超时自动转后台(改变 Bash 工具语义,影响面大,不做)。

## 验收

- 渲染器单测:indicator 字节显示/无字节不显示;TaskOutput 等待文案含上限。
- 投影单测:Bash progress→row.progress.bytes;TaskOutput progress→elapsedMs+message。
- 介质重出后真机观感:长管道命令显示「暂无输出」递增秒数,TaskOutput 显示
  「已等待/≤上限/输出规模」。
