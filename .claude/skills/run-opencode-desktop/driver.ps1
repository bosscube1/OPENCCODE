<#
driver.ps1 - launch and drive the OpenCode Desktop dev app on Windows.

Agent-facing harness for the run-opencode-desktop skill. Everything here was
run against the real app; see SKILL.md for the command reference.

  .\.claude\skills\run-opencode-desktop\driver.ps1 start
  .\.claude\skills\run-opencode-desktop\driver.ps1 shot -Out shot.png
  .\.claude\skills\run-opencode-desktop\driver.ps1 status
  .\.claude\skills\run-opencode-desktop\driver.ps1 stop

Why a custom driver and not Playwright: this repo has no Playwright dependency
and the app is a native-window Electron build with a preload contextBridge -
loading http://127.0.0.1:5173 in a plain browser gives a renderer with no
window.api, so it never gets past the boot screen. The real window is the only
surface that exercises the app, hence Win32 window capture.
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'shot', 'status', 'focus', 'release')]
  [string]$Command = 'status',

  # shot: destination PNG path.
  [string]$Out = 'app.png',

  # shot: leave the window topmost afterwards (default is to release it, so the
  # user's other windows are not permanently covered).
  [switch]$KeepTop,

  # start: seconds to wait for the renderer to attach before giving up.
  [int]$TimeoutSec = 90
)

$ErrorActionPreference = 'Stop'

# ELECTRON_RUN_AS_NODE makes electron.exe behave as plain Node - no app
# context, no 'electron' API - and the dev window never appears. This shell
# had it set globally; strip it so Start-Process children never inherit it.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$LogDir = Join-Path $env:TEMP 'opencode-desktop-run'
$OutLog = Join-Path $LogDir 'dev.out.log'
$ErrLog = Join-Path $LogDir 'dev.err.log'
$WindowTitle = '*OpenCode Desktop*'

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class OcWin {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$HWND_TOPMOST = [IntPtr]::new(-1)
$HWND_NOTOPMOST = [IntPtr]::new(-2)
$SWP_NOMOVESIZE = 0x0001 -bor 0x0002
$SW_MAXIMIZE = 3

function Get-DevWindow {
  Get-Process electron -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -like $WindowTitle } |
    Select-Object -First 1
}

function Get-DevProcesses {
  # electron-vite spawns: node (vite) -> electron (main) -> electron helpers,
  # and the main process spawns `opencode serve`. Match on command line so a
  # user's OTHER electron apps are never touched.
  $procs = @()
  $procs += Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*electron-vite*' }
  $procs += Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.CommandLine -like "*$($RepoRoot -replace '\\', '\\')*" -or $_.ExecutablePath -like "$RepoRoot\node_modules\electron\dist\electron.exe" }
  $procs += Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" |
    Where-Object { $_.CommandLine -like '*serve*' }
  $procs
}

function Invoke-Stop {
  $procs = Get-DevProcesses
  if (-not $procs) { return 'nothing running' }
  $ids = $procs | Select-Object -ExpandProperty ProcessId -Unique
  Stop-Process -Id $ids -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  "stopped: $($ids -join ', ')"
}

function Invoke-Start {
  # A stale instance is the single most common failure: it holds port 5173 AND
  # the Electron single-instance lock, so a second `npm run dev` prints
  # "starting electron app..." and then silently exits, leaving the OLD window
  # (old code) on screen. Always clear first.
  Invoke-Stop | Out-Null

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Remove-Item $OutLog, $ErrLog -ErrorAction SilentlyContinue

  Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'dev' `
    -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog `
    -WindowStyle Hidden | Out-Null

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (-not (Test-Path $OutLog)) { continue }
    $log = Get-Content $OutLog -Raw
    # "[Renderer Console] [vite] connected." is the real ready signal - the
    # earlier "starting electron app..." line prints before the window exists.
    if ($log -match '\[vite\] connected') { break }
  }

  $win = Get-DevWindow
  if (-not $win) {
    throw "dev window never appeared. Logs: $OutLog / $ErrLog"
  }
  "started (pid $($win.Id)) - logs: $OutLog"
}

function Invoke-Focus {
  $win = Get-DevWindow
  if (-not $win) { throw 'dev window not found - run `driver.ps1 start` first' }
  $h = $win.MainWindowHandle
  # SetForegroundWindow alone loses to whatever app currently owns focus
  # (the agent's own terminal/chat window). TOPMOST is what actually raises it.
  [OcWin]::ShowWindow($h, $SW_MAXIMIZE) | Out-Null
  [OcWin]::SetWindowPos($h, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOMOVESIZE) | Out-Null
  [OcWin]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 1200
  "focused (pid $($win.Id))"
}

function Invoke-Release {
  $win = Get-DevWindow
  if (-not $win) { return 'dev window not found' }
  [OcWin]::SetWindowPos($win.MainWindowHandle, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP_NOMOVESIZE) | Out-Null
  'released topmost'
}

function Invoke-Shot {
  Invoke-Focus | Out-Null
  $win = Get-DevWindow
  $r = New-Object OcWin+RECT
  [OcWin]::GetWindowRect($win.MainWindowHandle, [ref]$r) | Out-Null

  # A maximized window's rect overhangs the screen by the border width; clamp
  # so Bitmap gets a valid origin.
  $x = [Math]::Max($r.L, 0); $y = [Math]::Max($r.T, 0)
  $w = $r.R - $x; $h = $r.B - $y

  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  if (-not [System.IO.Path]::IsPathRooted($Out)) { $Out = Join-Path (Get-Location) $Out }
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()

  if (-not $KeepTop) { Invoke-Release | Out-Null }
  "saved $Out ($w x $h)"
}

function Invoke-Status {
  $win = Get-DevWindow
  if ($win) { "window: pid $($win.Id) - $($win.MainWindowTitle)" } else { 'window: NOT RUNNING' }

  $procs = Get-DevProcesses
  if ($procs) {
    'processes:'
    $procs | ForEach-Object { "  $($_.ProcessId)`t$($_.Name)" }
  }

  $oc = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -in ($procs | Select-Object -ExpandProperty ProcessId) }
  if ($oc) {
    'listening:'
    $oc | ForEach-Object { "  127.0.0.1:$($_.LocalPort) (pid $($_.OwningProcess))" }
  }

  if (Test-Path $OutLog) { 'log tail:'; Get-Content $OutLog -Tail 6 | ForEach-Object { "  $_" } }
  if ((Test-Path $ErrLog) -and (Get-Item $ErrLog).Length -gt 0) {
    'stderr tail:'; Get-Content $ErrLog -Tail 6 | ForEach-Object { "  $_" }
  }
}

switch ($Command) {
  'start'   { Invoke-Start }
  'stop'    { Invoke-Stop }
  'shot'    { Invoke-Shot }
  'status'  { Invoke-Status }
  'focus'   { Invoke-Focus }
  'release' { Invoke-Release }
}
