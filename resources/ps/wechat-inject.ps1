param(
  [string]$Action = 'focus',
  [string]$Keys = '',
  [string]$Target = '',
  [string]$Text = '',
  [string]$Path = '',
  [string]$FileKind = 'file',
  [string]$NamesFile = '',
  [int]$IsGroup = 1,
  [string]$ShotDir = ''
)
$ErrorActionPreference = 'Stop'

# WeChat window injection script (T8)
# Action:
#   focus    -> find the WeChat window and force foreground, output {ok, focused, title}
#   isfocus  -> check whether the WeChat window is foreground, output {ok, focused}
#   keys     -> send a key sequence (Keys comma separated: ctrl+f / ctrl+a / delete / ctrl+v / enter / esc / tab)
#   send     -> session search Target -> open that chat -> paste body Text -> Enter
#   sendfile -> session search Target -> open that chat -> put file/image in clipboard -> paste -> Enter
#   open     -> diagnostics: search Target, click the OCR-located row and report the
#               conversation header that got opened. Never types anything into a chat.
#   list     -> report the detected WeChat instances (diagnostics, never types anything)
#
# "Open that chat" is not just "press Enter on the first result": WeChat 4.x puts a
# "search the web" block plus query suggestions on top of the dropdown, so the first
# row is never the chat. See wechat-ocr.ps1 - the row is located by OCR and clicked,
# and the conversation header is read back before a single key is typed.
#
# Output: single-line JSON on stdout
# NOTE: keep this file ASCII-only (PS 5.1 parses no-BOM scripts as ANSI).

# UTF-8 stdout: window titles are Chinese and Node reads the pipe as utf8
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# Window classification (pure functions) lives next to this file: one PID = one WeChat
# client, and .Count on the result is the instance count (see that file for the
# "one window looked like three" regression it fixes).
. (Join-Path $PSScriptRoot 'wechat-window.ps1')
# Screenshot / OCR / click helpers (WeChat 4.x has no readable accessibility tree).
. (Join-Path $PSScriptRoot 'wechat-ocr.ps1')

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public class WinRec {
  public int pid;
  public long hwnd;
  public string proc = "";
  public string cls = "";
  public string title = "";
  public bool visible;
  public bool owned;
}

public class Win32 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(int a, int b, bool f);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] private static extern void SwitchToThisWindow(IntPtr h, bool alt);

  private static string ProcName(int pid) {
    try { return Process.GetProcessById(pid).ProcessName; } catch { return ""; }
  }

  // Every top-level window with its owner process/class/title. Title and class are
  // read with the W (wide) APIs so Chinese titles survive.
  public static List<WinRec> ListWindows() {
    var list = new List<WinRec>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      int pid;
      GetWindowThreadProcessId(h, out pid);
      var rec = new WinRec();
      rec.hwnd = h.ToInt64();
      rec.pid = pid;
      rec.visible = IsWindowVisible(h);
      rec.owned = (GetWindow(h, 4) != IntPtr.Zero);
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      rec.title = sb.ToString();
      var cn = new StringBuilder(256);
      GetClassNameW(h, cn, 256);
      rec.cls = cn.ToString();
      list.Add(rec);
      return true;
    }, IntPtr.Zero);

    var names = new Dictionary<int, string>();
    foreach (var rec in list) {
      if (!names.ContainsKey(rec.pid)) { names[rec.pid] = ProcName(rec.pid); }
      rec.proc = names[rec.pid];
    }
    return list;
  }

  public static long GetForeground() { return GetForegroundWindow().ToInt64(); }

  // SetForegroundWindow is refused while our process sits in the background (the user
  // just clicked Send in the app, so it IS in the background). Raising the window
  // (topmost toggle + BringWindowToTop) puts it physically on top so a mouse click
  // can land on it - the click is what actually activates a Qt window.
  public static void Raise(IntPtr h) {
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0003);
    SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0003);
    BringWindowToTop(h);
  }

  // Last-resort activation. Measured on WeChat 4.x: this makes the window read as
  // foreground while Qt never receives its activation, and then the client silently
  // ignores every keystroke - so it is only a fallback, never the normal path.
  public static void ForceForeground(IntPtr h) {
    Raise(h);
    SwitchToThisWindow(h, true);
  }
}
"@

Add-Type -AssemblyName System.Windows.Forms

$VK = @{
  'enter'  = 0x0D
  'delete' = 0x2E
  'backspace' = 0x08
  'esc'    = 0x1B
  'tab'    = 0x09
  'space'  = 0x20
  'home'   = 0x24
  'end'    = 0x23
  'a' = 0x41; 'b' = 0x42; 'c' = 0x43; 'v' = 0x56; 'f' = 0x46; 'n' = 0x4E
}
$MOD = @{ 'ctrl' = 0x11; 'alt' = 0x12; 'shift' = 0x10 }

# clipboard write helpers with retry (clipboard may be busy by other apps)
function Invoke-ClipboardWithRetry([scriptblock]$fn) {
  for ($i = 0; $i -lt 5; $i++) {
    try { & $fn; return $true } catch { Start-Sleep -Milliseconds 250 }
  }
  return $false
}

function Set-ImageFileClipboard([string]$p) {
  $img = [System.Drawing.Image]::FromFile($p)
  try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }
}

function Set-FileDropClipboard([string]$p) {
  $list = New-Object System.Collections.Specialized.StringCollection
  [void]$list.Add($p)
  [System.Windows.Forms.Clipboard]::SetFileDropList($list)
}

function KeyDown([int]$vk) { [void][Win32]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero) }
function KeyUp([int]$vk)   { [void][Win32]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero) }

function Send-KeySeq([string]$seq) {
  foreach ($k in $seq -split ',') {
    $k = $k.Trim().ToLower()
    if ($k -eq '') { continue }
    if ($k -match '^(ctrl|alt|shift)\+(.+)$') {
      $modVk = $MOD[$Matches[1]]
      $keyVk = $VK[$Matches[2].Trim()]
      if ($null -eq $keyVk) { continue }
      KeyDown $modVk
      KeyDown $keyVk
      KeyUp $keyVk
      KeyUp $modVk
    } else {
      $keyVk = $VK[$k]
      if ($null -eq $keyVk) { continue }
      KeyDown $keyVk
      KeyUp $keyVk
    }
  }
}

# Empty whatever input currently has the keyboard (the search box keeps the previous
# query, and a chat keeps a draft). Ctrl+A alone is not dependable inside WeChat's
# inputs, so the sweep of backspaces is what actually guarantees an empty field.
function Clear-WxField {
  Send-KeySeq 'ctrl+a'
  Start-Sleep -Milliseconds 150
  Send-KeySeq 'delete'
  Start-Sleep -Milliseconds 100
  for ($i = 0; $i -lt 30; $i++) { Send-KeySeq 'backspace' }
  Start-Sleep -Milliseconds 150
}

# Text that came out of OCR goes into error messages: drop quotes/braces and cap the
# length, the Node side slices the JSON payload out of the last stdout line.
function ConvertTo-WxMsgText([string]$Text) {
  if ([string]::IsNullOrEmpty($Text)) { return '' }
  $t = $Text -replace '[{}"]', ' '
  $t = $t -replace '\s+', ' '
  $t = $t.Trim()
  if ($t.Length -gt 60) { $t = $t.Substring(0, 60) }
  return $t
}

# All top-level windows as flat records for the pure classifier
function Get-WeChatWindowRecords {
  $recs = New-Object System.Collections.ArrayList
  foreach ($w in [Win32]::ListWindows()) {
    [void]$recs.Add([pscustomobject]@{
      pid     = [int]$w.pid
      hwnd    = [int64]$w.hwnd
      proc    = [string]$w.proc
      cls     = [string]$w.cls
      title   = [string]$w.title
      visible = [bool]$w.visible
      owned   = [bool]$w.owned
    })
  }
  return ,$recs
}

# WeChat instances (one per WeChat PID). Always wrap in @() at the call site.
function Get-WeChatInstances {
  $records = Get-WeChatWindowRecords
  return (Get-WeChatWindowInstances -Windows @($records) -ForegroundHwnd ([Win32]::GetForeground()))
}

function Restore-WeChatWindow([IntPtr]$hwnd) {
  # A window closed to the tray is hidden, not iconic: SW_SHOW, then SW_RESTORE if minimized
  if (-not [Win32]::IsWindowVisible($hwnd)) { [void][Win32]::ShowWindow($hwnd, 5) }
  if ([Win32]::IsIconic($hwnd)) { [void][Win32]::ShowWindow($hwnd, 9) }
}

# Force the window to the foreground and PROVE it: sending keystrokes without that
# proof is how a session name ends up typed into whatever app happens to be in front.
function Focus-WeChatWindow([IntPtr]$hwnd) {
  Restore-WeChatWindow $hwnd
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    if ([Win32]::GetForegroundWindow() -eq $hwnd) { return $true }

    # 1) plain activation
    [void][Win32]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 120
    if ([Win32]::GetForegroundWindow() -eq $hwnd) { return $true }

    # 2) the ALT keystroke earns the foreground privilege
    KeyDown 0x12; KeyUp 0x12
    [void][Win32]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 120
    if ([Win32]::GetForegroundWindow() -eq $hwnd) { return $true }

    # 3) borrow the input queue of whoever holds the foreground right now
    $fg = [Win32]::GetForegroundWindow()
    if ($fg -ne [IntPtr]::Zero -and $fg -ne $hwnd) {
      $cur = [Win32]::GetCurrentThreadId()
      $fgThread = [Win32]::GetWindowThreadProcessId($fg, [ref]0)
      if ($fgThread -ne 0 -and $fgThread -ne $cur) {
        if ([Win32]::AttachThreadInput($fgThread, $cur, $true)) {
          [void][Win32]::SetForegroundWindow($hwnd)
          [void][Win32]::AttachThreadInput($fgThread, $cur, $false)
        }
      }
    }
    Start-Sleep -Milliseconds 120
    if ([Win32]::GetForegroundWindow() -eq $hwnd) { return $true }

    # 4) last resort. Deliberately NOT used while the steps above already work: the
    # topmost toggle + SwitchToThisWindow give a window that reads as foreground while
    # Qt never got its activation, and then the app silently ignores every keystroke.
    [Win32]::ForceForeground($hwnd)
    Start-Sleep -Milliseconds 250
    if ([Win32]::GetForegroundWindow() -eq $hwnd) { return $true }
  }
  return ([Win32]::GetForegroundWindow() -eq $hwnd)
}

<#
  Open the chat named Target.
  WeChat 4.x does not expose its search dropdown to UI Automation and pressing Enter
  right after typing hits the "search the web" row, so the right row is located with
  OCR and clicked. The conversation header is then read back and compared against both
  the target and every session name the app knows: only a close-enough match continues,
  anything else returns ok=false with nothing typed into the chat.
#>
function Open-WxSession {
  param(
    $Win,
    [string]$Target,
    [bool]$IsGroup = $true,
    [AllowEmptyCollection()][string[]]$Names = @(),
    [string]$ShotDir = ''
  )
  $hwnd = [IntPtr]([int64]$Win.hwnd)

  if (-not (Initialize-WxOcr)) {
    return @{ ok = $false; error = 'OCR unavailable (Windows Chinese OCR language feature is missing)' }
  }

  # Bring the window up and open its search box.
  # Measured behaviour of WeChat 4.x (Qt): SetForegroundWindow is refused for a
  # background process - and even when it "succeeds" the client never gets its real
  # activation, so it silently swallows every keystroke. A mouse click is what
  # activates it, so the search box is opened by clicking it instead of Ctrl+F.
  Restore-WeChatWindow $hwnd
  [Win32]::Raise($hwnd)
  [void][Win32]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 300
  $rect = [WxUi32]::Rect($hwnd)
  # top-left of the middle pane: the search box sits just right of the icon rail
  Invoke-WxClick -X ($rect[0] + 130) -Y ($rect[1] + 52)
  Start-Sleep -Milliseconds 600

  $shot = $null
  $row = $null
  $sawDropdown = $false
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    if ($attempt -gt 1) {
      # The click may have missed (layout/DPI): fall back to the keyboard shortcut.
      Send-KeySeq 'esc'
      Start-Sleep -Milliseconds 200
      Send-KeySeq 'ctrl+f'
      Start-Sleep -Milliseconds 500
    }
    Clear-WxField
    if (-not (Invoke-ClipboardWithRetry { [System.Windows.Forms.Clipboard]::SetText($Target) })) {
      return @{ ok = $false; error = 'Clipboard busy (target)' }
    }
    Send-KeySeq 'ctrl+v'
    Start-Sleep -Milliseconds 900

    if ([Win32]::GetForegroundWindow() -ne $hwnd) {
      return @{ ok = $false; error = 'Focus stolen, send cancelled' }
    }
    $shotPath = Join-Path $ShotDir 'wx-last-search.png'
    $shot = Get-WxWindowShot -Hwnd ([int64]$Win.hwnd) -OutPath $shotPath
    if ($null -eq $shot) { return @{ ok = $false; error = 'Screenshot failed' } }
    $lines = Get-WxOcrLines -Path $shot.path -Scale $shot.scale
    if ($null -eq $lines) { return @{ ok = $false; error = 'OCR failed on the search screenshot' } }

    # The search box has to hold OUR text before the rows mean anything.
    $boxOk = $false
    foreach ($l in @($lines)) {
      if ($l.y -le 80 -and $l.x -le 320 -and (Test-WxSearchBoxMatches -Text $l.text -Target $Target)) {
        $boxOk = $true
      }
    }
    if ($boxOk -and (Test-WxSearchDropdown -Lines @($lines))) {
      $sawDropdown = $true
      $row = Select-WxSearchRow -Lines @($lines) -Target $Target -IsGroup $IsGroup
      break
    }
    if ($boxOk) {
      # Text is in the box but no result section: the target really has no match.
      $sawDropdown = $true
      break
    }
    [void][Win32]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 250
  }
  if (-not $sawDropdown) {
    return @{ ok = $false; error = 'Search box did not open in WeChat' }
  }
  if ($null -eq $row) {
    # Diagnostics stay in the raw error; the app shows a humanized Chinese message.
    $boxText = ''
    foreach ($l in @($lines)) {
      if ($l.y -le 80 -and $l.x -le 320) { $boxText = $boxText + ' ' + $l.text }
    }
    $seen = ''
    foreach ($l in @($lines)) { $seen = $seen + ' / ' + ([string]$l.y) + ':' + $l.text }
    Send-KeySeq 'esc'
    return @{ ok = $false; error = ('Target row not found in search results (box=[' + (ConvertTo-WxMsgText $boxText) + '] lines=' + @($lines).Count + ' seen=' + (ConvertTo-WxMsgText $seen) + ')') }
  }

  $clickX = $shot.rect[0] + $row.x + 40
  $clickY = $shot.rect[1] + $row.y + [int]($row.h / 2)
  Invoke-WxClick -X $clickX -Y $clickY
  Start-Sleep -Milliseconds 900

  if ([Win32]::GetForegroundWindow() -ne $hwnd) {
    return @{ ok = $false; error = 'Focus stolen, send cancelled' }
  }
  $openedPath = Join-Path $ShotDir 'wx-last-opened.png'
  $shot2 = Get-WxWindowShot -Hwnd ([int64]$Win.hwnd) -OutPath $openedPath
  if ($null -eq $shot2) { return @{ ok = $false; error = 'Screenshot failed' } }
  $lines2 = Get-WxOcrLines -Path $shot2.path -Scale $shot2.scale
  if ($null -eq $lines2) { return @{ ok = $false; error = 'OCR failed on the header screenshot' } }

  $m = Get-WxHeaderMatch -Lines @($lines2) -Target $Target -Names $Names
  $direct = [Math]::Round($m.direct, 2)
  $other = [Math]::Round($m.bestScore, 2)
  if ($m.direct -lt 0.6 -or $m.direct -lt ($m.bestScore - 0.02)) {
    $err = 'Wrong chat opened: header reads "' + (ConvertTo-WxMsgText $m.text) +
           '" but the target is "' + (ConvertTo-WxMsgText $Target) + '"' +
           ' (score ' + $direct + ', closest known session "' + (ConvertTo-WxMsgText $m.bestName) + '" ' + $other + ')'
    return @{ ok = $false; error = $err }
  }
  return @{ ok = $true; opened = (ConvertTo-WxMsgText $m.text); score = $direct }
}

# Full text injection: open the session (verified) -> paste body -> Enter.
function Invoke-SendText {
  param($Win, [string]$Target, [string]$Text, $Open)

  $opened = Open-WxSession -Win $Win -Target $Target -IsGroup $Open.isGroup -Names $Open.names -ShotDir $Open.shotDir
  if (-not $opened.ok) { return $opened }

  $hwnd = [IntPtr]([int64]$Win.hwnd)
  if ([Win32]::GetForegroundWindow() -ne $hwnd) {
    return @{ ok = $false; error = 'Focus stolen, send cancelled' }
  }
  # The chat input owns the keyboard after a chat is opened. Clearing it first keeps a
  # leftover draft out of the message (and off the customer's screen).
  Clear-WxField
  if (-not (Invoke-ClipboardWithRetry { [System.Windows.Forms.Clipboard]::SetText($Text) })) {
    return @{ ok = $false; error = 'Clipboard busy (text)' }
  }
  Send-KeySeq 'ctrl+v'
  Start-Sleep -Milliseconds 400
  Send-KeySeq 'enter'
  return @{ ok = $true; title = $Win.title; sent = $true; opened = $opened.opened }
}

# One file/image: open the session (verified) -> clipboard(bitmap|file list) -> paste -> Enter
function Invoke-SendFile {
  param($Win, [string]$Target, [string]$Path, [string]$FileKind, $Open)

  if (-not (Test-Path -LiteralPath $Path)) {
    return @{ ok = $false; error = 'File not found: ' + $Path }
  }
  $opened = Open-WxSession -Win $Win -Target $Target -IsGroup $Open.isGroup -Names $Open.names -ShotDir $Open.shotDir
  if (-not $opened.ok) { return $opened }

  $hwnd = [IntPtr]([int64]$Win.hwnd)
  if ([Win32]::GetForegroundWindow() -ne $hwnd) {
    return @{ ok = $false; error = 'Focus stolen, send cancelled' }
  }

  # Clear a leftover draft first: the file has to be the only thing in the message.
  Clear-WxField

  $ext = [System.IO.Path]::GetExtension($Path).ToLower()
  $pasteAsImage = ($FileKind -eq 'image') -and ($ext -in '.png', '.jpg', '.jpeg', '.bmp', '.gif')
  if ($pasteAsImage) {
    Add-Type -AssemblyName System.Drawing
    if (-not (Invoke-ClipboardWithRetry { Set-ImageFileClipboard $Path })) {
      return @{ ok = $false; error = 'Clipboard busy (image)' }
    }
  } else {
    if (-not (Invoke-ClipboardWithRetry { Set-FileDropClipboard $Path })) {
      return @{ ok = $false; error = 'Clipboard busy (file)' }
    }
  }
  Send-KeySeq 'ctrl+v'
  Start-Sleep -Milliseconds ($(if ($pasteAsImage) { 1200 } else { 900 }))
  Send-KeySeq 'enter'
  return @{ ok = $true; title = $Win.title; sent = $true; asImage = $pasteAsImage; opened = $opened.opened }
}

# Session names the app knows (one per line, UTF-8): used to tell the chat we opened
# apart from every other chat, so a similar name can not pass as the target.
function Get-WxTargetNames([string]$File) {
  $out = @()
  if (-not [string]::IsNullOrWhiteSpace($File) -and (Test-Path -LiteralPath $File)) {
    foreach ($line in (Get-Content -LiteralPath $File -Encoding UTF8)) {
      $t = $line.Trim()
      if ($t -ne '') { $out += $t }
    }
  }
  return ,$out
}

$out = @{ ok = $false }
$instances = @()
try {
  $instances = @(Get-WeChatInstances)
  $count = $instances.Count

  if ($Action -eq 'list') {
    $brief = @()
    foreach ($i in $instances) {
      $brief += @{
        pid = $i.pid; title = $i.title; proc = $i.proc
        visible = $i.visible; cls = $i.cls; windows = $i.windowCount
      }
    }
    $out = @{ ok = $true; count = $count; instances = $brief; detail = (Format-WeChatInstanceList -Instances $instances) }
  } elseif ($count -eq 0) {
    $out = @{ ok = $false; error = 'WeChat window not found (please login first)' }
  } elseif ($count -gt 1 -and ($Action -eq 'send' -or $Action -eq 'sendfile' -or $Action -eq 'keys' -or $Action -eq 'open')) {
    # Typing into the wrong WeChat instance is unrecoverable: refuse and name them.
    $out = @{
      ok = $false
      error = 'Multiple WeChat windows found: ' + $count + ' instances (' + (Format-WeChatInstanceList -Instances $instances) + ')'
    }
  } else {
    $win = $instances[0]
    $hwnd = [IntPtr]([int64]$win.hwnd)
    if ($Action -eq 'focus') {
      $focused = Focus-WeChatWindow $hwnd
      $out = @{ ok = $true; focused = $focused; title = $win.title; pid = $win.pid }
    } elseif ($Action -eq 'isfocus') {
      $out = @{ ok = $true; focused = ([Win32]::GetForegroundWindow() -eq $hwnd); title = $win.title }
    } elseif ($Action -eq 'keys') {
      Focus-WeChatWindow $hwnd | Out-Null
      Start-Sleep -Milliseconds 150
      Send-KeySeq $Keys
      $out = @{ ok = $true; title = $win.title }
    } elseif ($Action -eq 'send' -or $Action -eq 'sendfile' -or $Action -eq 'open') {
      $shotDir = $ShotDir
      if ([string]::IsNullOrWhiteSpace($shotDir)) { $shotDir = [System.IO.Path]::GetTempPath() }
      if (-not (Test-Path -LiteralPath $shotDir)) { [void](New-Item -ItemType Directory -Path $shotDir -Force) }
      $open = @{
        isGroup = ($IsGroup -ne 0)
        names   = @(Get-WxTargetNames $NamesFile)
        shotDir = $shotDir
      }
      if ($Action -eq 'open') {
        $out = Open-WxSession -Win $win -Target $Target -IsGroup $open.isGroup -Names $open.names -ShotDir $open.shotDir
      } elseif ($Action -eq 'send') {
        $out = Invoke-SendText -Win $win -Target $Target -Text $Text -Open $open
      } else {
        $out = Invoke-SendFile -Win $win -Target $Target -Path $Path -FileKind $FileKind -Open $open
      }
    } else {
      $out = @{ ok = $false; error = "Unknown action: $Action" }
    }
  }
} catch {
  $out = @{ ok = $false; error = $_.Exception.Message }
}

[Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 6))
