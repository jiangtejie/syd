# Self-test for the WeChat window classifier used by wechat-inject.ps1 (pure
# functions on synthetic window records - no WeChat and no window APIs needed).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/wechat-window-selftest.ps1
#   npm run test:win
#
# Why it must exist: the release of 2026-09 counted WINDOWS with
# (Get-WeChatWindows).Count over Hashtables; with exactly one window PowerShell
# unrolled the one-element array back to the Hashtable and .Count returned the
# number of KEYS (3), so every send was refused with "Multiple WeChat windows
# found". Cases [2]/[6]/[7] pin that down so it can not come back.
#
# NOTE: keep this file ASCII-only (PS 5.1 parses no-BOM scripts as ANSI); the
# WeChat title is built from code points like the injector does.

. (Join-Path $PSScriptRoot '..\resources\ps\wechat-window.ps1')

$script:failed = 0

function Check {
  param([bool]$Ok, [string]$Name, [string]$Detail = '')
  if (-not $Ok) { $script:failed++ }
  $tag = '  ok  '
  if (-not $Ok) { $tag = ' FAIL ' }
  $line = $tag + ' ' + $Name
  if ($Detail -ne '') { $line = $line + ' - ' + $Detail }
  Write-Host $line
}

# "WeChat" in Chinese, built via code points to keep this file ASCII
$WX = [string][char]0x5FAE + [char]0x4FE1

function Rec {
  param(
    [int]$ProcId,
    [string]$Proc,
    [string]$Cls,
    [string]$Title,
    [bool]$Visible,
    [bool]$Owned = $false,
    [long]$Hwnd = 0
  )
  if ($Hwnd -eq 0) { $Hwnd = 100000 + $ProcId }
  return [pscustomobject]@{
    pid = $ProcId; hwnd = $Hwnd; proc = $Proc; cls = $Cls
    title = $Title; visible = $Visible; owned = $Owned
  }
}

Write-Host ''
Write-Host '[1] process names: the client only, never its helper processes'
Check (Test-WeChatProcessName 'WeChat') 'WeChat.exe is the client'
Check (Test-WeChatProcessName 'Weixin') 'Weixin.exe is the 4.x client'
Check (-not (Test-WeChatProcessName 'WeChatAppEx')) 'WeChatAppEx (mini program host) is not the client'
Check (-not (Test-WeChatProcessName 'WeChatOCR')) 'WeChatOCR is not the client'
Check (-not (Test-WeChatProcessName 'WeChatUtility')) 'WeChatUtility is not the client'
Check (-not (Test-WeChatProcessName 'explorer')) 'unrelated process is not the client'
Check (Test-WeChatMainClass 'Qt51514QWindowIcon') '4.x Qt main window class'
Check (Test-WeChatMainClass 'WeChatMainWndForPC') '3.x main window class'

Write-Host ''
Write-Host '[2] single WeChat 4.x + its hidden twin + 10 helper windows => 1 instance (the 2026-09 regression)'
$single = @(
  (Rec 13024 'WeChatAppEx' 'Chrome_WidgetWin_0' '' $false),
  (Rec 19396 'WeChatAppEx' 'Chrome_WidgetWin_0' '' $false),
  (Rec 9788 'Weixin' 'Base_PowerMessageWindow' '' $false),
  (Rec 30064 'Weixin' 'Qt51514QWindowIcon' $WX $true),
  (Rec 30064 'Weixin' 'Qt51514QWindowIcon' 'Weixin' $false),
  (Rec 30064 'Weixin' 'WxTrayIconMessageWindowClass' 'WxTrayIconMessageWindow' $false),
  (Rec 30064 'Weixin' 'Qt51514QWindowIcon' 'IME' $false $true)
)
$r2 = Get-WeChatWindowInstances -Windows $single
Check ($r2.Count -eq 1) 'one window is one instance (Count is 1, not the 3 hashtable keys)' ('Count=' + $r2.Count)
Check (@($r2).Count -eq 1) 'pipeline count is 1 too' ('@()Count=' + @($r2).Count)
Check (-not ($r2.Count -gt 1)) 'multi-instance guard stays closed for a single WeChat'
Check ($r2[0].pid -eq 30064) 'instance is the client pid' ('pid=' + $r2[0].pid)
Check ($r2[0].title -eq $WX) 'primary window is the chat window' ('title=' + $r2[0].title)
Check ($r2[0].visible) 'primary window is the visible one'
Check ($r2[0].windowCount -eq 2) 'hidden twin counts as a window of the same instance' ('windows=' + $r2[0].windowCount)

Write-Host ''
Write-Host '[3] single WeChat 3.x => 1 instance'
$v3 = @((Rec 4242 'WeChat' 'WeChatMainWndForPC' $WX $true))
$r3 = Get-WeChatWindowInstances -Windows $v3
Check ($r3.Count -eq 1) '3.x client detected once'
Check ($r3[0].title -eq $WX) '3.x chat window picked'

Write-Host ''
Write-Host '[4] genuinely dual-opened WeChat (two client pids) => 2 instances, both named'
$dual = @(
  (Rec 30064 'Weixin' 'Qt51514QWindowIcon' $WX $true),
  (Rec 40000 'Weixin' 'Qt51514QWindowIcon' $WX $true)
)
$r4 = Get-WeChatWindowInstances -Windows $dual
Check ($r4.Count -eq 2) 'two clients are two instances' ('Count=' + $r4.Count)
$detail4 = Format-WeChatInstanceList -Instances $r4
Check ($detail4 -match '30064' -and $detail4 -match '40000') 'error detail names both pids' $detail4

Write-Host ''
Write-Host '[5] no WeChat running => 0 instances'
$r5 = Get-WeChatWindowInstances -Windows @()
Check ($r5.Count -eq 0) 'empty input yields no instance'
Check ((Format-WeChatInstanceList -Instances $r5) -eq '') 'empty detail string'

Write-Host ''
Write-Host '[6] helper host only (mini program titled like WeChat) => 0 instances'
$helpers = @(
  (Rec 13024 'WeChatAppEx' 'Chrome_WidgetWin_0' $WX $true),
  (Rec 20500 'WeChatOCR' 'Chrome_WidgetWin_1' $WX $true)
)
$r6 = Get-WeChatWindowInstances -Windows $helpers
Check ($r6.Count -eq 0) 'helper windows never count as a WeChat client' ('Count=' + $r6.Count)

Write-Host ''
Write-Host '[7] client hidden in the tray, internal "Weixin" twin first in the list => 1 instance, chat window wins'
$tray = @(
  (Rec 30064 'Weixin' 'Qt51514QWindowIcon' 'Weixin' $false),
  (Rec 30064 'Weixin' 'Qt51514QWindowIcon' $WX $false)
)
$r7 = Get-WeChatWindowInstances -Windows $tray
Check ($r7.Count -eq 1) 'tray client is still one instance'
Check ($r7[0].title -eq $WX) 'tray restore targets the chat window, not the internal twin' ('title=' + $r7[0].title)

Write-Host ''
Write-Host '[8] two windows of ONE client (chat dragged out) => still 1 instance'
$twoWins = @(
  (Rec 30064 'Weixin' 'Qt51514QWindowIcon' $WX $true 0 111),
  (Rec 30064 'Weixin' 'Qt51514QWindowIcon' $WX $true 0 222)
)
$r8 = Get-WeChatWindowInstances -Windows $twoWins -ForegroundHwnd 222
Check ($r8.Count -eq 1) 'same pid = same instance, no refusal'
Check ($r8[0].hwnd -eq 222) 'foreground window is preferred' ('hwnd=' + $r8[0].hwnd)

Write-Host ''
Write-Host '[9] message safety: braces are stripped from the reported titles'
$braces = @((Rec 30064 'Weixin' 'Qt51514QWindowIcon' ($WX + ' {x}') $true))
$detail9 = Format-WeChatInstanceList -Instances (Get-WeChatWindowInstances -Windows $braces)
Check (-not ($detail9 -match '[{}]')) 'no braces in the message Node slices out of stdout' $detail9

Write-Host ''
if ($script:failed -eq 0) {
  Write-Host 'all checks passed'
  exit 0
}
Write-Host ($script:failed.ToString() + ' checks FAILED')
exit 1
