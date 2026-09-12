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
using System.Runtime.InteropServices;
public class WxUi32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static int[] Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return new int[] { r.L, r.T, r.R - r.L, r.B - r.T }; }
  public static int[] Cursor() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
"@
}

# Screenshot pixels, GetWindowRect and SetCursorPos must share one coordinate space
# (physical pixels) or the click lands somewhere else on a scaled display.
try { [void][WxUi32]::SetProcessDPIAware() } catch { }

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

# Does the search box actually hold the name we typed? WeChat keeps the previous
# query in its search box, so a paste that did not land would silently search the old
# text (and open the wrong chat). The magnifier glyph makes the read text start with a
# junk character, hence the small prefix skip.
function Test-WxSearchBoxMatches {
  param([string]$Text, [string]$Target)
  $t = ConvertTo-WxName $Text
  $n = ConvertTo-WxName $Target
  if ($n.Length -eq 0 -or $t.Length -lt 3) { return $false }
  $maxSkip = [Math]::Min(4, $t.Length - 3)
  for ($i = 0; $i -le $maxSkip; $i++) {
    $sub = $t.Substring($i)
    if ($sub.Length -ge 3 -and $n.StartsWith($sub)) { return $true }
  }
  return ((Get-WxNameScore $Text $Target) -ge 0.5)
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

# Real mouse click at screen coordinates; the pointer is put back afterwards so the
# user's cursor does not stay parked on the WeChat window.
function Invoke-WxClick {
  param([int]$X, [int]$Y, [bool]$RestoreCursor = $true)
  $saved = $null
  if ($RestoreCursor) { $saved = [WxUi32]::Cursor() }
  [WxUi32]::Click($X, $Y)
  if ($RestoreCursor -and $null -ne $saved) {
    Start-Sleep -Milliseconds 80
    [void][WxUi32]::SetCursorPos($saved[0], $saved[1])
  }
}
