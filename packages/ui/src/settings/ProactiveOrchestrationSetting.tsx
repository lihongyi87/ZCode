import { Switch } from "@/components/ui/switch.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * spec 154 P3:主动编排逐工作区同意开关。
 *
 * 开启后从最近项目列表勾选允许主动唤醒的工作区（dispatcher workspaceKey =
 * 工作区目录绝对路径,与 recentProjects 同源同形）；宿主(node.ts)把同意状态
 * 翻译成 ZCODE_PROACTIVE_ORCHESTRATION / ZCODE_PROACTIVE_WORKSPACES 注入
 * agent env。未设置(undefined)=未同意,缺省关闭。
 */
export function ProactiveOrchestrationSetting() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const current = settings?.proactiveOrchestrationSettings;
  const enabled = current?.enabled === true;
  const allowedKeys = current?.allowedWorkspaceKeys ?? [];
  const recentProjects: string[] = settings?.recentProjects ?? [];

  const patchSettings = async (patch: { enabled: boolean; allowedWorkspaceKeys: string[] }) => {
    await update({ proactiveOrchestrationSettings: patch });
  };

  const toggleEnabled = async (next: boolean) => {
    await patchSettings({
      enabled: next,
      // 首次开启默认允许最近一个项目,用户可再逐项增删;重新开启保留既有名单。
      allowedWorkspaceKeys:
        current?.allowedWorkspaceKeys ?? (next ? recentProjects.slice(0, 1) : []),
    });
  };

  const toggleWorkspace = async (projectPath: string, next: boolean) => {
    const nextKeys = next
      ? allowedKeys.includes(projectPath)
        ? allowedKeys
        : [...allowedKeys, projectPath]
      : allowedKeys.filter((key) => key !== projectPath);
    await patchSettings({ enabled: true, allowedWorkspaceKeys: nextKeys });
  };

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "settings.proactiveOrchestration.label" })}
      description={intl.formatMessage({ id: "settings.proactiveOrchestration.description" })}
      control={
        <Switch
          checked={enabled}
          disabled={!settings}
          onCheckedChange={toggleEnabled}
          aria-label={intl.formatMessage({ id: "settings.proactiveOrchestration.label" })}
        />
      }
      controlLayout="stacked"
      detail={
        enabled ? (
          recentProjects.length > 0 ? (
            <div className="flex flex-col gap-1">
              {recentProjects.map((projectPath) => (
                <label key={projectPath} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={allowedKeys.includes(projectPath)}
                    onChange={(event) => {
                      void toggleWorkspace(projectPath, event.target.checked);
                    }}
                  />
                  <span className="truncate" title={projectPath}>
                    {projectPath}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.proactiveOrchestration.noWorkspaces" })}
            </p>
          )
        ) : null
      }
    />
  );
}
