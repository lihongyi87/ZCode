import type { ZCodeConfigOption, ZCodeProvider } from "@zcode/shared";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getConfigOptionEntryLabel } from "@/chat-input-toolbar/display.js";

type ThoughtLevelEntry = NonNullable<ZCodeConfigOption["options"]>[number];

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

/** 「自动」档：UI 预设而非 provider 档位——选中即开启自适应思考档
 * （App 设置 adaptiveReasoningEnabled），档位字段落到模型支持的顶档。
 * core 侧路由按步型调档：首步顶档、工具续跑降一档。 */
export const AUTO_THOUGHT_LEVEL_VALUE = "auto";

const THOUGHT_LEVEL_LABEL_IDS: Record<string, string> = {
  auto: "chat.toolbar.thoughtLevel.value.auto",
  disabled: "chat.toolbar.thoughtLevel.value.off",
  false: "chat.toolbar.thoughtLevel.value.off",
  no: "chat.toolbar.thoughtLevel.value.off",
  none: "chat.toolbar.thoughtLevel.value.off",
  nothink: "chat.toolbar.thoughtLevel.value.off",
  "no-think": "chat.toolbar.thoughtLevel.value.off",
  no_think: "chat.toolbar.thoughtLevel.value.off",
  off: "chat.toolbar.thoughtLevel.value.off",
  enable: "chat.toolbar.thoughtLevel.value.on",
  enabled: "chat.toolbar.thoughtLevel.value.on",
  on: "chat.toolbar.thoughtLevel.value.on",
  true: "chat.toolbar.thoughtLevel.value.on",
  low: "chat.toolbar.thoughtLevel.value.low",
  minimal: "chat.toolbar.thoughtLevel.value.minimal",
  medium: "chat.toolbar.thoughtLevel.value.medium",
  high: "chat.toolbar.thoughtLevel.value.high",
  "extra-high": "chat.toolbar.thoughtLevel.value.xhigh",
  extra_high: "chat.toolbar.thoughtLevel.value.xhigh",
  xhigh: "chat.toolbar.thoughtLevel.value.xhigh",
  max: "chat.toolbar.thoughtLevel.value.max",
  ultra: "chat.toolbar.thoughtLevel.value.ultra",
};

function normalizeThoughtLevelText(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 档位值 → 词条 id；表里没有的值返回 undefined（调用方原样显示 provider 自己的档位名）。
 * 工具条之外也有人要说这个词（工作流的子代理模型），两处必须查同一张表。
 */
export function thoughtLevelLabelId(value: string): string | undefined {
  return THOUGHT_LEVEL_LABEL_IDS[normalizeThoughtLevelText(value)];
}

export function isNoThoughtLevel(entry: ThoughtLevelEntry): boolean {
  return NO_THOUGHT_LEVEL_VALUES.has(normalizeThoughtLevelText(entry.value));
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

/**
 * 在档位列表头部插入「自动」预设（仅当模型 ≥2 个真实档位时有意义）。
 * 循环快捷键与下拉共用该列表；auto 参与循环是有意的——它是用户可选档。
 */
export function withAutoThoughtLevelOption(
  option: Pick<ZCodeConfigOption, "type" | "options"> & { options?: ThoughtLevelEntry[] },
): ThoughtLevelEntry[] {
  const entries = option.options ?? [];
  if (entries.length < 2) return entries;
  if (
    entries.some((entry) => normalizeThoughtLevelText(entry.value) === AUTO_THOUGHT_LEVEL_VALUE)
  ) {
    return entries;
  }
  // name 必填（ZCodeConfigSelectValue）；展示走 THOUGHT_LEVEL_LABEL_IDS 的本地化。
  return [
    {
      value: AUTO_THOUGHT_LEVEL_VALUE,
      name: AUTO_THOUGHT_LEVEL_VALUE,
      description: "档位顶格；工具续跑自动降一档。设置对新建会话生效。",
    },
    ...entries,
  ];
}

export function getThoughtLevelLabel(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  provider: ZCodeProvider | undefined,
  option: ZCodeConfigOption,
  entry: ThoughtLevelEntry,
): string {
  const value = normalizeThoughtLevelText(entry.value);
  const labelId = Object.hasOwn(THOUGHT_LEVEL_LABEL_IDS, value)
    ? THOUGHT_LEVEL_LABEL_IDS[value]
    : undefined;
  if (labelId) {
    return intl.formatMessage({ id: labelId });
  }

  return getConfigOptionEntryLabel(intl, provider, option, entry);
}
