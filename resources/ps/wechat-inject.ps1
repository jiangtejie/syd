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
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
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

    // One process snapshot beats one query per pid: a desktop has ~100 distinct
    // window-owning pids and Process.GetProcessById costs ~5ms each (measured 550ms),
    // while Process.GetProcesses() hands back every name in ~8ms.
    var names = new Dictionary<int, string>();
    try {
      foreach (var p in Process.GetProcesses()) {
        try { names[p.Id] = p.ProcessName; } catch { }
        p.Dispose();
      }
    } catch { }
    foreach (var rec in list) {
      if (names.ContainsKey(rec.pid)) { rec.proc = names[rec.pid]; continue; }
      rec.proc = ProcName(rec.pid);   // started after the snapshot, or inaccessible
    }
    return list;
  }

  public static long GetForeground() { return GetForegroundWindow().ToInt64(); }

  // Milliseconds since the last keyboard/mouse input of ANY source. Used to stand back
  // while the operator is working: typing into a window we are also driving ends up with
  // their characters inside our search box (and our click inside their workflow).
  public static int IdleMs() {
    var li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref li)) { return int.MaxValue; }
    return unchecked((int)((uint)Environment.TickCount - li.dwTime));
  }

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

# Text we last put on the clipboard. Restoring the operator's clipboard must only happen
# while OUR text is still there - anything else means they copied something new meanwhile.
$script:WxLastClipText = ''

function Set-WxTextClipboard {
  param([string]$Text)
  if (-not (Invoke-ClipboardWithRetry { [System.Windows.Forms.Clipboard]::SetText($Text) })) { return $false }
  $script:WxLastClipText = $Text
  return $true
}

function Set-ImageFileClipboard([string]$p) {
  $img = [System.Drawing.Image]::FromFile($p)
  try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }
  $script:WxLastClipText = ''
}

function Set-FileDropClipboard([string]$p) {
  $list = New-Object System.Collections.Specialized.StringCollection
  [void]$list.Add($p)
  [System.Windows.Forms.Clipboard]::SetFileDropList($list)
  $script:WxLastClipText = ''
}

function KeyDown([int]$vk) { [void][Win32]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero) }
function KeyUp([int]$vk)   { [void][Win32]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero) }

# Empty whatever input currently has the keyboard (the search box keeps the previous
# query, and a chat keeps a draft). Ctrl+A alone is not dependable inside WeChat's
# inputs, so the sweep of backspaces is what actually guarantees an empty field.
function Clear-WxField {
  Send-KeySeq 'ctrl+a'
  Start-WxPause -Base 170 -Spread 70 -Hesitate $false
  Send-KeySeq 'delete'
  Start-WxPause -Base 130 -Spread 60 -Hesitate $false
  # Ctrl+A + Delete is not dependable inside WeChat inputs; sweep whatever is left with
  # backspaces (sent in a fast burst, the way a held-down Backspace behaves).
  Send-KeySeq (('backspace,' * 24).TrimEnd(',')) -Quick
  Start-WxPause -Base 170 -Spread 80 -Hesitate $false
}

# Send the keystrokes the way a hand does: a key is held for tens of milliseconds, the
# gap to the next key is not constant, and roughly every eighth action there is a short
# "hesitation" pause. Everything still happens inside the same window, so the flow is
# not slower in any way that matters - it just stops looking like a metronome.
function Send-KeySeq {
  param([string]$seq, [switch]$Quick)
  # While a send is in flight the keyboard must still belong to WeChat: if another app
  # grabbed the foreground (a stray click, a popup, a toast), these keys would be typed
  # into THAT app - ESC into its dialogs, Ctrl+V into its fields. Abort instead.
  if ($script:WxKeyGuardHwnd -ne 0 -and ([Win32]::GetForegroundWindow() -ne [IntPtr]$script:WxKeyGuardHwnd)) {
    throw 'Focus stolen, send cancelled (keys blocked: the foreground window is not WeChat)'
  }
  # Quick is for bulk repeats (the backspace sweep): a human holding Backspace deletes
  # in a burst, so those must NOT be paced like deliberate key presses.
  $hold = 45; $gap = 30; $modHold = 18; $modGap = 25
  if ($Quick) { $hold = 14; $gap = 10; $modHold = 8; $modGap = 8 }
  foreach ($k in $seq -split ',') {
    $k = $k.Trim().ToLower()
    if ($k -eq '') { continue }
    if ($k -match '^(ctrl|alt|shift)\+(.+)$') {
      $modVk = $MOD[$Matches[1]]
      $keyVk = $VK[$Matches[2].Trim()]
      if ($null -eq $keyVk) { continue }
      KeyDown $modVk
      Start-Sleep -Milliseconds (Get-WxJitter -Base $modHold -Spread ([int]($modHold / 2)))
      KeyDown $keyVk
      Start-Sleep -Milliseconds (Get-WxJitter -Base $hold -Spread ([int]($hold / 2)))
      KeyUp $keyVk
      Start-Sleep -Milliseconds (Get-WxJitter -Base $modGap -Spread ([int]($modGap / 2)))
      KeyUp $modVk
    } else {
      $keyVk = $VK[$k]
      if ($null -eq $keyVk) { continue }
      KeyDown $keyVk
      Start-Sleep -Milliseconds (Get-WxJitter -Base $hold -Spread ([int]($hold / 2)))
      KeyUp $keyVk
    }
    Start-Sleep -Milliseconds (Get-WxJitter -Base $gap -Spread ([int]($gap / 2)))
  }
  if ((-not $Quick) -and (Get-Random -Minimum 1 -Maximum 9) -eq 1) {
    Start-Sleep -Milliseconds (Get-WxJitter -Base 380 -Spread 220)
  }
}

# Did the operator take the mouse away from where we left it? Checked right before the
# body goes in, so backing off costs nothing (nothing has been typed into the chat yet).
function Test-WxCursorMoved {
  param([int[]]$Origin, [int]$Tolerance = 60)
  if ($null -eq $Origin -or $Origin.Count -lt 2) { return $false }
  $now = [WxUi32]::Cursor()
  return ([Math]::Abs($now[0] - $Origin[0]) -gt $Tolerance -or [Math]::Abs($now[1] - $Origin[1]) -gt $Tolerance)
}

# Where the send currently is, written next to the screenshots. If the process is killed
# (the caller's 30s timeout) the app can read it and tell "nothing was typed yet" from
# "Enter was already pressed" - the difference between a safe retry and a duplicate message.
function Set-WxPhase {
  param([string]$ShotDir, [string]$Phase)
  if ([string]::IsNullOrWhiteSpace($ShotDir)) { return }
  try { [System.IO.File]::WriteAllText((Join-Path $ShotDir 'wx-phase.txt'), $Phase) } catch { }
}

# Keep the operator's clipboard: the injection needs it for the session name and the
# body, but silently eating whatever they had copied is both rude and a real bug when
# they are about to paste it themselves.
function Save-WxClipboard {
  try {
    if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
      return @{ kind = 'image'; data = [System.Windows.Forms.Clipboard]::GetImage() }
    }
    if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
      return @{ kind = 'files'; data = [System.Windows.Forms.Clipboard]::GetFileDropList() }
    }
    if ([System.Windows.Forms.Clipboard]::ContainsText()) {
      return @{ kind = 'text'; data = [System.Windows.Forms.Clipboard]::GetText() }
    }
  } catch { }
  return $null
}

# Only put it back if the clipboard still holds what WE put there - if the operator
# copied something in the meantime, theirs wins.
function Restore-WxClipboard {
  param($Saved, [string]$OurText = '')
  if ($null -eq $Saved) { return }
  if ([string]::IsNullOrEmpty($OurText)) { $OurText = $script:WxLastClipText }
  if ($Saved.kind -eq 'text') {
    # put it back only while our own text is still on the clipboard
    $now = ''
    try { $now = [System.Windows.Forms.Clipboard]::GetText() } catch { }
    if (-not [string]::IsNullOrEmpty($OurText) -and $now -ne $OurText) { return }
    if ([string]::IsNullOrEmpty($OurText) -and $now -ne '') { return }
  }
  try {
    if ($Saved.kind -eq 'image') { [System.Windows.Forms.Clipboard]::SetImage($Saved.data) }
    elseif ($Saved.kind -eq 'files') { [System.Windows.Forms.Clipboard]::SetFileDropList($Saved.data) }
    else { [System.Windows.Forms.Clipboard]::SetText([string]$Saved.data) }
  } catch { }
}

# Stand back while the operator is typing/clicking. A background send that fights the
# person in front of the screen is how focus-steal failures (and stray characters in the
# search box) happen in the first place.
function Wait-WxUserIdle {
  param([int]$MinIdleMs = 1200, [int]$TimeoutMs = 8000)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    if ([Win32]::IdleMs() -ge $MinIdleMs) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return ([Win32]::IdleMs() -ge $MinIdleMs)
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

# ------------------------------------------------- foreground / coverage

# While a send is in flight, every keystroke must land in WeChat. 0 = no guard (the
# diagnostics actions type nothing). Set by the dispatcher before send/sendfile/open.
$script:WxKeyGuardHwnd = [int64]0

function Get-WxProcessName([int]$ProcId) {
  try { return (Get-Process -Id $ProcId -ErrorAction Stop).ProcessName } catch { return ('pid ' + $ProcId) }
}

# Parse "[WxUi32]::At" ("pid=1 cls=X title=[Y]") into pid / cls / title.
function ConvertFrom-WxAt([string]$At) {
  $out = @{ pid = 0; cls = ''; title = '' }
  if ([string]::IsNullOrWhiteSpace($At)) { return $out }
  if ($At -match 'pid=(\d+)') { $out.pid = [int]$Matches[1] }
  if ($At -match 'cls=([^ ]*)') { $out.cls = $Matches[1] }
  if ($At -match 'title=\[(.*)\]') { $out.title = $Matches[1] }
  return $out
}

<#
  Is something else sitting on top of the WeChat window - right where we are about to
  work? Get-WxWindowShot is a SCREEN capture of the window rect, so a covered window
  silently yields a picture of whatever is in front, and every OCR decision after that is
  made on the wrong app. Probing the title bar and the search-box strip (the two places
  this flow touches) turns that into a named, actionable failure.
  Returns @{ proc; title; x; y } for the covering app, or $null when WeChat is clear.
#>
function Get-WxCoveredBy {
  param([int]$OwnerPid, [int[]]$Rect)
  if ($null -eq $Rect -or $Rect.Count -lt 4) { return $null }
  if ($Rect[2] -le 0 -or $Rect[3] -le 0) { return $null }
  $pts = @(
    @(($Rect[0] + [int]($Rect[2] / 2)), ($Rect[1] + 12)),
    @(($Rect[0] + 130), ($Rect[1] + 52))
  )
  foreach ($p in $pts) {
    $at = ConvertFrom-WxAt ([WxUi32]::At([int]$p[0], [int]$p[1]))
    if ($at.pid -le 0 -or $at.pid -eq $OwnerPid) { continue }
    # Braces would break the single-line JSON this script prints on stdout.
    $title = ([string]$at.title) -replace '[{}]', ''
    return @{ proc = (Get-WxProcessName $at.pid); title = $title; x = $p[0]; y = $p[1] }
  }
  return $null
}

<#
  One message naming the app that is in the way. humanizeInjectError turns it into an
  actionable Chinese hint; "not clickable" alone never told anyone what to do.
#>
function New-WxCoveredError {
  param([string]$Stage, $Cover)
  $who = 'another window'
  if ($null -ne $Cover) {
    $who = [string]$Cover.proc
    if (-not [string]::IsNullOrWhiteSpace([string]$Cover.title)) {
      $who = $who + ' ("' + (([string]$Cover.title) -replace '[{}]', '') + '")'
    }
  }
  return ('WeChat window is covered by another window at ' + $Stage + ': ' + $who)
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
  # Locked workstation: there is no desktop to read or click, and every screenshot would
  # come back black. Say so instead of failing with a confusing cascade.
  if ([Win32]::GetForegroundWindow() -eq [IntPtr]::Zero) {
    return @{ ok = $false; error = 'Workstation is locked' }
  }

  # Stand back while the operator is working: taking the keyboard away from someone who
  # is typing is how their characters end up in our search box (and how "focus stolen"
  # happens). Wait for a pause, and give up rather than fight them.
  if (-not (Wait-WxUserIdle -MinIdleMs 1200 -TimeoutMs 6000)) {
    return @{ ok = $false; error = 'User is actively typing, send postponed' }
  }

  Set-WxPhase -ShotDir $ShotDir -Phase 'searching'
  # Bring the window up, then open its search box the way a person would.
  #
  # Measured behaviour of WeChat 4.x (Qt), all of it load-bearing:
  #  - SetForegroundWindow is refused for a background process, and even when it
  #    "succeeds" the client never gets its real activation: it silently swallows keys.
  #  - a mouse click IS the activation, but the click that activates a background window
  #    is consumed by the activation itself and never reaches the widget underneath.
  #    (In production WeChat sits behind the app, so that first click is ALWAYS eaten -
  #    which is exactly why "click the search box once" used to do nothing.)
  # So: click a harmless spot to activate, then click the search box for real.
  # Raise() alone only toggles topmost (a visible flash) and SetForegroundWindow is
  # refused for a background process: the window flashed up and dropped straight back
  # behind whatever was in front - and everything below kept going as if it had not.
  # Focus-WeChatWindow runs the verified ladder and says so when it fails, instead of
  # letting the screen capture below "read" the covering app.
  if (-not (Focus-WeChatWindow $hwnd)) {
    return @{ ok = $false; error = (New-WxCoveredError -Stage 'the WeChat window' -Cover (Get-WxCoveredBy -OwnerPid $Win.pid -Rect ([WxUi32]::Rect($hwnd)))) }
  }
  Start-WxPause -Base 320 -Spread 120 -Hesitate $false
  $rect = [WxUi32]::Rect($hwnd)
  # Foreground but still covered (a topmost overlay does exactly this): the screenshot
  # below would be a picture of that overlay, so stop before it and name the blocker.
  $cover = Get-WxCoveredBy -OwnerPid $Win.pid -Rect $rect
  if ($null -ne $cover) {
    return @{ ok = $false; error = (New-WxCoveredError -Stage 'the search box' -Cover $cover) }
  }
  # Find the search box by looking at the window, not by assuming a fixed offset: the
  # layout moves between versions, window sizes and pane widths, and a stale offset means
  # clicking somewhere that is not the field at all. The fallback offset is kept as a
  # second opinion for the retry below.
  $fallback = Resolve-WxClickPoint -Rect $rect -X ($rect[0] + 130) -Y ($rect[1] + 52) -OwnerPid $Win.pid
  $boxPt = $null
  $boxSource = 'fallback'
  $probePath = Join-Path $ShotDir 'wx-before-search.png'
  $probeShot = Get-WxWindowShot -Hwnd ([int64]$Win.hwnd) -OutPath $probePath
  if ($null -ne $probeShot) {
    $probeLines = Get-WxOcrLines -Path $probeShot.path -Scale $probeShot.scale
    if ($null -ne $probeLines) {
      $boxLine = Find-WxSearchBoxLine -Lines @($probeLines) -WinW $rect[2] -WinH $rect[3]
      if ($null -ne $boxLine) {
        $boxPt = Resolve-WxClickPoint -Rect $rect -X ($rect[0] + $boxLine.x + 24) -Y ($rect[1] + $boxLine.y + [int]($boxLine.h / 2)) -OwnerPid $Win.pid
        if ($null -ne $boxPt) { $boxSource = 'ocr' }
      }
    }
  }
  if ($null -eq $boxPt) { $boxPt = $fallback }
  if ($null -eq $boxPt) { return @{ ok = $false; error = 'WeChat search box is not clickable (window too small or covered)' } }
  $searchX = $boxPt[0]
  $searchY = $boxPt[1]
  # Rows above this line are the field itself / the title bar, never a result.
  $searchBelowY = 80                                # fallback path: same offset as the click point
  if ($null -ne $boxLine) { $searchBelowY = [int]$boxLine.y + [int]$boxLine.h + 4 }
  $atClick = [WxUi32]::At($searchX, $searchY)
  # First click activates the window (that click is eaten by the activation), the second
  # one really opens and focuses the field - so no separate title-bar click is needed.
  # Both are ownership-checked at the moment of the click: if WeChat dropped behind in the
  # meantime the click would otherwise land in the app that took its place.
  if (-not (Invoke-WxClick -X $searchX -Y $searchY -OwnerPid $Win.pid)) {
    return @{ ok = $false; error = (New-WxCoveredError -Stage 'the search box' -Cover (Get-WxCoveredBy -OwnerPid $Win.pid -Rect $rect)) }
  }
  Start-WxPause -Base 800 -Spread 250 -Hesitate $false
  if (-not (Invoke-WxClick -X $searchX -Y $searchY -OwnerPid $Win.pid)) {
    return @{ ok = $false; error = (New-WxCoveredError -Stage 'the search box' -Cover (Get-WxCoveredBy -OwnerPid $Win.pid -Rect $rect)) }
  }
  Start-WxPause -Base 620 -Spread 180 -Hesitate $false
  # Diagnostics: did that first click actually open the dropdown? (If the click was eaten
  # by window activation this is False, and the shot below shows exactly what happened.)
  $openAfterClick = $false
  $afterClickPath = Join-Path $ShotDir 'wx-after-click.png'
  $shot0 = Get-WxWindowShot -Hwnd ([int64]$Win.hwnd) -OutPath $afterClickPath
  if ($null -ne $shot0) {
    $lines0 = Get-WxOcrLines -Path $shot0.path -Scale $shot0.scale
    if ($null -ne $lines0) { $openAfterClick = Test-WxSearchDropdown -Lines @($lines0) }
  }

  $shot = $null
  $row = $null
  $sawDropdown = $false
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    if ($attempt -eq 2) {
      # The OCR point may have been the wrong run: try the classic offset instead.
      $retryClick = $false
      if ($null -ne $fallback -and ($fallback[0] -ne $searchX -or $fallback[1] -ne $searchY)) {
        $retryClick = Invoke-WxClick -X $fallback[0] -Y $fallback[1] -OwnerPid $Win.pid
      } else {
        $retryClick = Invoke-WxClick -X $searchX -Y $searchY -OwnerPid $Win.pid
      }
      if (-not $retryClick) {
        return @{ ok = $false; error = (New-WxCoveredError -Stage 'the search box' -Cover (Get-WxCoveredBy -OwnerPid $Win.pid -Rect $rect)) }
      }
      Start-WxPause -Base 620 -Spread 180 -Hesitate $false
    } elseif ($attempt -gt 2) {
      # Last resort: the keyboard shortcut.
      Send-KeySeq 'esc'
      Start-WxPause -Base 220 -Spread 90 -Hesitate $false
      Send-KeySeq 'ctrl+f'
      Start-WxPause -Base 520 -Spread 160 -Hesitate $false
    }
    Clear-WxField
    if (-not (Set-WxTextClipboard -Text $Target)) {
      return @{ ok = $false; error = 'Clipboard busy (target)' }
    }
    Send-KeySeq 'ctrl+v'
    Start-WxPause -Base 900 -Spread 250

    if ([Win32]::GetForegroundWindow() -ne $hwnd) {
      return @{ ok = $false; error = 'Focus stolen, send cancelled' }
    }
    $shotPath = Join-Path $ShotDir 'wx-last-search.png'
    $shot = Get-WxWindowShot -Hwnd ([int64]$Win.hwnd) -OutPath $shotPath
    if ($null -eq $shot) { return @{ ok = $false; error = 'Screenshot failed' } }
    $lines = Get-WxOcrLines -Path $shot.path -Scale $shot.scale
    if ($null -eq $lines) { return @{ ok = $false; error = 'OCR failed on the search screenshot' } }

    # Did the query land? Do NOT ask the input field: OCR of that one line is not reliable
    # (it regularly reads as the magnifier glyph only, while the text it contains shows up
    # in the result rows instead). The dropdown's own rows are the honest signal:
    #   - a row we can click, or
    #   - any row that resembles the target  => the typed text got through.
    # A clickable row is the strongest evidence and does not depend on any section
    # header being recognized (WeChat puts the contact hit above every header).
    $row = Select-WxSearchRow -Lines @($lines) -Target $Target -IsGroup $IsGroup -BelowY $searchBelowY
    if ($null -ne $row) {
      $sawDropdown = $true
      break
    }
    $dropdownOpen = Test-WxSearchDropdown -Lines @($lines)
    $queryLanded = $false
    foreach ($l in @($lines)) {
      if ($l.y -le $searchBelowY) { continue }
      if ((Get-WxNameScore $l.text $Target) -ge 0.5) { $queryLanded = $true }
    }
    if ($dropdownOpen -and $queryLanded) {
      $sawDropdown = $true
      break
    }
    $lastBoxText = ''
    foreach ($l in @($lines)) {
      if ($l.y -le 80 -and $l.x -le 320) { $lastBoxText = $lastBoxText + ' ' + $l.text }
    }
    [void][Win32]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 250
  }
  if (-not $sawDropdown) {
    $diag = ' (clicked at ' + $searchX + ',' + $searchY + ' [' + $boxSource + '] -> ' + (ConvertTo-WxMsgText $atClick) +
            '; openedAfterClick=' + $openAfterClick + '; box=[' + (ConvertTo-WxMsgText $lastBoxText) +
            ']; attempts=' + $attempt + ')'
    return @{ ok = $false; error = ('Search box did not open in WeChat' + $diag) }
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

  $rowPoint = Resolve-WxClickPoint -Rect $shot.rect -X ($shot.rect[0] + $row.x + 40) -Y ($shot.rect[1] + $row.y + [int]($row.h / 2)) -OwnerPid $Win.pid
  if ($null -eq $rowPoint) { return @{ ok = $false; error = 'Search result row is not clickable (window moved?)' } }
  if (-not (Invoke-WxClick -X $rowPoint[0] -Y $rowPoint[1] -OwnerPid $Win.pid)) {
    return @{ ok = $false; error = (New-WxCoveredError -Stage 'the search result row' -Cover (Get-WxCoveredBy -OwnerPid $Win.pid -Rect $shot.rect)) }
  }
  # Remember where the pointer came to rest: used later to notice the operator grabbing
  # the mouse mid-send (in which case we back off instead of fighting them).
  $cursorAfterClick = [WxUi32]::Cursor()
  Start-WxPause -Base 900 -Spread 260

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
  Set-WxPhase -ShotDir $ShotDir -Phase 'opened'
  return @{
    ok = $true; opened = (ConvertTo-WxMsgText $m.text); score = $direct
    cursor = $cursorAfterClick; box = $boxSource
  }
}

# Full text injection: open the session (verified) -> paste body -> Enter.
function Invoke-SendText {
  param($Win, [string]$Target, [string]$Text, $Open)

  $shotDir = $Open.shotDir
  Set-WxPhase -ShotDir $shotDir -Phase 'start'
  $savedClip = Save-WxClipboard
  try {
    $opened = Open-WxSession -Win $Win -Target $Target -IsGroup $Open.isGroup -Names $Open.names -ShotDir $shotDir
    if (-not $opened.ok) { return $opened }

    $hwnd = [IntPtr]([int64]$Win.hwnd)
    if ([Win32]::GetForegroundWindow() -ne $hwnd) {
      return @{ ok = $false; error = 'Focus stolen, send cancelled' }
    }
    if (Test-WxCursorMoved -Origin $opened.cursor -Tolerance 60) {
      return @{ ok = $false; error = 'User took the mouse during send, cancelled' }
    }

    # The chat input owns the keyboard after a chat is opened. Clearing it first keeps a
    # leftover draft out of the message (and off the customer's screen).
    Clear-WxField
    if (-not (Set-WxTextClipboard -Text $Text)) {
      return @{ ok = $false; error = 'Clipboard busy (text)' }
    }
    Set-WxPhase -ShotDir $shotDir -Phase 'typing'
    Send-KeySeq 'ctrl+v'
    Start-WxPause -Base 420 -Spread 170
    # Read the chat input back before pressing Enter: Enter is the point of no return, and
    # an empty or wrong input is either a silent no-send or somebody else's leftover text.
    # If the window lost the foreground the frame would show whatever is in front, so make
    # sure WeChat is in front first - otherwise this gate would blame the paste.
    if ([Win32]::GetForegroundWindow() -ne $hwnd) {
      [Win32]::Raise($hwnd)
      [void][Win32]::SetForegroundWindow($hwnd)
      Start-WxPause -Base 400 -Spread 150 -Hesitate $false
    }
    if ([Win32]::GetForegroundWindow() -ne $hwnd) {
      return @{ ok = $false; error = 'Focus stolen, send cancelled' }
    }
    $rect = [WxUi32]::Rect($hwnd)
    $beforeEnter = Join-Path $shotDir 'wx-before-enter.png'
    $shotB = Get-WxWindowShot -Hwnd ([int64]$Win.hwnd) -OutPath $beforeEnter
    if ($null -eq $shotB) { return @{ ok = $false; error = 'Screenshot failed' } }
    $linesB = Get-WxOcrLines -Path $shotB.path -Scale $shotB.scale
    if ($null -eq $linesB) { return @{ ok = $false; error = 'OCR failed on the input screenshot' } }
    $paneLeft = Find-WxPaneLeft -Lines @($linesB) -WinW $rect[2] -WinH $rect[3]
    if (-not (Test-WxComposerHasBody -Lines @($linesB) -Text $Text -WinW $rect[2] -WinH $rect[3] -PaneLeft $paneLeft)) {
      Send-KeySeq 'esc'
      return @{ ok = $false; error = 'Body text is not in the chat input, Enter not pressed' }
    }
    # Past this point the message is going out: the phase file is what tells the app that
    # a killed/timed-out process must NOT be retried blindly.
    Set-WxPhase -ShotDir $shotDir -Phase 'enter'
    Send-KeySeq 'enter'
    Set-WxPhase -ShotDir $shotDir -Phase 'done'
    return @{ ok = $true; title = $Win.title; sent = $true; opened = $opened.opened }
  } finally {
    Start-WxPause -Base 320 -Spread 160 -Hesitate $false
    Restore-WxClipboard -Saved $savedClip
  }
}

# One file/image: open the session (verified) -> clipboard(bitmap|file list) -> paste -> Enter
function Invoke-SendFile {
  param($Win, [string]$Target, [string]$Path, [string]$FileKind, $Open)

  if (-not (Test-Path -LiteralPath $Path)) {
    return @{ ok = $false; error = 'File not found: ' + $Path }
  }
  $shotDir = $Open.shotDir
  Set-WxPhase -ShotDir $shotDir -Phase 'start'
  $savedClip = Save-WxClipboard
  try {
    $opened = Open-WxSession -Win $Win -Target $Target -IsGroup $Open.isGroup -Names $Open.names -ShotDir $shotDir
    if (-not $opened.ok) { return $opened }

    $hwnd = [IntPtr]([int64]$Win.hwnd)
    if ([Win32]::GetForegroundWindow() -ne $hwnd) {
      return @{ ok = $false; error = 'Focus stolen, send cancelled' }
    }
    if (Test-WxCursorMoved -Origin $opened.cursor -Tolerance 60) {
      return @{ ok = $false; error = 'User took the mouse during send, cancelled' }
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
    Set-WxPhase -ShotDir $shotDir -Phase 'typing'
    Send-KeySeq 'ctrl+v'
    Start-WxPause -Base ($(if ($pasteAsImage) { 1200 } else { 900 })) -Spread 250
    Set-WxPhase -ShotDir $shotDir -Phase 'enter'
    Send-KeySeq 'enter'
    Set-WxPhase -ShotDir $shotDir -Phase 'done'
    return @{ ok = $true; title = $Win.title; sent = $true; asImage = $pasteAsImage; opened = $opened.opened }
  } finally {
    Start-WxPause -Base 320 -Spread 160 -Hesitate $false
    Restore-WxClipboard -Saved $savedClip
  }
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
      # From here on every keystroke must land in this window: Send-KeySeq refuses to
      # type once the foreground has moved to another app (see the guard there).
      $script:WxKeyGuardHwnd = [int64]$win.hwnd
      $shotDir = $ShotDir
      if ([string]::IsNullOrWhiteSpace($shotDir)) { $shotDir = [System.IO.Path]::GetTempPath() }
      if (-not (Test-Path -LiteralPath $shotDir)) { [void](New-Item -ItemType Directory -Path $shotDir -Force) }
      $open = @{
        isGroup = ($IsGroup -ne 0)
        names   = @(Get-WxTargetNames $NamesFile)
        shotDir = $shotDir
      }
      if ($Action -eq 'open') {
        # diagnostics use the clipboard too - do not eat whatever the operator had copied
        $saved = Save-WxClipboard
        try {
          $out = Open-WxSession -Win $win -Target $Target -IsGroup $open.isGroup -Names $open.names -ShotDir $open.shotDir
        } finally {
          Start-WxPause -Base 200 -Spread 100 -Hesitate $false
          Restore-WxClipboard -Saved $saved
        }
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
