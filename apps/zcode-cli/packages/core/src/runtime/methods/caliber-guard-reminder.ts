import { join } from "node:path";
import type { FileSystemPort } from "@zcode/contracts";
import { latestRealUserText } from "./memory-recall-reminder.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

/**
 * 口径裁决护栏（P2）：已裁决口径（庚干四化/数字6=牢/用户已婚读盘口径等）
 * 在断盘/合参/报告产线全链路机器可见，堵住「口径翻案」类已发生事故
 * （负载取证：两起「勿再翻案」记忆 + 生产事故全是喂错料）。
 *
 * 数据契约（workspace 侧登记，ZCode 只读——注册表只存指针与裁决摘要，
 * 权威值文本仍在权威源，合铁律5.8）：
 *   <工作目录>/.zcode/caliber-registry.json = CaliberEntry[]
 *   { keys: string[], topic, authority, verdict, decidedAt }
 *
 * 触发面刻意收窄（审查修正）：复合键 ALL-IN 语义（每个 key 都出现在
 * 「本轮输入 或 已召回记忆正文」里才触发）——裸干支闲聊（单字命中）不误触。
 * 只注入裁决事实与权威源指引，无打分（合铁律6）。
 */

const REGISTRY_RELATIVE_PATH = join(".zcode", "caliber-registry.json");
const REGISTRY_TTL_MS = 60_000;

export interface CaliberEntry {
  /** 复合键：全部出现在触发文本面内才命中（AND）。 */
  keys: string[];
  /** 口径主题（如「紫微十天干四化·庚干」）。 */
  topic: string;
  /** 权威源指引（文件路径+符号，如 ziwei_base.py:52 SIHUA 常量）。 */
  authority: string;
  /** 裁决摘要（一句话，含「勿翻案」性质）。 */
  verdict: string;
  /** 裁决日期。 */
  decidedAt: string;
}

interface RegistrySlot {
  at: number;
  entries: CaliberEntry[] | null; // null = 文件缺失/损坏，缓存「无注册表」
}

const registryCache = new WeakMap<object, RegistrySlot>();

export function matchCaliberEntries(
  texts: readonly string[],
  entries: readonly CaliberEntry[],
): CaliberEntry[] {
  const haystacks = texts.map((text) => text.toLowerCase());
  return entries.filter((entry) => {
    if (!Array.isArray(entry.keys) || entry.keys.length === 0) return false;
    return entry.keys.every((key) =>
      haystacks.some((haystack) => haystack.includes(String(key).toLowerCase())),
    );
  });
}

async function loadRegistry(
  runtime: object,
  fileSystem: FileSystemPort,
  workingDirectory: string,
): Promise<CaliberEntry[] | null> {
  const now = Date.now();
  const slot = registryCache.get(runtime);
  if (slot && now - slot.at <= REGISTRY_TTL_MS) return slot.entries;
  let entries: CaliberEntry[] | null = null;
  try {
    const read = await fileSystem.readTextFile({
      path: join(workingDirectory, REGISTRY_RELATIVE_PATH),
    });
    const parsed = JSON.parse(read.content) as unknown;
    if (Array.isArray(parsed)) {
      entries = parsed.filter(
        (item): item is CaliberEntry =>
          typeof item === "object" &&
          item !== null &&
          Array.isArray((item as CaliberEntry).keys) &&
          typeof (item as CaliberEntry).topic === "string" &&
          typeof (item as CaliberEntry).verdict === "string",
      );
    }
  } catch {
    entries = null; // 未登记/读失败/非法 JSON：静默无护栏
  }
  registryCache.set(runtime, { at: now, entries });
  return entries;
}

export interface CaliberGuardReminderInput {
  runtime: object;
  fileSystem: FileSystemPort;
  workingDirectory: string;
  entries: readonly RuntimeMessageEntry[];
  /** 本轮已召回的 memory/kb 提醒正文（锚点标题/路径参与命中面）。 */
  recalledText?: string | null;
}

/** 返回护栏正文；未登记/无命中返回 null。 */
export async function buildCaliberGuardReminderBody(
  input: CaliberGuardReminderInput,
): Promise<string | null> {
  const registry = await loadRegistry(input.runtime, input.fileSystem, input.workingDirectory);
  if (registry === null || registry.length === 0) return null;
  const query = latestRealUserText(input.entries) ?? "";
  const triggerTexts = [query, input.recalledText ?? ""].filter((text) => text.length > 0);
  const matched = matchCaliberEntries(triggerTexts, registry);
  if (matched.length === 0) return null;
  const lines = [
    "以下口径已由用户裁决定案——断盘/合参/报告必须按裁决采用权威源取值，勿翻案、勿混用其他版本口诀；新代码一律从权威源 import（禁止第二副本）：",
    ...matched.map(
      (entry) =>
        `- ${entry.topic}｜裁决：${entry.verdict}｜权威源：${entry.authority}｜裁决日：${entry.decidedAt}`,
    ),
  ];
  return lines.join("\n");
}
