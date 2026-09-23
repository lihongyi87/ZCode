# CUA bench 校验器：枚举桌面上所有记事本顶层窗口，读编辑区文本（UIA ValuePattern）。
# Win11 商店版记事本的 UIA 树按 PID 搜不到（进程≠UIA 宿主），因此按窗口标题枚举。
# 本文件必须存为 UTF-8 with BOM：PowerShell 5.1 对无 BOM 的含中文脚本按 ANSI 解析会炸。
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Window)
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
$out = @()
foreach ($w in $wins) {
  try {
    if ($w.Current.Name -notmatch 'Notepad|记事本|无标题') { continue }
    $eds = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($e in $eds) {
      try {
        $pn = $e.Current.ControlType.ProgrammaticName
        if ($pn -match 'Edit|Document') {
          $v = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
          if ($v) { $out += $v }
        }
      } catch {}
    }
  } catch {}
}
if ($out.Count -eq 0) { Write-Output "__NOTEXT__" } else { Write-Output ($out -join "`n") }
