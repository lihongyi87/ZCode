import { describe, expect, it } from "vitest";
import type { ToolArtifactWriteRequest } from "@zcode/contracts";
import { serializeOutput } from "../src/tool/executor/result-serialization.js";
import { fitContentHeadTailWithSuffix } from "../src/tool/executor/result-content-projection.js";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";

// spec 159(DSH spill 吸收):无显式 resultBudget 的工具超预算时,全文落 artifactStore,
// 模型收到首尾保留 + 省略标记 + 取回指引;存储不可用回退 head 截断。
// 显式 artifact 策略工具(bash)行为不受影响。
const plainEntry = { ...bashToolEntry, resultBudget: undefined };

interface BashOutputShape {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  status: string;
}

function bashOutput(stdout: string): BashOutputShape {
  return { stdout, stderr: "", interrupted: false, status: "completed" };
}

class RecordingSpillStore {
  requests: ToolArtifactWriteRequest[] = [];
  fail = false;

  async writeToolResultArtifact(request: ToolArtifactWriteRequest) {
    if (this.fail) throw new Error("disk full");
    this.requests.push(request);
    const id = `spill-${this.requests.length}`;
    return {
      id,
      uri: `zcode-artifact://sess/${id}`,
      path: `/artifacts/${id}.txt`,
      bytes: Buffer.byteLength(request.content, "utf8"),
      contentType: request.contentType ?? "text/plain",
      createdAt: new Date(),
    };
  }
}

function minimalToolExecutorDeps(store?: RecordingSpillStore): ToolExecutorDeps {
  return {
    defaultTimeoutMs: 300_000,
    emitEvent: async () => {},
    getMode: () => "build",
    getWorkingDirectory: () => "/tmp",
    getWorkspaceRoot: () => "/tmp",
    maxConcurrency: 1,
    permissionBroker: {} as ToolExecutorDeps["permissionBroker"],
    permissionService: {} as ToolExecutorDeps["permissionService"],
    readFileState: new Map(),
    sessionId: "sess-spill",
    turnId: "turn-1",
    ...(store ? { artifactStore: store } : {}),
  } as ToolExecutorDeps;
}

describe("fitContentHeadTailWithSuffix (spec 159 纯函数)", () => {
  it("短于预算时内容与后缀原样保留", () => {
    expect(fitContentHeadTailWithSuffix("abc", 100, "END")).toBe("abcEND");
  });

  it("超预算时首尾按原序保留且总字节不超预算", () => {
    const content = `HEADMARK\n${"x".repeat(200_000)}\nTAILMARK`;
    const suffix = "\n\n[spilled: fullOutput=/artifacts/1.txt]";
    const projected = fitContentHeadTailWithSuffix(content, 10_000, suffix);
    expect(Buffer.byteLength(projected, "utf8")).toBeLessThanOrEqual(10_000);
    expect(projected.startsWith("HEADMARK")).toBe(true);
    expect(projected.endsWith("TAILMARK" + suffix)).toBe(true);
    const markerIndex = projected.indexOf("[... middle omitted");
    expect(markerIndex).toBeGreaterThan(0);
    expect(projected.indexOf("TAILMARK")).toBeGreaterThan(markerIndex);
  });

  it("UTF-8 多字节字符不截半(无替换字符)", () => {
    const content = "汉".repeat(30_000);
    const projected = fitContentHeadTailWithSuffix(content, 9_999, "END");
    expect(projected.includes("\uFFFD")).toBe(false);
    expect(Buffer.byteLength(projected, "utf8")).toBeLessThanOrEqual(9_999);
  });

  it("剩余预算装不下省略标记时退化为 head + 后缀", () => {
    const content = "y".repeat(5_000);
    const projected = fitContentHeadTailWithSuffix(content, 40, "SUFFIX");
    expect(projected.includes("[... middle omitted")).toBe(false);
    expect(projected.endsWith("SUFFIX")).toBe(true);
  });
});

describe("serializeOutput spill 接线 (spec 159 集成)", () => {
  const bigStdout = `HEADMARK\n${"x".repeat(120_000)}\nTAILMARK`;

  it("无 resultBudget 工具超预算:全文落库,替换内容含首尾+路径+取回指引", async () => {
    const store = new RecordingSpillStore();
    const result = await serializeOutput(
      minimalToolExecutorDeps(store),
      bashOutput(bigStdout),
      plainEntry,
      {},
      "tool_spill_1",
      new AbortController().signal,
    );
    expect(store.requests).toHaveLength(1);
    expect(store.requests[0]?.content).toContain("TAILMARK");
    expect(result.truncated).toBe(true);
    expect(result.artifactPath).toBe("/artifacts/spill-1.txt");
    expect(result.content).toContain("HEADMARK");
    expect(result.content).toContain("TAILMARK");
    expect(result.content).toContain("spilled by resultBudget");
    expect(result.content).toContain("fullOutput=/artifacts/spill-1.txt");
    expect(result.content).toContain("Retrieve omitted parts with Read");
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(100_000);
    expect(result.returnedBytes).toBe(Buffer.byteLength(result.content, "utf8"));
  });

  it("store 抛错:回退 head 截断,不失败", async () => {
    const store = new RecordingSpillStore();
    store.fail = true;
    const result = await serializeOutput(
      minimalToolExecutorDeps(store),
      bashOutput(bigStdout),
      plainEntry,
      {},
      "tool_spill_2",
      new AbortController().signal,
    );
    expect(result.content).toContain("[Tool output truncated by resultBudget");
    expect(result.content).not.toContain("spilled by resultBudget");
    expect(result.content).toContain("HEADMARK");
    expect(result.truncated).toBe(true);
  });

  it("无 artifactStore(纯 CLI):同样回退 head 截断", async () => {
    const result = await serializeOutput(
      minimalToolExecutorDeps(),
      bashOutput(bigStdout),
      plainEntry,
      {},
      "tool_spill_3",
      new AbortController().signal,
    );
    expect(result.content).toContain("[Tool output truncated by resultBudget");
  });

  it("显式 artifact 策略工具(bash)行为不变", async () => {
    const store = new RecordingSpillStore();
    const result = await serializeOutput(
      minimalToolExecutorDeps(store),
      bashOutput(bigStdout),
      bashToolEntry,
      {},
      "tool_spill_4",
      new AbortController().signal,
    );
    expect(result.content).toContain("<persisted-output>");
    expect(result.content).not.toContain("spilled by resultBudget");
  });
});
