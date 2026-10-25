import type { ToolProgress } from "@zcode/shared/zcode-protocol-v4";
import { toolProgressSchema } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatElapsedDuration } from "@/lib/elapsedDuration.js";

export const TID_TOOL_CALL_PROGRESS = "tool-call-progress";

/** 从 legacy raw 读出投影的运行中进度（toolCallRowAdapter 透传 ToolCallRow.progress）。 */
export function readToolCallProgress(raw: unknown): ToolProgress | null {
  if (typeof raw !== "object" || raw === null) return null;
  const parsed = toolProgressSchema.safeParse((raw as { progress?: unknown }).progress);
  return parsed.success ? parsed.data : null;
}

/**
 * 工具摘要行里的细进度条（）：有 fraction 用 determinate，否则 indeterminate 扫光；
 * message 跟在后面，elapsedMs 以「已等待 N 秒」显示——长等待（如 TaskOutput 阻塞）
 * 没有百分比，时长本身就是进度信号，不能只剩转圈。
 * 颜色只用 brand / surface token，遵守 DESIGN.md。
 */
export function ToolCallProgressIndicator({ progress }: { progress: ToolProgress }) {
  const { intl } = useZCodeIntl();
  const fraction = progress.fraction;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-2"
      data-testid={TID_TOOL_CALL_PROGRESS}
      {...(fraction !== undefined ? { "data-fraction": fraction.toFixed(3) } : {})}
      {...(progress.elapsedMs !== undefined
        ? { "data-elapsed-ms": String(Math.round(progress.elapsedMs)) }
        : {})}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={1}
      {...(fraction !== undefined ? { "aria-valuenow": fraction } : {})}
    >
      <span className="text-foreground-subtlest">·</span>
      <span className="relative inline-block h-1 w-16 shrink-0 overflow-hidden rounded-full bg-surface-hover">
        {fraction !== undefined ? (
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-brand transition-[width] duration-200"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        ) : (
          <span className="tool-call-progress-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-brand" />
        )}
      </span>
      {progress.elapsedMs !== undefined ? (
        <span
          className="shrink-0 text-ui-sm tabular-nums text-foreground-subtle"
          data-testid={`${TID_TOOL_CALL_PROGRESS}-elapsed`}
        >
          {intl.formatMessage(
            { id: "chat.toolCall.progress.waited" },
            { duration: formatElapsedDuration(progress.elapsedMs) },
          )}
          {formatProgressBytesSuffix(progress)}
        </span>
      ) : null}
      {progress.message ? (
        <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">
          {formatProgressMessage(progress.message, progress.elapsedMs !== undefined)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * 字节可见性(spec 155):管道/重定向命令的输出流为 0 时显示「暂无输出」,
 * 有产出时显示累计字节——「在干活」与「真静默」不再共享同一个转圈。
 */
function formatProgressBytesSuffix(progress: ToolProgress): string {
  if (progress.bytes === undefined) return "";
  return progress.bytes > 0 ? ` · 已收 ${formatProgressByteCount(progress.bytes)}` : " · 暂无输出";
}

/**
 * message 是工具自带的进度说明（目前唯一生产者是 TaskOutput 阻塞心跳），排在
 * 「已等待 N 秒」之后。CLI 侧 message 只描述阻塞上限与输出规模、不自带「已等待」，
 * 否则会重复成「已等待 / 阻塞上限 120s … 已等待 15 秒」。
 */
function formatProgressMessage(message: string, hasElapsedMs: boolean): string {
  return hasElapsedMs ? ` · ${message}` : message;
}

function formatProgressByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
