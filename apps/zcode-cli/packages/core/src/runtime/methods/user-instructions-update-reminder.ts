import type { FileSystemPort } from "@zcode/contracts";

/**
 * 用户指令（AGENTS.md 等）热更新提醒（②，吸收 codex agents_md_manager）。
 *
 * 现状：AGENTS.md 在会话启动时读进系统前缀，之后修改要重启会话才生效——
 * 而它是活文档（本项目会话中就多次追加约定）。重建前缀会冲掉整个 prompt
 * 缓存，因此走 codex 同款形态：检测到变更时以 per-request 提醒注入新版
 * 全文（前缀不动，缓存安全，与 memory_recall 同族设计）。
 *
 * 新鲜度检查用 stat（mtime+size 签名）逐 turn 一次，未变更零成本静默。
 */

/** 单文件注入上限：超大 AGENTS.md 截尾（前缀装载时本有 maxBytes 同类约束）。 */
const MAX_UPDATE_CONTENT_CHARS = 32_000;

interface FreshnessSlot {
  /** path → `${mtimeMs}:${sizeBytes}` 签名；null = 尚未建立基线（首turn 建立，不注入）。 */
  signatures: Map<string, string> | null;
  /**
   * 已发生变更的源路径列表；非空时后续 turn 持续注入一行指针——per-request
   * 全文只在变更当 turn 注入一次，但模型下一 turn 就看不到它了（且压缩会
   * 进一步丢失），轻量指针保证「新版已生效」这一事实常驻直到再次变更。
   */
  changedSources: string[];
}

const freshnessCache = new WeakMap<object, FreshnessSlot>();

function signatureOf(stat: { mtimeMs?: number; sizeBytes: number }): string {
  return `${stat.mtimeMs ?? 0}:${stat.sizeBytes}`;
}

export interface UserInstructionsUpdateInput {
  runtime: object;
  fileSystem: FileSystemPort;
  /** 会话启动时解析到的指令源（user/workspace 各自的文件路径）。 */
  sourcePaths: readonly string[];
}

/** 返回更新提醒正文；未变更/无源/首turn建立基线返回 null。 */
export async function buildUserInstructionsUpdateBody(
  input: UserInstructionsUpdateInput,
): Promise<string | null> {
  if (input.sourcePaths.length === 0) return null;
  let slot = freshnessCache.get(input.runtime);
  if (!slot) {
    slot = { signatures: null, changedSources: [] };
    freshnessCache.set(input.runtime, slot);
  }

  const current = new Map<string, string>();
  const changed: string[] = [];
  for (const path of input.sourcePaths) {
    try {
      const stat = await input.fileSystem.stat({ path });
      if (stat.kind !== "file") continue;
      const signature = signatureOf(stat);
      current.set(path, signature);
      if (slot.signatures?.get(path) !== signature) changed.push(path);
    } catch {
      // 文件被删/不可读：不视为更新源（原前缀内容仍有效），跳过。
    }
  }
  if (slot.signatures === null) {
    slot.signatures = current; // 首turn只建基线，不注入（前缀已是该内容）
    return null;
  }
  const unchanged = current.size === slot.signatures.size &&
    [...current.entries()].every(([path, sig]) => slot.signatures!.get(path) === sig);
  slot.signatures = current;
  if (unchanged || changed.length === 0) {
    // 未再变更：若本会话曾变更过，持续注入轻量指针（防遗忘/防压缩丢失）。
    if (slot.changedSources.length === 0) return null;
    return [
      "用户指令文件（AGENTS.md 等）本会话中途已修改，当前系统前缀中的版本已过时：",
      ...slot.changedSources.map((path) => `- ${path}`),
      "遵循最新版内容（变更当轮已注入全文；不确定细节时用 Read 重读上述文件）。",
    ].join("\n");
  }
  slot.changedSources = [...new Set([...slot.changedSources, ...changed])];

  const sections: string[] = [];
  for (const path of changed) {
    try {
      const read = await input.fileSystem.readTextFile({ path });
      const content =
        read.content.length > MAX_UPDATE_CONTENT_CHARS
          ? `${read.content.slice(0, MAX_UPDATE_CONTENT_CHARS)}\n[…truncated…]`
          : read.content;
      sections.push(`【${path}（会话中途已修改，以下为最新全文，优先于系统前缀中的旧版本）】\n${content}`);
    } catch {
      // stat 可见但读失败：跳过该文件，其余照常。
    }
  }
  if (sections.length === 0) return null;
  return [
    "以下用户指令文件在本会话进行中被修改。以本提醒中的内容为准（系统前缀里的旧版本已被覆盖）：",
    ...sections,
  ].join("\n\n");
}
