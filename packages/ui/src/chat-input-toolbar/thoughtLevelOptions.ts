import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelLabels.js";
export { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelLabels.js";
import type { ZCodeConfigOption, ZCodeProvider } from "@zcode/shared";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getConfigOptionEntryLabel } from "@/chat-input-toolbar/display.js";

export type ThoughtLevelEntry = NonNullable<ZCodeConfigOption["options"]>[number];

const NO_THOUGHT_LEVEL_VALUES = new Set([
  "disabled",
  "false",
  "no",
  "none",
  "nothink",
  "no-think",
  "no_think",
  "off",
]);

function normalizeThoughtLevelText(value: string): string {
  return value.trim().toLowerCase();
}

export function isNoThoughtLevel(entry: Pick<ThoughtLevelEntry, "value">): boolean {
  return NO_THOUGHT_LEVEL_VALUES.has(normalizeThoughtLevelText(entry.value));
}

// 「自动」不是模型目录里的档位：它是 CE 侧的预设（App 设置 adaptiveReasoningEnabled），
// 档位字段落到模型支持的顶档。core 侧路由按步型调档：首步顶档、工具续跑降一档。
export const AUTO_THOUGHT_LEVEL_VALUE = "auto";
/** 「自动」档说明的 i18n 词条；UI 传入本地化文案，helper 不内嵌中文。 */
export const AUTO_THOUGHT_LEVEL_DESCRIPTION_ID = "chat.toolbar.thoughtLevel.auto.description";
const AUTO_THOUGHT_LEVEL_FALLBACK_DESCRIPTION =
  "Top level; one level down on tool-continuation turns. Applies to new sessions.";

/**
 * 在思考档目录前插入「自动」预设（排在最前，选中即开启自适应）。
 * 目录不足两档或已含同值时原样返回，不重复插入。
 */
export function withAutoThoughtLevelOption(
  option: Pick<ZCodeConfigOption, "type" | "options"> & { options?: ThoughtLevelEntry[] },
  description: string = AUTO_THOUGHT_LEVEL_FALLBACK_DESCRIPTION,
): ThoughtLevelEntry[] {
  const entries = option.options ?? [];
  if (entries.length < 2) return entries;
  if (entries.some((entry) => entry.value === AUTO_THOUGHT_LEVEL_VALUE)) return entries;
  return [
    {
      value: AUTO_THOUGHT_LEVEL_VALUE,
      name: AUTO_THOUGHT_LEVEL_VALUE,
      description,
    },
    ...entries,
  ];
}

export function getNextThoughtLevelValue(
  option: Pick<ZCodeConfigOption, "type" | "currentValue" | "options">,
): string | null {
  if (option.type !== "select" || !option.options || option.options.length < 2) {
    return null;
  }

  // 配置已声明档位顺序；名称别名只用于展示，不能改变菜单或快捷键顺序。
  const entries = option.options;
  const currentValue = String(option.currentValue);
  const currentIndex = entries.findIndex((candidate) => candidate.value === currentValue);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % entries.length;

  return entries[nextIndex]?.value ?? null;
}

export function getThoughtLevelLabel(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  provider: ZCodeProvider | undefined,
  option: ZCodeConfigOption,
  entry: ThoughtLevelEntry,
): string {
  const labelId = thoughtLevelLabelId(entry.value);
  if (labelId) {
    return intl.formatMessage({ id: labelId });
  }

  return getConfigOptionEntryLabel(intl, provider, option, entry);
}
