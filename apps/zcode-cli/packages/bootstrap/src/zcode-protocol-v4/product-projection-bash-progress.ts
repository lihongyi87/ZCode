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
  // spec 155:Bash 的 outputBytes 进 row.progress——0 字节=真静默可见。
  const progress =
    payload.outputBytes !== undefined
      ? { bytes: payload.outputBytes, updatedAt: event.timestamp.getTime() }
      : undefined;
  // 修复原因(用户实测 `sleep 240s` 看起来像卡死):静默命令没有 stdout/stderr,
  // 因此没有 outputPreview。旧实现要求 preview 解析成功才放行,把「零输出」这唯一
  // 需要字节可见性的场景整条丢弃——UI 只剩转圈。预览与进度改为各自独立:
  // 有 preview 才写 preview,有 outputBytes 就写 progress。
  if (!parsed.success && progress === undefined) return [];
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        ...(parsed.success ? { outputPreview: parsed.data } : {}),
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
