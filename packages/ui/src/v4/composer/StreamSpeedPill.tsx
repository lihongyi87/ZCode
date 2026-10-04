import { memo, useEffect, useRef, useState } from "react";
import type { SessionUsageState } from "@zcode/shared/zcode-protocol-v4";

/**
 * 输出速度药丸 v3（吸收自 deepseek-harness StatsPills，口径按本仓数据面重做）。
 *
 * v1 教训：用「相邻两次 usage 下发的墙时差」当分母，工具执行、权限等待、排队
 * 时间全部落进分母，agent 循环下读数被严重稀释（实测 7.9 tok/s，纯解码 30+）。
 *
 * v2 口径：以 `streamingChars`（流式文本字符数，每个 delta 批次增长）的增长区间
 * 界定"一步的纯流式时段"——起点=首个 delta tick，终点=最后一个 delta tick（不是
 * usage 到达时刻，工具时间天然落在区间外）。步完成（usage 增长）时用累计
 * outputTokens 差分拿该步精确 token 数 → 速度 = stepTokens / 流式毫秒，滑窗平均。
 * 字符→token 系数用已完成步自校准（EWMA），流式中以该系数给实时估算。
 *
 * v3 教训（实测经常飙到上万）：v2 度量的是**到达时间**，不是解码时间。GLM 网关
 * 重连后（Reconnecting N/10 高发）重放/缓冲一次性冲刷——数千字符在数百毫秒内
 * 到达，隐含速度破万。解码是自回归串行的，真实解码 30-120 tok/s；单流隐含速度
 * 超过解码合理上限的必是到达压缩伪象。v3 双向防护：
 * - 落窗样本：隐含速度超上限 → 弃样（不污染窗口均值）；
 * - 实时估算：超上限按上限显示，且向上一读数收敛一半（抗单批次抖动）。
 * 字符→token 密度（EWMA）不受弃样影响——密度与时间无关，突发步照样提供标定。
 */

/** 滑动窗口：只统计最近该时长内的已完成步样本。 */
const WINDOW_MS = 180_000;
/** 单步流式时长上限：超过视为异常（中断残留/挂起），弃样不入窗。 */
const MAX_STEP_MS = 120_000;
/** 流式时段下限：短于该值（如纯工具步几乎无文本）噪音大，弃样。 */
const MIN_STEP_MS = 300;
/**
 * 解码合理上限（tok/s）：自回归解码串行生成，单流持续高于此值必是到达侧伪象
 * （重连重放/缓冲一次性冲刷）。覆盖现有 GLM 全系峰值解码（flash 系 ~200）。
 */
const MAX_PLAUSIBLE_TPS = 400;
/** 单步最小 token 数：更小的步信噪比太差（延迟抖动主导），不进窗口。 */
const MIN_STEP_TOKENS = 50;
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

/** 样本有效性：时长区间内、token 量够、隐含速度不超解码合理上限（防冲刷伪象）。 */
export function isPlausibleStepSample(tokens: number, ms: number): boolean {
  if (!Number.isFinite(tokens) || !Number.isFinite(ms) || tokens < MIN_STEP_TOKENS) return false;
  if (ms < MIN_STEP_MS || ms > MAX_STEP_MS) return false;
  return (tokens / ms) * 1000 <= MAX_PLAUSIBLE_TPS;
}

/** 实时估算防冲刷：先按解码合理上限截断，再向上一读数收敛一半（抗单批次抖动）。 */
export function smoothLiveEstimate(previous: number | null, rawEstimate: number): number {
  const bounded = Math.min(Math.max(rawEstimate, 0), MAX_PLAUSIBLE_TPS);
  if (!Number.isFinite(bounded)) {
    // NaN/Infinity 防御：有上一读数就保持，没有就归零——绝不显示 NaN。
    return previous !== null && Number.isFinite(previous) ? previous : 0;
  }
  if (previous === null || !Number.isFinite(previous)) return bounded;
  return previous + (bounded - previous) * 0.5;
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
    // 密度标定与弃样解耦：chars→tokens 密度与时间无关，突发步（被弃样）照样
    // 提供真实密度，EWMA 不因防冲刷而丢标定数据。
    if (stepTokens > 0 && stepChars > 0) {
      const measured = stepTokens / stepChars;
      factorRef.current = factorRef.current * (1 - FACTOR_ALPHA) + measured * FACTOR_ALPHA;
    }
    if (!isPlausibleStepSample(stepTokens, stepMs)) return;
    samplesRef.current = [
      ...samplesRef.current.filter((sample) => Date.now() - sample.at <= WINDOW_MS),
      { tokens: stepTokens, ms: stepMs, at: Date.now() },
    ];
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
      const raw = (streamedChars * factorRef.current * 1000) / elapsedMs;
      setState((prev) => {
        const estimate = smoothLiveEstimate(prev.live ? prev.speed : null, raw);
        return prev.live && prev.speed !== null && Math.abs(prev.speed - estimate) < 0.5
          ? prev
          : { speed: estimate, live: true };
      });
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
  /** 缓存命中率段的本地化文案（如「缓存命中」）。 */
  cacheLabel: string;
}

/** 常驻显示：无样本时速度显示 "--"，流式中显示实时估算（尾随 ·），空闲显示最近窗口精确均值。
 * 缓存命中段复用运行时自己的 hitRate（usage.contextWindow.cache），有数据才显示——
 * 不设 78% 展示阈值：本药丸的定位是通道效率监控，低命中恰恰是要看见的信号。 */
export const StreamSpeedPill = memo(function StreamSpeedPill({
  usage,
  streamingChars,
  active,
  title,
  cacheLabel,
}: StreamSpeedPillProps) {
  const { speed, live } = useStreamSpeed(usage, streamingChars, active);
  const hitRate = usage?.contextWindow?.cache?.hitRate ?? null;
  const cacheText =
    hitRate !== null && Number.isFinite(hitRate)
      ? `${cacheLabel} ${Math.round(Math.max(0, hitRate) * 100)}%`
      : null;
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
      {cacheText !== null && (
        <>
          <span aria-hidden className="text-foreground-subtlest">
            ·
          </span>
          <span data-testid="v4-stream-cache">{cacheText}</span>
        </>
      )}
    </span>
  );
});
