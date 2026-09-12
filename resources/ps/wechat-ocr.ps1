# Screen + OCR helpers for the WeChat injector (T8).
#
# Why this exists: WeChat 4.x (Weixin.exe, Qt + MMUIRender) is a fully self-drawn UI.
# UI Automation exposes exactly one node - a "MMUIRenderSubWindow" surface - so the
# search dropdown rows can NOT be read from the accessibility tree, and the popular
# "UIA + click the session row" recipes that worked on WeChat 3.x do not work here.
# Typing a session name and pressing Enter hits the FIRST row of the dropdown, which
# on 4.x is the "search the web" section (plus 1-2 query suggestions) - never the chat.
#
# So the injector now: screenshot the window -> read it with the OCR engine built into
# Windows (Windows.Media.Ocr, zh-Hans, ~150ms/frame) -> click the row that really is
# the target -> screenshot again and read the conversation header -> only then type.
# A header that does not match the target aborts the send with nothing typed.
#
# Pure helpers (name folding, LCS scoring, row/header selection) run without WeChat
# and are covered by scripts/wechat-ocr-selftest.ps1.
#
# NOTE: keep this file ASCII-only (PS 5.1 parses no-BOM scripts as ANSI).

# Search-dropdown section labels, built from code points to keep the file ASCII
# U+641C U+7D22 U+7F51 U+7EDC U+7ED3 U+679C = "search the web"
$script:WxLblSearchWeb = [string][char]0x641C + [char]0x7D22 + [char]0x7F51 + [char]0x7EDC + [char]0x7ED3 + [char]0x679C
# U+7FA4 U+804A = "group chats"
$script:WxLblGroup = [string][char]0x7FA4 + [char]0x804A
# U+8054 U+7CFB U+4EBA = "contacts"
$script:WxLblContact = [string][char]0x8054 + [char]0x7CFB + [char]0x4EBA
# U+804A U+5929 U+8BB0 U+5F55 = "chat history"
$script:WxLblHistory = [string][char]0x804A + [char]0x5929 + [char]0x8BB0 + [char]0x5F55
# "most frequently used" - the block WeChat puts above everything else once a chat
# was opened recently. Measured label is U+6700 U+5E38 U+4F7F U+7528, but OCR has been
# seen dropping the leading character, so all shortened readings are accepted.
$script:WxLblCommonForms = @(
  ([string][char]0x6700 + [char]0x5E38 + [char]0x4F7F + [char]0x7528),
  ([string][char]0x6700 + [char]0x5E38 + [char]0x7528),
  ([string][char]0x5E38 + [char]0x4F7F + [char]0x7528),
  ([string][char]0x5E38 + [char]0x7528)
)

$script:WxOcrEngine = $null
$script:WxOcrAsTask = $null

if ($null -eq ('WxUi32' -as [type])) {
  Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WxUi32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  public static void SetPerMonitorDpiAware() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
    catch { try { SetProcessDPIAware(); } catch { } }
  }
  public static int[] Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return new int[] { r.L, r.T, r.R - r.L, r.B - r.T }; }
  public static int[] Cursor() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
  public static string At(int x, int y) {
    POINT p; p.X = x; p.Y = y;
    IntPtr h = WindowFromPoint(p);
    if (h == IntPtr.Zero) { return "none"; }
    int pid; GetWindowThreadProcessId(h, out pid);
    var c = new StringBuilder(128); GetClassNameW(h, c, 128);
    var t = new StringBuilder(128); GetWindowTextW(h, t, 128);
    return "pid=" + pid + " cls=" + c.ToString() + " title=[" + t.ToString() + "]";
  }
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
  public static void Down() { mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); }
  public static void Up() { mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); }
  public static void MoveTo(int x, int y) { SetCursorPos(x, y); }
}
"@
}

# Screenshot pixels, GetWindowRect and SetCursorPos must share one coordinate space
# (physical pixels) or the click lands somewhere else on a scaled display. Per-monitor
# awareness matters when the WeChat window sits on a screen whose scale differs from the
# primary one; fall back to the older system-wide call on builds without the newer API.
try { [void][WxUi32]::SetPerMonitorDpiAware() } catch { }

# ---------------------------------------------------------------- name matching

# Fold a UI string to comparable form: drop spaces/zero-width and every symbol,
# keep CJK + letters + digits. OCR of Chinese puts spaces between glyphs, so folding
# is what makes the spaced OCR glyphs comparable to the real name.
function ConvertTo-WxName {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return '' }
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $Text.ToLowerInvariant().ToCharArray()) {
    $c = [int][char]$ch
    if (($c -ge 0x30 -and $c -le 0x39) -or ($c -ge 0x61 -and $c -le 0x7A) -or
        ($c -ge 0x4E00 -and $c -le 0x9FFF) -or ($c -ge 0x3400 -and $c -le 0x4DBF)) {
      [void]$sb.Append($ch)
    }
  }
  return $sb.ToString()
}

function Get-WxLcsLength {
  param([string]$A, [string]$B)
  if ($A.Length -eq 0 -or $B.Length -eq 0) { return 0 }
  $prev = New-Object 'int[]' ($B.Length + 1)
  $cur = New-Object 'int[]' ($B.Length + 1)
  for ($i = 1; $i -le $A.Length; $i++) {
    for ($j = 1; $j -le $B.Length; $j++) {
      if ($A[$i - 1] -eq $B[$j - 1]) { $cur[$j] = $prev[$j - 1] + 1 } else { $cur[$j] = [Math]::Max($prev[$j], $cur[$j - 1]) }
    }
    $swap = $prev; $prev = $cur; $cur = $swap
    for ($j = 0; $j -le $B.Length; $j++) { $cur[$j] = 0 }
  }
  return $prev[$B.Length]
}

# 0..1 similarity that tolerates OCR mistakes but still separates similar names:
# two store groups sharing a long prefix and suffix only score ~0.7, so a wrong but
# similarly named chat can not pass as the target.

function Get-WxNameScore {
  param([string]$A, [string]$B)
  $na = ConvertTo-WxName $A
  $nb = ConvertTo-WxName $B
  if ($na.Length -eq 0 -or $nb.Length -eq 0) { return 0.0 }
  if ($na -eq $nb) { return 1.0 }
  $lcs = Get-WxLcsLength $na $nb
  return (2.0 * $lcs) / ($na.Length + $nb.Length)
}

# WeChat renders an unread counter right after the chat title ("... (12)"), which
# OCR folds into trailing digits - drop them when that leaves a usable name.
function ConvertTo-WxNameWithoutTrailingDigits {
  param([string]$Text)
  $n = ConvertTo-WxName $Text
  $i = $n.Length
  while ($i -gt 0 -and $n[$i - 1] -ge '0' -and $n[$i - 1] -le '9') { $i-- }
  if ($i -ge 4 -and $i -lt $n.Length) { return $n.Substring(0, $i) }
  return $n
}

# Which known session does this text look like?
function Select-WxBestName {
  param([string]$Text, [AllowEmptyCollection()][string[]]$Names = @())
  $best = ''
  $bestScore = 0.0
  foreach ($n in @($Names)) {
    if ([string]::IsNullOrWhiteSpace($n)) { continue }
    $s = Get-WxNameScore $Text $n
    if ($s -gt $bestScore) { $bestScore = $s; $best = $n }
  }
  return [pscustomobject]@{ name = $best; score = $bestScore }
}

# ------------------------------------------------------- dynamic layout anchors

<#
  Locate the search box from an OCR of the window taken BEFORE anything is clicked.
  WeChat's search field carries no readable placeholder (it renders as a magnifier glyph
  plus "..." and OCR comes back with junk like "Q ,"), so the anchor is structural:

    top band of the window (title bar + search row)
      - right of the icon rail
      - left of the conversation pane (its header text is the rightmost top-band run)
      - a short text run
    => the leftmost such run is the search box.

  This replaces the hardcoded (+130, +52) offset, which silently stops being true when
  the window layout moves. Returns the line (window coordinates) or $null.
#>
function Find-WxSearchBoxLine {
  param(
    [AllowEmptyCollection()][object[]]$Lines = @(),
    [int]$WinW = 0,
    [int]$WinH = 0
  )
  if ($WinW -le 40 -or $WinH -le 40) { return $null }
  # Only the title-bar band: the search box lives there, the first session-list row does
  # not (it is ~40px lower and would otherwise be a candidate).
  $bandMaxY = [Math]::Max(70, [int]($WinH * 0.10))
  $minX = [Math]::Max(40, [int]($WinW * 0.05))
  $maxX = [int]($WinW * 0.55)
  $best = $null
  foreach ($l in @($Lines)) {
    if ($l.y -gt $bandMaxY -or $l.x -lt $minX -or $l.x -gt $maxX) { continue }
    if ($l.h -gt 40) { continue }                       # a solid block, not a text run
    $len = (ConvertTo-WxName $l.text).Length
    if ($len -gt 8) { continue }                        # the field holds only icon + placeholder
    if ($null -eq $best) { $best = $l; continue }
    # same row band -> keep the leftmost; clearly higher row -> take that one
    if ($l.y -lt ($best.y - 6) -or (($l.y -le ($best.y + 6)) -and ($l.x -lt $best.x))) { $best = $l }
  }
  return $best
}

<#
  Left edge of the conversation pane, taken from the chat title in the top band (the
  rightmost text run up there that is not a single glyph). Used to bound the composer
  band instead of a width percentage.
#>
function Find-WxPaneLeft {
  param(
    [AllowEmptyCollection()][object[]]$Lines = @(),
    [int]$WinW = 0,
    [int]$WinH = 0
  )
  if ($WinW -le 40 -or $WinH -le 40) { return 0 }
  $bandMaxY = [Math]::Max(70, [int]($WinH * 0.10))   # title bar only, same reason as above
  $best = $null
  foreach ($l in @($Lines)) {
    if ($l.y -gt $bandMaxY) { continue }
    if ((ConvertTo-WxName $l.text).Length -lt 2) { continue }
    if ($null -eq $best -or $l.x -gt $best.x) { $best = $l }
  }
  if ($null -eq $best) { return 0 }
  return [int]$best.x
}

# Is the message we are about to send really sitting in the chat input? Scanned over the
# bottom band of the right pane (the composer sits there; the send button and its toolbar
# are noise that will not match). This is the last gate before Enter: pressing Enter on an
# empty or wrong input is either a silent no-send or, worse, sends whatever was left there.
function Test-WxComposerHasBody {
  param(
    [AllowEmptyCollection()][object[]]$Lines = @(),
    [string]$Text = '',
    [int]$WinW = 0,
    [int]$WinH = 0,
    [int]$PaneLeft = 0
  )
  if ($WinH -le 0 -or [string]::IsNullOrWhiteSpace($Text)) { return $false }
  # Prefer the pane edge read off the conversation title; fall back to a width share.
  $minX = $PaneLeft
  if ($minX -le 0) { $minX = [Math]::Max(300, [int]($WinW * 0.40)) }
  $minY = $WinH - 160
  foreach ($l in @($Lines)) {
    if ($l.x -lt $minX -or $l.y -lt $minY) { continue }
    if (Test-WxTextLanded -Text $l.text -Target $Text) { return $true }
  }
  return $false
}

# ---------------------------------------------------------------- human pace

# Slightly random timing. Every fixed interval is a fingerprint: a client driven by a
# script clicks and types on a metronome, a person does not. Ranges are deliberately
# modest - the goal is "not obviously mechanical", not "slow for the sake of it".
function Get-WxJitter {
  param([int]$Base, [int]$Spread)
  if ($Spread -le 0) { return $Base }
  return $Base + (Get-Random -Minimum (0 - $Spread) -Maximum ($Spread + 1))
}

# Pause between two human-ish actions, with a 1-in-8 chance of a longer "hesitation".
function Start-WxPause {
  param([int]$Base = 300, [int]$Spread = 150, [bool]$Hesitate = $true)
  $ms = Get-WxJitter -Base $Base -Spread $Spread
  if ($Hesitate -and (Get-Random -Minimum 1 -Maximum 9) -eq 1) {
    $ms = $ms + (Get-WxJitter -Base 450 -Spread 250)
  }
  if ($ms -lt 40) { $ms = 40 }
  Start-Sleep -Milliseconds $ms
}

# Is the search dropdown on screen at all? (its section headers are the tell)
# Used to retry the search when the box did not open, instead of blaming the target.
function Test-WxSearchDropdown {
  param([AllowEmptyCollection()][object[]]$Lines = @())
  foreach ($l in @($Lines)) {
    $t = ConvertTo-WxName $l.text
    if (($t -eq $script:WxLblGroup) -or ($t -eq $script:WxLblContact) -or
        ($t -eq $script:WxLblHistory) -or ($t -like ('*' + $script:WxLblSearchWeb + '*'))) {
      return $true
    }
  }
  return $false
}

# Did a piece of text we sent actually land in some UI field? OCR reads a field as the
# text plus whatever glyphs sit next to it (an icon, a caret, an unread badge), and a
# long body may only be partially visible, so: accept a prefix relationship first, and
# fall back to a tolerant similarity. Used for the search box and for the chat input
# read back before Enter.
function Test-WxTextLanded {
  param([string]$Text, [string]$Target)
  $t = ConvertTo-WxName $Text
  $n = ConvertTo-WxName $Target
  if ($n.Length -eq 0 -or $t.Length -lt 3) { return $false }
  # 1) the read line starts with the text we typed (icon/caret glyphs may lead it)
  $maxSkip = [Math]::Min(4, $t.Length - 3)
  for ($i = 0; $i -le $maxSkip; $i++) {
    $sub = $t.Substring($i)
    if ($sub.Length -ge 3 -and $n.StartsWith($sub)) { return $true }
  }
  # 2) containment either way. A long body makes the input box scroll, so OCR only sees a
  #    fragment of it (usually the tail) - that fragment is still proof the text landed,
  #    and refusing here would abort a perfectly good send.
  if ($t.Length -ge 6 -and $n.Contains($t)) { return $true }
  if ($n.Length -ge 6 -and $t.Contains($n)) { return $true }
  # 3) last resort: tolerant similarity (OCR mistakes inside a short line)
  return ((Get-WxNameScore $Text $Target) -ge 0.5)
}

# Backwards-compatible alias (the search box is one caller of the same rule).
function Test-WxSearchBoxMatches {
  param([string]$Text, [string]$Target)
  return (Test-WxTextLanded -Text $Text -Target $Target)
}

<#
  A click point that is guaranteed to land on the WeChat window itself: clamped into the
  window rect, then verified with WindowFromPoint. Hardcoded layout offsets (title bar,
  search box) can fall outside a narrow or moved window - and then the click goes to
  whatever application happens to be there, which is exactly the kind of accident this
  tool must never have. Returns @(x, y) or $null (caller aborts instead of clicking blind).
#>
function Resolve-WxClickPoint {
  param([int[]]$Rect, [int]$X, [int]$Y, [int]$OwnerPid, [int]$Margin = 8)
  if ($null -eq $Rect -or $Rect.Count -lt 4) { return $null }
  $left = $Rect[0]; $top = $Rect[1]; $w = $Rect[2]; $h = $Rect[3]
  if ($w -le (2 * $Margin) -or $h -le (2 * $Margin)) { return $null }
  $cx = [Math]::Min([Math]::Max($X, $left + $Margin), $left + $w - $Margin)
  $cy = [Math]::Min([Math]::Max($Y, $top + $Margin), $top + $h - $Margin)
  $want = 'pid=' + $OwnerPid + ' *'
  if ($OwnerPid -le 0 -or ([WxUi32]::At($cx, $cy) -like $want)) { return @($cx, $cy) }
  # requested point sits on another window: fall back to the middle of the title bar
  $bx = $left + [int]($w / 2)
  $by = $top + [Math]::Min(14, [Math]::Max(4, [int]($h / 40)))
  if ([WxUi32]::At($bx, $by) -like $want) { return @($bx, $by) }
  return $null
}

# ---------------------------------------------------------------- row / header

<#
  Pick the search-dropdown row to click.
  Returns { x, y, w, h, text, score, section } (window coordinates) or $null.

  Which block a row belongs to is decided by the closest section header ABOVE it:
    web     -> the "search the web" + query-suggestion block: never a chat, never click
    group   -> group-chat hits (and, when a chat is already open, the "frequently used"
               block mixed in - both are real session rows)
    contact -> contact hits
    common  -> "frequently used": real session rows, either kind
  The row text also has to score >= MinScore against the target and be close to its
  length, so a row that merely CONTAINS the name is not mistaken for it.
#>
function Select-WxSearchRow {
  param(
    [AllowEmptyCollection()][object[]]$Lines = @(),
    [string]$Target = '',
    [bool]$IsGroup = $true,
    [double]$MinScore = 0.8
  )
  $nt = ConvertTo-WxName $Target
  if ($nt.Length -eq 0) { return $null }

  $headers = New-Object System.Collections.ArrayList
  foreach ($l in @($Lines)) {
    $t = ConvertTo-WxName $l.text
    $kind = ''
    if ($t -like ('*' + $script:WxLblSearchWeb + '*')) { $kind = 'web' }
    elseif ($t -eq $script:WxLblGroup) { $kind = 'group' }
    elseif ($t -eq $script:WxLblContact) { $kind = 'contact' }
    elseif ($t -eq $script:WxLblHistory) { $kind = 'history' }
    elseif ($script:WxLblCommonForms -contains $t) { $kind = 'common' }
    if ($kind -ne '') { [void]$headers.Add([pscustomobject]@{ y = [int]$l.y; kind = $kind }) }
  }
  if ($headers.Count -eq 0) { return $null }   # no search dropdown on screen -> refuse

  $bestScore = 0.0
  $cands = New-Object System.Collections.ArrayList
  foreach ($l in @($Lines)) {
    $nt2 = ConvertTo-WxName $l.text
    if ([Math]::Abs($nt2.Length - $nt.Length) -gt 3) { continue }
    $s = Get-WxNameScore $l.text $Target
    if ($s -lt $MinScore) { continue }

    $kind = ''
    $hy = -1
    foreach ($h in $headers) {
      if ($h.y -lt $l.y -and $h.y -gt $hy) { $hy = $h.y; $kind = $h.kind }
    }
    if ($hy -lt 0) { continue }                            # the search box itself
    if ($kind -eq 'web') { continue }                      # suggestion, not a chat
    if ($IsGroup -and $kind -eq 'contact') { continue }
    if ((-not $IsGroup) -and $kind -eq 'group') { continue }

    [void]$cands.Add([pscustomobject]@{ line = $l; score = $s; kind = $kind })
    if ($s -gt $bestScore) { $bestScore = $s }
  }
  if ($cands.Count -eq 0) { return $null }

  # best score wins; ties (the same name is also listed in the session list under the
  # open dropdown) resolve to the topmost row, which is the dropdown one.
  $top = $null
  foreach ($c in $cands) {
    if ($c.score -lt ($bestScore - 0.05)) { continue }
    if ($null -eq $top -or $c.line.y -lt $top.line.y) { $top = $c }
  }
  return [pscustomobject]@{
    x = $top.line.x; y = $top.line.y; w = $top.line.w; h = $top.line.h
    text = $top.line.text; score = $top.score; section = $top.kind
  }
}

<#
  Read the conversation header strip (top of the right pane) and answer two things:
  how close it is to the target, and which known session it looks like most.
  Callers accept only when direct >= 0.6 AND direct is not beaten by another name -
  that is what turns a similar-but-different group into a refusal.
#>
function Get-WxHeaderMatch {
  param(
    [AllowEmptyCollection()][object[]]$Lines = @(),
    [string]$Target = '',
    [AllowEmptyCollection()][string[]]$Names = @(),
    [int]$MaxY = 110,
    [int]$MinX = 300
  )
  $strip = New-Object System.Collections.ArrayList
  foreach ($l in @($Lines)) {
    if ($l.y -gt $MaxY -or $l.x -lt $MinX) { continue }
    if ((ConvertTo-WxName $l.text).Length -lt 2) { continue }   # icon / badge noise
    [void]$strip.Add($l)
  }
  $direct = 0.0
  $directText = ''
  $bestName = ''
  $bestScore = 0.0
  foreach ($l in $strip) {
    $d = Get-WxNameScore $l.text $Target
    $d2 = Get-WxNameScore (ConvertTo-WxNameWithoutTrailingDigits $l.text) $Target
    if ($d2 -gt $d) { $d = $d2 }
    if ($d -gt $direct) { $direct = $d; $directText = $l.text }
    $b = Select-WxBestName -Text $l.text -Names $Names
    if ($b.score -gt $bestScore) { $bestScore = $b.score; $bestName = $b.name }
  }
  $joined = (($strip | Sort-Object y, x | ForEach-Object { $_.text }) -join '')
  return [pscustomobject]@{
    direct = $direct; directText = $directText; bestName = $bestName; bestScore = $bestScore; text = $joined
  }
}

# ---------------------------------------------------------------- screen + OCR

function Initialize-WxOcr {
  if ($null -ne $script:WxOcrEngine) { return $true }
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
    $script:WxOcrAsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
    })[0]
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null

    $lang = $null
    foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
      if ($l.LanguageTag -like 'zh*') { $lang = $l; break }
    }
    if ($null -ne $lang) { $script:WxOcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang) }
    if ($null -eq $script:WxOcrEngine) {
      $script:WxOcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    return ($null -ne $script:WxOcrEngine)
  } catch {
    return $false
  }
}

function Invoke-WxAwait {
  param($Operation, [Type]$ResultType)
  $asTask = $script:WxOcrAsTask.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($Operation))
  $netTask.Wait(-1) | Out-Null
  return $netTask.Result
}

<#
  Grab the window into a PNG. Windows OCR needs reasonably large glyphs, so the
  capture is upscaled (2x by default) and the returned line boxes are scaled back.
  Returns { path, rect, scale } or $null.
#>
function Get-WxWindowShot {
  param([int64]$Hwnd, [string]$OutPath, [int]$Scale = 2)
  Add-Type -AssemblyName System.Drawing | Out-Null
  $rc = [WxUi32]::Rect([IntPtr]$Hwnd)
  if ($rc[2] -le 0 -or $rc[3] -le 0) { return $null }
  $bmp = New-Object System.Drawing.Bitmap($rc[2], $rc[3])
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($rc[0], $rc[1], 0, 0, (New-Object System.Drawing.Size($rc[2], $rc[3])))
  $g.Dispose()
  try {
    if ($Scale -gt 1) {
      $up = New-Object System.Drawing.Bitmap(($rc[2] * $Scale), ($rc[3] * $Scale))
      $g2 = [System.Drawing.Graphics]::FromImage($up)
      $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g2.DrawImage($bmp, 0, 0, ($rc[2] * $Scale), ($rc[3] * $Scale))
      $g2.Dispose()
      $bmp.Dispose()
      $bmp = $up
    }
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bmp.Dispose()
  }
  return @{ path = $OutPath; rect = $rc; scale = $Scale }
}

# OCR a shot taken by Get-WxWindowShot -> list of { text, x, y, w, h } in window px
function Get-WxOcrLines {
  param([string]$Path, [int]$Scale = 2)
  if (-not (Initialize-WxOcr)) { return $null }
  $file = Invoke-WxAwait ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream = Invoke-WxAwait ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Invoke-WxAwait ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp = Invoke-WxAwait ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Invoke-WxAwait ($script:WxOcrEngine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  } finally {
    $stream.Dispose()
  }
  $out = New-Object System.Collections.ArrayList
  foreach ($line in $res.Lines) {
    $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = [double]::MinValue; $maxY = [double]::MinValue
    foreach ($wd in $line.Words) {
      $r = $wd.BoundingRect
      if ($r.X -lt $minX) { $minX = $r.X }
      if ($r.Y -lt $minY) { $minY = $r.Y }
      if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
      if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
    }
    [void]$out.Add([pscustomobject]@{
      text = $line.Text
      x = [int]($minX / $Scale); y = [int]($minY / $Scale)
      w = [int](($maxX - $minX) / $Scale); h = [int](($maxY - $minY) / $Scale)
    })
  }
  return ,$out
}

# Real mouse click at screen coordinates, done the way a hand does it: the pointer
# travels in several short hops with a little jitter, settles for a moment before the
# button goes down, stays down for a human-ish time, and finally drifts back to where
# it started. A teleporting cursor that clicks in the same millisecond is the one thing
# an onlooker (or a screen recording) notices immediately.
function Invoke-WxClick {
  param([int]$X, [int]$Y, [bool]$RestoreCursor = $true, [switch]$Instant)
  $from = [WxUi32]::Cursor()
  if ($Instant) {
    [void][WxUi32]::SetCursorPos($X, $Y)
  } else {
    $steps = Get-Random -Minimum 6 -Maximum 13
    for ($i = 1; $i -le $steps; $i++) {
      $t = $i / [double]$steps
      $nx = [int]($from[0] + ($X - $from[0]) * $t) + (Get-Random -Minimum -3 -Maximum 4)
      $ny = [int]($from[1] + ($Y - $from[1]) * $t) + (Get-Random -Minimum -3 -Maximum 4)
      [void][WxUi32]::SetCursorPos($nx, $ny)
      Start-Sleep -Milliseconds (Get-WxJitter -Base 12 -Spread 7)
    }
    [void][WxUi32]::SetCursorPos($X, $Y)
  }
  Start-Sleep -Milliseconds (Get-WxJitter -Base 95 -Spread 55)
  [WxUi32]::Down()
  Start-Sleep -Milliseconds (Get-WxJitter -Base 55 -Spread 30)
  [WxUi32]::Up()
  if (-not $RestoreCursor) { return }
  Start-Sleep -Milliseconds (Get-WxJitter -Base 220 -Spread 120)
  $back = Get-Random -Minimum 4 -Maximum 8
  for ($i = 1; $i -le $back; $i++) {
    $t = $i / [double]$back
    [void][WxUi32]::SetCursorPos([int]($X + ($from[0] - $X) * $t), [int]($Y + ($from[1] - $Y) * $t))
    Start-Sleep -Milliseconds (Get-WxJitter -Base 10 -Spread 6)
  }
  [void][WxUi32]::SetCursorPos($from[0], $from[1])
}
