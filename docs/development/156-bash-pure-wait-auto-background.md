# 156 · Bash 纯等待命令自动转后台

状态:**已实现**(2026-10-25)。动机:用户实测 agent 用前台 `sleep 240s` 等一个构建,
UI 上只有「正在执行」转圈 4 分钟(spec 155 只解决了"看得见在等",没解决"等太久")。
sleep 的唯一目的是消耗时间,前台持有整个 turn 的执行槽没有任何收益。

## 规则

1. **纯等待命令自动转后台**:命令整体恰为单个 `sleep N[s|m|h]`(允许小数)且
   有效时长 ≥ 60s 时,在 handler 入口等价改写为 `run_in_background: true`,
   走既有显式后台路径——模型立刻拿到 `backgrounded` 结果与 taskId,
   继续其他工作或用 TaskOutput(spec 155 的有终点等待)回收。
2. **阈值 60s**:`sleep 45` 这类常规轮询间隔保持前台;`sleep 0.5h`、`sleep 2m` 命中。
3. **必须以 ExecutionPort 支持后台生命周期为前提**(`supportsBashBackgroundLifecycle`):
   不支持的 port 上保持前台语义,不抛错——该守卫与显式后台路径同源。
4. **只匹配单条 sleep 命令**:`sleep 30 && sleep 40`、`timeout 5 sleep 60`、
   `sleep 30 && curl …` 都不命中(前者拼接罕见,后两者有非等待语义,误转有风险)。
5. 既有 `isBashAutoBackgroundEligible`(超时驱动 auto_on_timeout)行为不变,
   其对 sleep 的排除保持有效——转换后的命令已走 explicit 路径,不会双重进入。

## 与 spec 155 非目标的关系

155 的非目标是「前台 Bash **超时**自动转后台」——按超时把任意长命令转后台,
影响面大,仍不做。本 spec 是另一机制:**命令级识别纯等待**再转,范围收窄到
"唯一作用就是消耗时间"的命令。

## 状态所有者

- 识别与改写:`apps/zcode-cli/packages/core/src/tool/handlers/bash-background-policy.ts`
  (`isPureWaitBashCommand`)、`bash.ts`(handler 入口改写)
- 工具描述引导:`apps/zcode-cli/packages/contracts/src/tools/bash.ts`
  (`run_in_background` 字段描述:长等待优先后台)

## 验收

- 策略单测:`sleep 240`/`sleep 240s`/`sleep 2m`/`sleep 0.5h` 命中;
  `sleep 45` 不命中;`echo hi`、`timeout 5 sleep 60`、复合命令不命中;空命令不命中。
- handler 单测:`sleep 240` 在支持生命周期的 port 上以 explicit 模式进后台,
  输出 `status=backgrounded`;`sleep 45` 仍走前台 `run`;
  **不支持生命周期的 port 上 `sleep 240` 保持前台、不抛 ConfigurationError**。
- 静默命令的可见性(转后台后 UI 显示)由 spec 155 投影链路承接。
