import { describe, expect, it } from "vitest";
import { HookEventName, type TraceContext } from "@zcode/contracts";
import { mkdtemp, readdir, readFile, rename, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SessionMailboxAppendInput,
  SessionMailboxEnvelope,
  SessionMailboxPort,
} from "@zcode/contracts";
import {
  createSessionMailboxHookRegistrations,
} from "../src/hooks/session-mailbox.js";

/**
 * 忠实复刻 NodeSessionMailboxAdapter 的 append/drain(filter 只计命中、非命中留存)
 * 契约,避免 core 测试依赖 adapters 包(分层)。adapter 自身语义由 adapters/tests
 * 覆盖;本文件的靶心是 hook 对契约的使用。
 */
function createFileMailbox(rootDir: string): SessionMailboxPort {
  const dir = (sessionId: string, kind: "read" | "unread") =>
    join(rootDir, sessionId, kind);
  return {
    async drainUnread(input, options) {
      const unreadDir = dir(input.sessionId, "unread");
      const readDir = dir(input.sessionId, "read");
      await mkdir(unreadDir, { recursive: true });
      await mkdir(readDir, { recursive: true });
      const entries = (await readdir(unreadDir)).filter((e) => e.endsWith(".json")).sort();
      const messages: SessionMailboxEnvelope[] = [];
      for (const entry of entries) {
        if (messages.length >= (input.limit ?? 20)) break;
        options?.signal?.throwIfAborted();
        const envelope = JSON.parse(
          await readFile(join(unreadDir, entry), "utf8"),
        ) as SessionMailboxEnvelope;
        if (input.filter && !input.filter(envelope)) continue;
        messages.push(envelope);
        await rename(join(unreadDir, entry), join(readDir, entry));
      }
      return messages;
    },
    async append(input: SessionMailboxAppendInput) {
      const unreadDir = dir(input.toSessionId, "unread");
      await mkdir(unreadDir, { recursive: true });
      const createdAt = new Date();
      const envelope: SessionMailboxEnvelope = {
        version: 1,
        messageId: `m-${Math.random().toString(36).slice(2)}`,
        fromSessionId: input.fromSessionId,
        toSessionId: input.toSessionId,
        content: input.content,
        createdAt: createdAt.toISOString(),
        ...(input.sourceType !== undefined ? { sourceType: input.sourceType } : {}),
        ...(input.sourceCommandId !== undefined ? { sourceCommandId: input.sourceCommandId } : {}),
        ...(input.depth !== undefined ? { depth: input.depth } : {}),
        ...(input.senderLabel !== undefined ? { senderLabel: input.senderLabel } : {}),
      };
      const fileName = `${String(createdAt.getTime()).padStart(15, "0")}-${envelope.messageId}.json`;
      await writeFile(join(unreadDir, fileName), JSON.stringify(envelope), "utf8");
      return envelope;
    },
  };
}

type HookInput = {
  hookEventName: HookEventName;
  traceId: string;
  turnId: string;
  signal?: undefined;
};

function trace(turnId: string): TraceContext {
  return { sessionId: "sess_b", traceId: "trace-1", turnId } as TraceContext;
}

async function createFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-mailbox-hook-"));
  const mailbox = createFileMailbox(rootDir);
  const steered: Array<{
    input: string;
    meta?: { steerSource?: "task_message"; wakeDepth?: number; fromSessionId: string };
  }> = [];
  const registrations = createSessionMailboxHookRegistrations({
    enqueuePendingInput: async (input, _trace, meta) => {
      steered.push({ input, meta });
    },
    mailbox,
    sessionId: "sess_b",
  });
  const postToolUse = registrations.find((r) => r.event === HookEventName.PostToolUse)!;
  const stop = registrations.find((r) => r.event === HookEventName.Stop)!;
  const prompt = registrations.find((r) => r.event === HookEventName.UserPromptSubmit)!;
  const runHook = (registration: typeof postToolUse, input: HookInput) =>
    registration.callback(input as never, { signal: new AbortController().signal } as never);
  return { mailbox, steered, runHook, postToolUse, stop, prompt };
}

describe("session mailbox hook task-message pipeline (spec 149)", () => {
  it("wakes an idle session only for anchored wakeable mail and passes depth/source", async () => {
    const { mailbox, steered, runHook, stop } = await createFixture();
    await mailbox.append({
      toSessionId: "sess_b",
      fromSessionId: "sess_a",
      content: "handoff",
      sourceType: "task",
      sourceCommandId: "cmd-1",
      depth: 2,
      senderLabel: "任务A",
    });
    // 无锚旧信封:必须留在 unread,不得唤醒。
    await mailbox.append({
      toSessionId: "sess_b",
      fromSessionId: "sess_x",
      content: "legacy",
    });

    const result = await runHook(stop, {
      hookEventName: HookEventName.Stop,
      traceId: "trace-1",
      turnId: "turn-9",
    });

    expect(result?.continue).toBe(true);
    expect(result?.hookSpecificOutput?.additionalContext).toContain("handoff");
    expect(result?.hookSpecificOutput?.additionalContext).toContain('sender_label="任务A"');
    expect(result?.hookSpecificOutput?.additionalContext).not.toContain("legacy");

    // 未唤醒的信封仍在 unread(等人驱动交付)。
    const stillUnread = await mailbox.drainUnread({ sessionId: "sess_b" });
    expect(stillUnread).toHaveLength(1);
    expect(stillUnread[0]?.content).toBe("legacy");
    expect(steered).toHaveLength(0);
  });

  it("steers a busy session at tool boundary and reports wake depth for chain increment", async () => {
    const { mailbox, steered, runHook, postToolUse, prompt } = await createFixture();
    await mailbox.append({
      toSessionId: "sess_b",
      fromSessionId: "sess_a",
      content: "steer me",
      sourceType: "task",
      sourceCommandId: "cmd-2",
      depth: 1,
    });

    await runHook(postToolUse, {
      hookEventName: HookEventName.PostToolUse,
      traceId: "trace-1",
      turnId: "turn-5",
    });

    expect(steered).toHaveLength(1);
    expect(steered[0]?.meta?.steerSource).toBe("task_message");
    expect(steered[0]?.meta?.wakeDepth).toBe(1);
    expect(steered[0]?.meta?.fromSessionId).toBe("sess_a");
    // 深度超限:照常可读交付(人驱动),但 busy 通道不 steer、idle 通道不唤醒。
    await mailbox.append({
      toSessionId: "sess_b",
      fromSessionId: "sess_a",
      content: "too deep",
      sourceType: "task",
      sourceCommandId: "cmd-3",
      depth: 9,
    });
    const steeredAgain = await runHook(postToolUse, {
      hookEventName: HookEventName.PostToolUse,
      traceId: "trace-1",
      turnId: "turn-5",
    });
    expect(steeredAgain).toBeUndefined();
    const humanDelivery = await runHook(prompt, {
      hookEventName: HookEventName.UserPromptSubmit,
      traceId: "trace-1",
      turnId: "turn-6",
    });
    expect(humanDelivery?.hookSpecificOutput?.additionalContext).toContain("too deep");
  });
});
