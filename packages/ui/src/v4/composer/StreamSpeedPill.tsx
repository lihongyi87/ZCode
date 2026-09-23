import { memo, useEffect, useRef, useState } from "react";
import type { SessionUsageState } from "@zcode/shared/zcode-protocol-v4";

/**
 * 输出速度药丸 v2（吸收自 deepseek-harness StatsPills，口径按本仓数据面重做）。
 *
 * v1 教训：用「相邻两次 usage 下发的墙时差」当分母，工具执行、权限等待、排队
 * 时间全部落进分母，agent 循环下读数被严重稀释（实测 7.9 tok/s，纯解码 30+）。
 *
 * v2 口径：以 `streamingChars`（流式文本字符数，每个 delta 批次增长）的增长区间
 * 界定"一步的纯流式时段"——起点=首个 delta tick，终点=最后一个 delta tick（不是
 * usage 到达时刻，工具时间天然落在区间外）。步完成（usage 增长）时用累计
 * outputTokens 差分拿该步精确 token 数 → 速度 = stepTokens / 流式毫秒，滑窗平均。
 * 字符→token 系数用已完成步自校准（EWMA），流式中以该系数给实时估算。
 */

/** 滑动窗口：只统计最近该时长内的已完成步样本。 */
const WINDOW_MS = 180_000;
/** 单步流式时长上限：超过视为异常（中断残留/挂起），弃样不入窗。 */
const MAX_STEP_MS = 120_000;
/** 流式时段下限：短于该值（如纯工具步几乎无文本）噪音大，弃样。 */
const MIN_STEP_MS = 300;
/** 残留区间判定：turn 结束后超过该时长无 tick 的未闭合区间视为中断残留。 */
const STALE_MS = 2_000;
/** 初始 tokens-per-char 估计（中英混合保守值），由已完成步 EWMA 自校准。 */
const INITIAL_TOKENS_PER_CHAR = 0.3;
/** EWMA 平滑系数。 */
const FACTOR_ALPHA = 0.4;

interface StepSample {
  tokens: number;
  ms: number;
  at: number;
}

interface StreamSpan {
  startAt: number;
  charsStart: number;
  tokensStart: number;
  lastTickAt: number;
}

function windowSpeed(samples: StepSample[]): number | null {
  let totalTokens = 0;
  let totalMs = 0;
  for (const sample of samples) {
    totalTokens += sample.tokens;
    totalMs += sample.ms;
  }
  return totalMs > 0 ? (totalTokens / totalMs) * 1000 : null;
}

function useStreamSpeed(
  usage: SessionUsageState | null | undefined,
  streamingChars: number,
  active: boolean,
): { speed: number | null; live: boolean } {
  const outputTokens = usage?.cumulative.outputTokens ?? null;

  const tokensRef = useRef<number | null>(outputTokens);
  const charsRef = useRef(0);
  const spanRef = useRef<StreamSpan | null>(null);
  const samplesRef = useRef<StepSample[]>([]);
  const factorRef = useRef(INITIAL_TOKENS_PER_CHAR);
  const [state, setState] = useState<{ speed: number | null; live: boolean }>({
    speed: null,
    live: false,
  });

  // 步完成结算（必须先于流式 tick 效果执行）：turn 收尾那一帧里 usage 更新与
  // active 翻 false 同时发生，若 tick 先跑会抢先清掉未结算区间并把 token 基线
  // 推到新值，导致本效果误判「无增长」而清空整个窗口（实测回复结束即清零）。
  // 因此 token 基线只归本效果所有。
  useEffect(() => {
    if (outputTokens === null) return;
    const prevTokens = tokensRef.current;
    tokensRef.current = outputTokens;
    if (prevTokens === null || outputTokens <= prevTokens) {
      // 新会话/回退：清窗重记。
      samplesRef.current = [];
      spanRef.current = null;
      setState({ speed: null, live: false });
      return;
    }
    const span = spanRef.current;
    if (!span) return;
    spanRef.current = null;
    const stepTokens = outputTokens - span.tokensStart;
    const stepMs = span.lastTickAt - span.startAt;
    const stepChars = charsRef.current - span.charsStart;
    if (stepTokens <= 0 || stepMs < MIN_STEP_MS || stepMs > MAX_STEP_MS) return;
    samplesRef.current = [
      ...samplesRef.current.filter((sample) => Date.now() - sample.at <= WINDOW_MS),
      { tokens: stepTokens, ms: stepMs, at: Date.now() },
    ];
    if (stepChars > 0) {
      const measured = stepTokens / stepChars;
      factorRef.current = factorRef.current * (1 - FACTOR_ALPHA) + measured * FACTOR_ALPHA;
    }
    setState({ speed: windowSpeed(samplesRef.current), live: false });
  }, [outputTokens]);

  // 流式 tick：delta 批次到达（streamingChars 增长）时维护流式区间与实时估算。
  // 不碰 token 基线（归结算效果所有）；turn 结束只熄灭 live 标记，区间留给
  // 结算效果处理，只有陈旧（>STALE_MS 无 tick）的残留区间才就地丢弃。
  useEffect(() => {
    const now = Date.now();
    if (!active || streamingChars < charsRef.current) {
      charsRef.current = streamingChars;
      const stale = spanRef.current;
      if (stale && now - stale.lastTickAt > STALE_MS) spanRef.current = null;
      setState((prev) => (prev.live ? { speed: prev.speed, live: false } : prev));
      return;
    }
    if (streamingChars === charsRef.current) return;
    const span = spanRef.current;
    if (!span) {
      // 没有已知 usage 基线时无法结算步 token，不开区间（基线照常维护）。
      if (tokensRef.current === null) return;
      spanRef.current = {
        startAt: now,
        charsStart: charsRef.current,
        tokensStart: tokensRef.current,
        lastTickAt: now,
      };
      charsRef.current = streamingChars;
      setState((prev) => ({ speed: prev.speed, live: true }));
      return;
    }
    span.lastTickAt = now;
    charsRef.current = streamingChars;
    const streamedChars = streamingChars - span.charsStart;
    const elapsedMs = now - span.startAt;
    if (streamedChars > 0 && elapsedMs > MIN_STEP_MS) {
      const estimate = (streamedChars * factorRef.current * 1000) / elapsedMs;
      setState((prev) =>
        prev.live && prev.speed !== null && Math.abs(prev.speed - estimate) < 0.5
          ? prev
          : { speed: estimate, live: true },
      );
    }
  }, [active, streamingChars, outputTokens]);

  return state;
}

/** 显示口径对齐 dsh：≥10 取整，<10 保留一位小数。 */
function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

export interface StreamSpeedPillProps {
  usage: SessionUsageState | null | undefined;
  streamingChars: number;
  active: boolean;
  title: string;
}

/** 常驻显示：无样本时显示 "--"，流式中显示实时估算（尾随 ·），空闲显示最近窗口精确均值。 */
export const StreamSpeedPill = memo(function StreamSpeedPill({
  usage,
  streamingChars,
  active,
  title,
}: StreamSpeedPillProps) {
  const { speed, live } = useStreamSpeed(usage, streamingChars, active);
  return (
    <span
      title={title}
      data-testid="v4-stream-speed"
      className="mr-2 inline-flex shrink-0 items-center gap-1 text-ui-xs text-foreground-subtle"
    >
      <span className="font-mono">{speed === null ? "--" : formatTokensPerSecond(speed)}</span>
      <span>tok/s</span>
      {live && (
        <span aria-hidden className="text-foreground-subtlest">
          ·
        </span>
      )}
    </span>
  );
});
