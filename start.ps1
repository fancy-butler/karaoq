# KARAO-Q launcher — Windows. Double-click start.bat the first time; after that use the KARAO-Q
# shortcut it puts on your Desktop and Start menu (no console window).
# Close the TV screen (Alt+F4) and everything shuts down.
param([switch]$Gui)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not $env:PORT) { $env:PORT = '8080' }
$port = $env:PORT
New-Item -ItemType Directory -Force -Path data | Out-Null
if ($Gui) { Start-Transcript -Path (Join-Path $PSScriptRoot 'data\karaoq.log') -Append | Out-Null }

function Say($msg, [switch]$Err) {
  Write-Host $msg
  if ($Gui) {
    Add-Type -AssemblyName System.Windows.Forms
    $icon = if ($Err) { 'Error' } else { 'Information' }
    [System.Windows.Forms.MessageBox]::Show($msg, 'KARAO-Q', 'OK', $icon) | Out-Null
  }
}

# ---------- requirements ----------
$missing = @()
function Need($cmd, $hint) { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Write-Host "X Missing: $cmd -- $hint" -ForegroundColor Red; $script:missing += $cmd } }
Need node   'winget install OpenJS.NodeJS.LTS'
Need yt-dlp 'winget install yt-dlp.yt-dlp'
Need ffmpeg 'winget install Gyan.FFmpeg'
if (-not (Get-Command deno -ErrorAction SilentlyContinue)) { Write-Host '! deno not found -- recent yt-dlp needs it for YouTube: winget install DenoLand.Deno' -ForegroundColor Yellow }
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) { Write-Host '- Optional: winget install Cloudflare.cloudflared  (for the "Can''t connect?" internet QR)' }
if ($missing.Count) {
  Say ("Can't start - missing: " + ($missing -join ', ') + "`n`nIn PowerShell run:`nwinget install OpenJS.NodeJS.LTS yt-dlp.yt-dlp Gyan.FFmpeg DenoLand.Deno`n`nthen start KARAO-Q again.") -Err
  if (-not $Gui) { Read-Host 'Press Enter to close' }
  exit 1
}

if (-not (Test-Path node_modules)) { npm install --omit=dev --no-audit --no-fund }

# ---------- one-time: Desktop + Start menu shortcuts (no console window) ----------
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'KARAO-Q.lnk'
if (-not (Test-Path $startMenu)) {
  $ws = New-Object -ComObject WScript.Shell
  foreach ($lnkPath in @($startMenu, (Join-Path ([Environment]::GetFolderPath('Desktop')) 'KARAO-Q.lnk'))) {
    $lnk = $ws.CreateShortcut($lnkPath)
    $lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSScriptRoot\start.ps1`" -Gui"
    $lnk.WorkingDirectory = $PSScriptRoot
    $lnk.IconLocation = "$PSScriptRoot\assets\icon.ico"
    $lnk.Description = 'YouTube karaoke with a shared queue from everyone''s phones'
    $lnk.Save()
  }
  Write-Host 'Added KARAO-Q to your Desktop and Start menu' -ForegroundColor Green
}

try { yt-dlp -U | Out-Null } catch {}

# ---------- browser ----------
$url = "http://localhost:$port/stage"
function Open-Stage {
  $chromium = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($chromium) {
    $prof = Join-Path $PSScriptRoot 'data\chromium-profile'
    Start-Process $chromium -ArgumentList @('--kiosk', '--autoplay-policy=no-user-gesture-required', "--user-data-dir=`"$prof`"", '--no-first-run', '--noerrdialogs', '--disable-session-crashed-bubble', "--app=$url")
    return $true
  }
  $firefox = @("$env:ProgramFiles\Mozilla Firefox\firefox.exe", "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($firefox) {
    $prof = Join-Path $PSScriptRoot 'data\firefox-profile'
    New-Item -ItemType Directory -Force -Path $prof | Out-Null
    Set-Content -Path (Join-Path $prof 'user.js') -Value @(
      'user_pref("media.autoplay.default", 0);', 'user_pref("media.autoplay.blocking_policy", 0);',
      'user_pref("browser.shell.checkDefaultBrowser", false);', 'user_pref("browser.aboutwelcome.enabled", false);',
      'user_pref("browser.sessionstore.resume_from_crash", false);')
    Start-Process $firefox -ArgumentList @('-new-instance', '-no-remote', '-profile', "`"$prof`"", '-kiosk', $url)
    return $true
  }
  return $false
}

# Already running (shortcut clicked twice)? Just reopen the TV screen.
try { Invoke-WebRequest "http://localhost:$port/api/join" -UseBasicParsing -TimeoutSec 1 | Out-Null; Open-Stage | Out-Null; exit 0 } catch {}

# ---------- server ----------
$env:AUTO_EXIT = '1'
$server = Start-Process node -ArgumentList 'server.js' -PassThru -NoNewWindow
try {
  $ready = $false
  for ($i = 0; $i -lt 75; $i++) {
    if ($server.HasExited) { break }
    try { Invoke-WebRequest "http://localhost:$port/api/join" -UseBasicParsing -TimeoutSec 1 | Out-Null; $ready = $true; break } catch { Start-Sleep -Milliseconds 200 }
  }
  if (-not $ready) { Say "KARAO-Q's server didn't start. Details: $PSScriptRoot\data\karaoq.log" -Err; exit 1 }

  if (Open-Stage) {
    Write-Host 'TV screen open. Close it (Alt+F4) and everything shuts down ~10 s later.'
  } else {
    Say "No Chrome, Edge or Firefox found. Open $url in a browser and press F for fullscreen."
  }
  $server.WaitForExit()   # the server exits by itself once the TV screen is closed
} finally {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  if ($Gui) { Stop-Transcript | Out-Null }
}
