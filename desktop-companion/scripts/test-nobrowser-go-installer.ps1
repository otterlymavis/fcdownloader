param(
  [string] $Installer = "$PSScriptRoot\..\dist-nobrowser-go-ver\FCDownloader Companion NoBrowser Go Setup 0.2.1.exe",
  [string] $InstallDir = "$PSScriptRoot\..\..\artifacts\nobrowser-go-install-smoke"
)

$ErrorActionPreference = "Stop"

function Stop-Port8765 {
  $connections = netstat -ano | Select-String ':8765.*LISTENING'
  foreach ($line in $connections) {
    $parts = ($line.ToString() -split '\s+') | Where-Object { $_ }
    if ($parts.Length -ge 5) { Stop-Process -Id ([int]$parts[-1]) -Force }
  }
}

function Wait-Health {
  for ($i = 0; $i -lt 40; $i += 1) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 3
      if ($health.ok) { return $health }
    } catch {}
  }
  throw "installed helper did not become healthy"
}

function Test-RunAtLoginValue {
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  if (!(Test-Path -LiteralPath $runKey)) { return $false }
  $value = Get-ItemProperty -LiteralPath $runKey -Name FCDownloaderCompanion -ErrorAction SilentlyContinue
  return $null -ne $value
}

if (!(Test-Path -LiteralPath $Installer)) {
  throw "installer not found: $Installer"
}

Stop-Port8765
Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null

$resolvedInstallDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir)
$installArgs = @('/S', "/D=$resolvedInstallDir")
$install = Start-Process -FilePath $Installer -ArgumentList $installArgs -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "installer exited with $($install.ExitCode)" }

$tray = Join-Path $resolvedInstallDir 'FCDownloaderCompanionTray.exe'
$uninstall = Join-Path $resolvedInstallDir 'Uninstall.exe'
$cacheDir = Join-Path (Split-Path $resolvedInstallDir) 'nobrowser-go-install-cache'
$startMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'FCDownloader'
$requiredShortcuts = @(
  'Start Companion.lnk',
  'Stop Companion.lnk',
  'Open Logs.lnk',
  'Uninstall.lnk'
)
if (!(Test-Path -LiteralPath $tray)) { throw "tray was not installed" }
if (!(Test-Path -LiteralPath $uninstall)) { throw "uninstaller was not installed" }
foreach ($shortcut in $requiredShortcuts) {
  $shortcutPath = Join-Path $startMenuDir $shortcut
  if (!(Test-Path -LiteralPath $shortcutPath)) { throw "missing Start Menu shortcut: $shortcut" }
}
if (Test-RunAtLoginValue) { throw "run-on-login registry value should be opt-in" }

$oldCache = $env:FCDL_HELPER_CACHE_DIR
$env:FCDL_HELPER_CACHE_DIR = $cacheDir
$process = Start-Process -FilePath $tray -PassThru -WindowStyle Hidden
$env:FCDL_HELPER_CACHE_DIR = $oldCache
try {
  $health = Wait-Health
  if ($health.version -ne '0.3.0-go') { throw "unexpected helper version: $($health.version)" }
} finally {
  if ($process -and !$process.HasExited) {
    Stop-Process -Id $process.Id -Force
  }
  Stop-Port8765
}

$remove = Start-Process -FilePath $uninstall -ArgumentList '/S' -Wait -PassThru
if ($remove.ExitCode -ne 0) { throw "uninstaller exited with $($remove.ExitCode)" }
foreach ($shortcut in $requiredShortcuts) {
  $shortcutPath = Join-Path $startMenuDir $shortcut
  if (Test-Path -LiteralPath $shortcutPath) { throw "shortcut remained after uninstall: $shortcut" }
}
if (Test-RunAtLoginValue) { throw "run-on-login registry value remained after uninstall" }

[PSCustomObject]@{
  ok = $true
  installedTo = $resolvedInstallDir
  trayExistsAfterUninstall = Test-Path -LiteralPath $tray
} | ConvertTo-Json -Depth 3
