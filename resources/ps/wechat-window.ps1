# WeChat window classification (pure functions: no Win32, no process access).
# Dot-sourced by:
#   resources/ps/wechat-inject.ps1      runtime: decide which window may be typed into
#   scripts/wechat-window-selftest.ps1  self-test: synthetic window records
#
# Why this file exists (2026-09 regression):
#   The old inline check counted *windows* with (Get-WeChatWindows).Count over an
#   array of Hashtables. With exactly ONE window PowerShell unrolled the
#   one-element array back to the Hashtable, and Hashtable.Count is the number of
#   KEYS (hwnd/title/pid = 3), so "Count -gt 1" was true -> EVERY send on a single
#   WeChat was refused with "Multiple WeChat windows found". Counting is now based
#   on WeChat *instances* (one PID = one WeChat client) and always returns a
#   collection, so .Count is stable for 0 / 1 / N.
#
# NOTE: keep this file ASCII-only (PS 5.1 parses no-BOM scripts as ANSI).

# "WeChat" in Chinese (U+5FAE U+4FE1), built via code points to keep the file ASCII
$script:WeChatTitle = [string][char]0x5FAE + [char]0x4FE1

# Helper processes of the WeChat client. They never own the chat window we type
# into, but the old '*wechat*' process pattern matched them (WeChatAppEx is the
# mini-program host and runs one process per opened mini program).
$script:WeChatHelperPattern = 'appex|applet|ocr|utility|player|update|crashpad|helper|preview|report'

# Real chat windows: 3.x uses WeChatMainWndForPC, 4.x is Qt based
# (Qt51514QWindowIcon / Qt51515QWindowIcon ...). Matched by pattern, not by version.
$script:WeChatMainClassPattern = '^(WeChatMainWndForPC|WeChatLoginWndForPC|Qt\d+QWindowIcon)$'

# Top-level windows of the same process that are never the chat window
# (tray icon, power-event sinks, Chromium message windows, IME...).
$script:WeChatNonChatClasses = @(
  'Base_PowerMessageWindow', 'DisplayICC_SystemMessageWindow', 'Chrome_SystemMessageWindow',
  'WorkerW', 'IME', 'MSCTFIME UI', 'WxTrayIconMessageWindowClass',
  'Chrome_WidgetWin_0', 'Chrome_WidgetWin_1', 'Shell_TrayWnd', 'Progman'
)

function Test-WeChatProcessName {
  param([string]$Name)
  if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
  $n = $Name.ToLowerInvariant()
  if ($n -notlike '*wechat*' -and $n -notlike '*weixin*') { return $false }
  if ($n -match $script:WeChatHelperPattern) { return $false }
  return $true
}

function Test-WeChatMainClass {
  param([string]$Class)
  if ([string]::IsNullOrWhiteSpace($Class)) { return $false }
  return ($Class -match $script:WeChatMainClassPattern)
}

# How strongly a title says "this is the WeChat chat window":
#   3 = exactly the WeChat title, 2 = contains it, 1 = English product name, 0 = no.
# WeChat 4.x also owns a hidden Qt window titled "Weixin"; without this ladder both
# scored the same and a tray-hidden client could have been focused on that twin.
function Get-WeChatTitleRank {
  param([string]$Title)
  if ([string]::IsNullOrWhiteSpace($Title)) { return 0 }
  $t = $Title.Trim()
  if ($t -eq $script:WeChatTitle) { return 3 }
  if ($t -like "*$script:WeChatTitle*") { return 2 }
  if (($t -like '*WeChat*') -or ($t -like '*Weixin*')) { return 1 }
  return 0
}

function Test-WeChatTitleHit {
  param([string]$Title)
  return ((Get-WeChatTitleRank $Title) -gt 0)
}

# A window record is a flat object: pid / hwnd / proc / cls / title / visible / owned
function Test-WeChatWindowRecord {
  param($Window)
  if ($null -eq $Window) { return $false }
  if ([bool]$Window.owned) { return $false }  # dialog / IME owned by another window
  if (-not (Test-WeChatProcessName ([string]$Window.proc))) { return $false }
  $cls = [string]$Window.cls
  if ($script:WeChatNonChatClasses -contains $cls) { return $false }
  return ((Test-WeChatMainClass $cls) -or (Test-WeChatTitleHit ([string]$Window.title)))
}

# Higher = more likely the window a human would call "the WeChat window".
# Visible beats hidden; an exact WeChat title beats the internal "Weixin" twin.
function Get-WeChatWindowScore {
  param($Window, [int64]$ForegroundHwnd = 0)
  $visible = [bool]$Window.visible
  $rank = Get-WeChatTitleRank ([string]$Window.title)
  $mainClass = Test-WeChatMainClass ([string]$Window.cls)

  $score = 10
  if ($mainClass) { $score = 20 }      # hidden, right class, no telling title
  if ($rank -ge 1) { $score = 30 }     # hidden, English product title
  if ($rank -eq 2) { $score = 33 }     # hidden, title contains the WeChat name
  if ($rank -eq 3) { $score = 34 }     # hidden, exact WeChat title (client in tray)
  if ($visible) { $score = 70 }
  if ($visible -and $mainClass) { $score = 80 }
  if ($visible -and $rank -eq 2) { $score = 90 }
  if ($visible -and $rank -eq 3) { $score = 100 }

  # tie-breaker: the window the user is currently looking at
  if ($ForegroundHwnd -ne 0 -and ([int64]$Window.hwnd) -eq $ForegroundHwnd) { $score = $score + 1 }
  return $score
}

<#
  Group candidate windows into WeChat instances (one PID = one WeChat client) and
  pick the primary window of each.
  Returns an ArrayList (never a bare Hashtable), so ($r).Count and @($r).Count are
  both the instance count.
#>
function Get-WeChatWindowInstances {
  param(
    [AllowEmptyCollection()][object[]]$Windows = @(),
    [int64]$ForegroundHwnd = 0
  )
  $byPid = @{}
  foreach ($w in @($Windows)) {
    if (-not (Test-WeChatWindowRecord $w)) { continue }
    $key = [int]$w.pid
    if (-not $byPid.ContainsKey($key)) { $byPid[$key] = New-Object System.Collections.ArrayList }
    [void]$byPid[$key].Add($w)
  }

  $instances = New-Object System.Collections.ArrayList
  foreach ($key in ($byPid.Keys | Sort-Object)) {
    $wins = @($byPid[$key])
    $primary = $null
    $best = -1
    foreach ($w in $wins) {
      $s = Get-WeChatWindowScore -Window $w -ForegroundHwnd $ForegroundHwnd
      if ($s -gt $best) { $best = $s; $primary = $w }
    }
    [void]$instances.Add([pscustomobject]@{
      pid         = [int]$key
      hwnd        = [int64]$primary.hwnd
      title       = [string]$primary.title
      proc        = [string]$primary.proc
      visible     = [bool]$primary.visible
      cls         = [string]$primary.cls
      windows     = $wins
      windowCount = $wins.Count
    })
  }
  return ,$instances
}

# "pid 30064 WeChat; pid 1234 WeChat" for error messages (braces stripped: the
# Node side slices the JSON out of the last stdout line by the first { and last }).
function Format-WeChatInstanceList {
  param([AllowEmptyCollection()][object[]]$Instances = @())
  $parts = @()
  foreach ($i in @($Instances)) {
    $t = (([string]$i.title).Trim()) -replace '[{}]', ''
    if ([string]::IsNullOrWhiteSpace($t)) { $t = 'no title' }
    $parts += ('pid ' + $i.pid + ' ' + $t)
  }
  return ($parts -join '; ')
}
