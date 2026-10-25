import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

/**
 * spec 154：会话声明订阅式主动编排（proactive subscriptions）。
 *
 * 模型/用户显式声明「当 sourceId 会话发生 event 时，用 prompt 唤醒我」——
 * 这是自动接力的唯一入口；没有订阅就没有唤醒。
 */

export const PROACTIVE_SUBSCRIBE_TOOL_NAME = "ProactiveSubscribe";

export const PROACTIVE_SUBSCRIBE_EVENTS = [
  "mailbox_message",
  "automation_due",
  "task_completed",
  "task_failed",
] as const;

export const ProactiveSubscribeInputSchema = z
  .object({
    subscriptions: z
      .array(
        z
          .object({
            event: z
              .enum(PROACTIVE_SUBSCRIBE_EVENTS)
              .describe(
                "Event to wake on. mailbox_message = the source session sent this session a task message.",
              ),
            sourceId: z
              .string()
              .min(1)
              .max(200)
              .describe("Session id whose events wake this session (e.g. sess_xxx)."),
            prompt: z
              .string()
              .min(1)
              .max(20_000)
              .describe(
                "Prompt injected into this session when the event fires. Continue the handoff work here.",
              ),
          })
          .strict(),
      )
      .max(20)
      .optional()
      .describe(
        "Full replacement subscription set. Pass [] to clear all subscriptions; omit to keep the current set (e.g. when only toggling status).",
      ),
    status: z
      .enum(["running", "paused"])
      .optional()
      .describe(
        "running = subscriptions active (default). paused = keep subscriptions but stop waking this session.",
      ),
  })
  .strict();

export type ProactiveSubscribeInput = z.infer<typeof ProactiveSubscribeInputSchema>;

export const ProactiveSubscribeInputJsonSchema = toToolJsonSchema(ProactiveSubscribeInputSchema);

export const ProactiveSubscribeOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    generation: z.number().int().nonnegative().optional(),
    subscriptionCount: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();

export type ProactiveSubscribeOutput = z.infer<typeof ProactiveSubscribeOutputSchema>;

export const ProactiveSubscribeOutputJsonSchema = toToolJsonSchema(ProactiveSubscribeOutputSchema);
