import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TASK_OUTPUT_TOOL_NAME = "TaskOutput";
export const TASK_OUTPUT_ALIASES = [
  "AgentOutputTool",
  "BashOutputTool",
  "AgentOutput",
  "BashOutput",
] as const;

export const TASK_OUTPUT_PROVIDER_DESCRIPTION = `Wait for a background task and retrieve its output (background shell, agent, or remote session).

PREFERRED way to wait on any long-running background task: call with block=true instead of sleeping in a loop (e.g. "sleep 300 && tail the log"). The wait is event-driven — it returns as soon as the task completes or the timeout elapses, and a <task-notification> with the output file path is also delivered on exit. timeout is capped at 600000 ms (10 minutes); for longer tasks, call again to keep waiting.

Expected wait over ~60s (slow builds, long installs, full test suites): prefer block=false, do other work, and poll again — holding a long blocking wait wastes the turn and gives the user a frozen-looking surface. The summary line shows the blocking cap and output-file size while waiting.

Reading results:
- For bash tasks: the output file path contains stdout/stderr — prefer the Read tool on that path.
- For local_agent tasks: use the Agent tool result directly. Do NOT Read the .output file — it is a symlink to the full subagent conversation transcript (JSONL) and will overflow your context window.
- For remote_agent tasks: prefer Read on the output file path — it contains the streamed remote session output (same as bash).

Also supports block=false for a non-blocking status check. Task IDs can be found using the /tasks command. Works with all task types: background shells, async agents, and remote sessions.`;

export const TaskOutputInputSchema = z
  .object({
    task_id: z.string().describe("The task ID to get output from"),
    block: semanticBoolean(z.boolean().default(true)).describe("Whether to wait for completion"),
    timeout: z.number().min(0).max(600_000).default(30_000).describe("Max wait time in ms"),
  })
  .strict();

export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>;

export const TaskOutputInputJsonSchema = {
  ...toToolJsonSchema(TaskOutputInputSchema),

  // 的 provider schema 仍要求模型显式传入 task_id、block 和 timeout。
  required: ["task_id", "block", "timeout"],
};

export const TaskOutputTaskSchema = z
  .object({
    task_id: z.string(),
    task_type: z.string(),
    status: z.string(),
    description: z.string(),
    output: z.string(),
    exitCode: z.number().nullable().optional(),
    error: z.string().optional(),
    prompt: z.string().optional(),
    result: z.string().optional(),
    outputFile: z.string().optional(),
  })
  .strict();

export type TaskOutputTask = z.infer<typeof TaskOutputTaskSchema>;

export const TaskOutputResultSchema = z
  .object({
    retrieval_status: z.enum(["success", "not_ready", "timeout"]),
    task: TaskOutputTaskSchema.nullable(),
  })
  .strict();

export type TaskOutputResult = z.infer<typeof TaskOutputResultSchema>;

export const TaskOutputResultJsonSchema = toToolJsonSchema(TaskOutputResultSchema);

function semanticBoolean(
  schema: z.ZodDefault<z.ZodBoolean>,
): z.ZodEffects<z.ZodDefault<z.ZodBoolean>, boolean, unknown> {
  return z.preprocess((value) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }, schema);
}
