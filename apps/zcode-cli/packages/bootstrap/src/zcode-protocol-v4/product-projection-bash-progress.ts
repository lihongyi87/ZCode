import {
  executionOutputPreviewSchema,
  type ConversationDelta,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  SessionEventType,
  type SessionEvent,
  type ToolCallProgressPayload,
  type ToolCallStartedPayload,
} from "@zcode/contracts";

/** 进度只能更新已运行的 Bash，不创建行、不把终态或后台任务复活。 */
export function projectToolActivity(
  event: SessionEvent,
  row: ToolCallRow | undefined,
): ConversationDelta[] {
  if (!row) return [];
  if (event.type === SessionEventType.ToolCallStarted) {
    const payload = event.payload as ToolCallStartedPayload;
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          status: "running",
          startedAt: event.timestamp.getTime(),
          ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
        },
      },
    ];
  }
  if (row.status !== "running" || row.backgrounded) return [];
  const payload = event.payload as ToolCallProgressPayload;

  // TaskOutput 阻塞等待心跳(spec 155):elapsedMs+message 进 row.progress,
  // 否则「已等待/上限/输出规模」永远到不了 v4 UI,等待看起来像卡死。
  if (row.toolName === "TaskOutput") {
    if (payload.elapsedMs === undefined && payload.message === undefined) return [];
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          progress: {
            ...(payload.elapsedMs !== undefined ? { elapsedMs: payload.elapsedMs } : {}),
            ...(payload.message !== undefined ? { message: payload.message.slice(0, 200) } : {}),
            updatedAt: event.timestamp.getTime(),
          },
        },
      },
    ];
  }

  if (row.toolName !== "Bash") return [];
  const parsed = executionOutputPreviewSchema.safeParse(payload.outputPreview);
  if (!parsed.success) return [];
  // spec 155:Bash 的 outputBytes 进 row.progress——0 字节=真静默可见。
  const progress =
    payload.outputBytes !== undefined
      ? { bytes: payload.outputBytes, updatedAt: event.timestamp.getTime() }
      : undefined;
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        outputPreview: parsed.data,
        ...(progress ? { progress } : {}),
      },
    },
  ];
}

/** 统一在投影事务中清掉预览，涵盖 result/error、Stop、转后台与轮次收口。 */
export function clearSettledOutputPreviews(deltas: ConversationDelta[]): ConversationDelta[] {
  return deltas.map((delta) => {
    if (
      (delta.op !== "row.upserted" && delta.op !== "row.appended") ||
      delta.row.kind !== "toolCall" ||
      !delta.row.outputPreview ||
      (delta.row.status === "running" && !delta.row.backgrounded)
    )
      return delta;
    const { outputPreview: _preview, ...row } = delta.row;
    return { ...delta, row };
  });
}
