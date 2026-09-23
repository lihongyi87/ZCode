import { memo, useEffect, useRef, useState } from "react";
import type { SessionUsageState } from "@zcode/shared/zcode-protocol-v4";

/**
 * 输出速度药丸（吸收自 deepseek-harness 的 StatsPills「tok/s」读数）。
 *
 * 数据源是 v4 usage 投影：CLI 在每个模型步完成（ModelComplete）时 conflated 下发
 * `cumulative.outputTokens` 累计值，这里对相邻两次下发做差分估计速度。
 *
 * 口径与 dsh 的差异（如实说明）：dsh 用服务端记录的 TTFT/解码墙时做精确切分，
 * 排除步间工具时间；本仓协议层 usage 事件不携带这些时刻，UI 侧差分的分母是
 * 两次下发的墙时差，包含步间短暂工具耗时——读数相对纯解码速度**偏低**（保守
 * 口径，不虚高）。更新粒度与 dsh 一致：每个模型步完成时刷新一次。
 */

/** 相邻两次 usage 更新的最大计入间隔：超过视为停顿（长工具执行/空闲），该样本对不入窗。 */
const MAX_STEP_GAP_MS = 90_000;
/** 滑动窗口：只统计最近该时长内的样本对，窗口靠更新时修剪自然过期，无需定时器。 */
const WINDOW_MS = 180_000;

interface SpeedSample {
  deltaTokens: number;
  deltaMs: number;
  at: number;
}

function useStreamSpeed(usage: SessionUsageState | null | undefined): number | null {
  const outputTokens = usage?.cumulative.outputTokens ?? null;
  const lastRef = useRef<{ outputTokens: number; at: number } | null>(null);
  const samplesRef = useRef<SpeedSample[]>([]);
  const [speed, setSpeed] = useState<number | null>(null);

  useEffect(() => {
    if (outputTokens === null) {
      lastRef.current = null;
      samplesRef.current = [];
      setSpeed(null);
      return;
    }
    const now = Date.now();
    const last = lastRef.current;
    lastRef.current = { outputTokens, at: now };
    if (!last) return;
    const deltaTokens = outputTokens - last.outputTokens;
    const deltaMs = now - last.at;
    if (deltaTokens <= 0) {
      // 累计值不增（新会话/重放回退）：视为边界，清空窗口重记。
      samplesRef.current = [];
      setSpeed(null);
      return;
    }
    if (deltaMs <= 0 || deltaMs > MAX_STEP_GAP_MS) return;
    const samples = [
      ...samplesRef.current.filter((sample) => now - sample.at <= WINDOW_MS),
      { deltaTokens, deltaMs, at: now },
    ];
    samplesRef.current = samples;
    let totalTokens = 0;
    let totalMs = 0;
    for (const sample of samples) {
      totalTokens += sample.deltaTokens;
      totalMs += sample.deltaMs;
    }
    setSpeed(totalMs > 0 ? (totalTokens / totalMs) * 1000 : null);
  }, [outputTokens]);

  return speed;
}

/** 显示口径对齐 dsh：≥10 取整，<10 保留一位小数。 */
function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

export interface StreamSpeedPillProps {
  usage: SessionUsageState | null | undefined;
  title: string;
}

/** 无样本（未产生过两个相邻 usage 更新）时整体不渲染。 */
export const StreamSpeedPill = memo(function StreamSpeedPill({
  usage,
  title,
}: StreamSpeedPillProps) {
  const speed = useStreamSpeed(usage);
  if (speed === null) return null;
  return (
    <span
      title={title}
      data-testid="v4-stream-speed"
      className="inline-flex shrink-0 items-center gap-1 text-ui-xs text-foreground-subtle"
    >
      <span className="font-mono">{formatTokensPerSecond(speed)}</span>
      <span>tok/s</span>
    </span>
  );
});
