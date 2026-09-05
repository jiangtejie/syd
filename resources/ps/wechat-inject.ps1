param(
  [string]$Action = 'focus',
  [string]$Keys = '',
  [string]$Target = '',
  [string]$Text = '',
  [string]$Path = '',
  [string]$FileKind = 'file'
)
$ErrorActionPreference = 'Stop'

# WeChat window injection script (T8)
# Action:
#   focus  -> find WeChat window and force foreground, output {ok, title}
#   isfocus-> check whether WeChat window is foreground, output {ok, focused}
#   keys   -> send key sequence (Keys comma separated: ctrl+f / ctrl+a / delete / ctrl+v / enter / esc / tab)
#   send   -> full injection: search session Target -> paste body Text -> Enter
#   sendfile -> search session Target -> put file/image into clipboard -> paste -> Enter
# Output: single-line JSON on stdout
# NOTE: keep this file ASCII-only (PS 5.1 parses no-BOM scripts as ANSI).

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(int a, int b, bool f);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@

Add-Type -AssemblyName System.Windows.Forms

$VK = @{
  'enter'  = 0x0D
  'delete' = 0x2E
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

# "WeChat" in Chinese (U+5FAE U+4FE1), built via code points to keep file ASCII
$weChatTitle = [string][char]0x5FAE + [char]0x4FE1

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

function Find-WeChatWindow {
  $procs = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like '*wechat*' -or $_.ProcessName -like '*weixin*') }
  foreach ($p in $procs) {
    if ($p.MainWindowTitle -like "*$weChatTitle*" -or $p.ProcessName -like 'weixin*') {
      return @{ hwnd = $p.MainWindowHandle; title = $p.MainWindowTitle; pid = $p.Id }
    }
  }
  # fallback: any visible window whose title contains "WeChat"
  $all = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$weChatTitle*" }
  foreach ($p in $all) {
    return @{ hwnd = $p.MainWindowHandle; title = $p.MainWindowTitle; pid = $p.Id }
  }
  return $null
}

function Focus-WeChatWindow([IntPtr]$hwnd) {
  if ([Win32]::IsIconic($hwnd)) { [void][Win32]::ShowWindow($hwnd, 9) }
  [void][Win32]::SetForegroundWindow($hwnd)
  # level 2: press ALT to earn foreground privilege
  KeyDown 0x12; KeyUp 0x12
  [void][Win32]::SetForegroundWindow($hwnd)
  # level 3: AttachThreadInput
  $cur = [Win32]::GetCurrentThreadId()
  $winThread = [Win32]::GetWindowThreadProcessId($hwnd, [ref]0)
  if ([Win32]::AttachThreadInput($cur, $winThread, $true)) {
    [void][Win32]::SetForegroundWindow($hwnd)
    [void][Win32]::AttachThreadInput($cur, $winThread, $false)
  }
  return ([Win32]::GetForegroundWindow() -eq $hwnd)
}

$out = @{ ok = $false }

try {
  $win = Find-WeChatWindow
  if ($null -eq $win) {
    $out.error = 'WeChat window not found (please login first)'
  } else {
    $hwnd = [IntPtr]$win.hwnd
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
    } elseif ($Action -eq 'send') {
      # full injection flow
      Focus-WeChatWindow $hwnd | Out-Null
      Start-Sleep -Milliseconds 150
      # open search -> clear -> paste session name -> enter
      Send-KeySeq 'ctrl+f'
      Start-Sleep -Milliseconds 400
      Send-KeySeq 'ctrl+a,delete'
      [System.Windows.Forms.Clipboard]::SetText($Target)
      Send-KeySeq 'ctrl+v'
      Start-Sleep -Milliseconds 800
      Send-KeySeq 'enter'
      Start-Sleep -Milliseconds 900
      # ensure WeChat still foreground before pasting body and sending
      if ([Win32]::GetForegroundWindow() -ne $hwnd) {
        $out = @{ ok = $false; error = 'Focus stolen, send cancelled' }
      } else {
        [System.Windows.Forms.Clipboard]::SetText($Text)
        Send-KeySeq 'ctrl+v'
        Start-Sleep -Milliseconds 400
        Send-KeySeq 'enter'
        $out = @{ ok = $true; title = $win.title; sent = $true }
      }
      } elseif ($Action -eq 'sendfile') {
      # send one file/image: search session -> put file into clipboard -> paste -> enter
      Focus-WeChatWindow $hwnd | Out-Null
      Start-Sleep -Milliseconds 150
      Send-KeySeq 'ctrl+f'
      Start-Sleep -Milliseconds 400
      Send-KeySeq 'ctrl+a,delete'
      [System.Windows.Forms.Clipboard]::SetText($Target)
      Send-KeySeq 'ctrl+v'
      Start-Sleep -Milliseconds 800
      Send-KeySeq 'enter'
      Start-Sleep -Milliseconds 900
      if ([Win32]::GetForegroundWindow() -ne $hwnd) {
        $out = @{ ok = $false; error = 'Focus stolen, send cancelled' }
      } elseif (-not (Test-Path -LiteralPath $Path)) {
        $out = @{ ok = $false; error = 'File not found: ' + $Path }
      } else {
        $ext = [System.IO.Path]::GetExtension($Path).ToLower()
        $pasteAsImage = ($FileKind -eq 'image') -and ($ext -in '.png', '.jpg', '.jpeg', '.bmp', '.gif')
        if ($pasteAsImage) {
          Add-Type -AssemblyName System.Drawing
          if (-not (Invoke-ClipboardWithRetry { Set-ImageFileClipboard $Path })) {
            $out = @{ ok = $false; error = 'Clipboard busy (image)' }
          }
        } else {
          if (-not (Invoke-ClipboardWithRetry { Set-FileDropClipboard $Path })) {
            $out = @{ ok = $false; error = 'Clipboard busy (file)' }
          }
        }
        if (-not $out.ok) {
          # nothing more to do
        } else {
          Send-KeySeq 'ctrl+v'
          Start-Sleep -Milliseconds ($(if ($pasteAsImage) { 1200 } else { 900 }))
          Send-KeySeq 'enter'
          $out = @{ ok = $true; title = $win.title; sent = $true; asImage = $pasteAsImage }
        }
      }
    } else {
      $out.error = "Unknown action: $Action"
    }
  }
} catch {
  $out = @{ ok = $false; error = $_.Exception.Message }
}

[Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
