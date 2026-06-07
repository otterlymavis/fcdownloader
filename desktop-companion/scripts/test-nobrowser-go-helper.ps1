param(
  [string] $HelperExe = "$PSScriptRoot\..\build\nobrowser-go\FCDownloaderNativeHelper.exe",
  [string] $CacheDir = "$PSScriptRoot\..\..\artifacts\nobrowser-go-test-cache",
  [string] $OutDir = "$PSScriptRoot\..\..\artifacts\nobrowser-go-tests",
  [string] $SampleUrl = "https://samplelib.com/lib/preview/mp4/sample-5s.mp4",
  [string] $YouTubeUrl = $env:FCDL_YOUTUBE_TEST_URL
)

$ErrorActionPreference = "Stop"

function Invoke-Json($Uri, [int] $Retries = 2, [int] $MaxTime = 180) {
  $last = ""
  for ($attempt = 0; $attempt -le $Retries; $attempt += 1) {
    try {
      return Invoke-RestMethod -Uri $Uri -TimeoutSec $MaxTime
    } catch {
      $last = $_.Exception.Message
    }
    Start-Sleep -Seconds ([Math]::Min(5, $attempt + 1))
  }
  throw "request failed: $Uri $last"
}

function Stop-Port8765 {
  $connections = netstat -ano | Select-String ':8765.*LISTENING'
  $listenPids = @()
  foreach ($line in $connections) {
    $parts = ($line.ToString() -split '\s+') | Where-Object { $_ }
    if ($parts.Length -ge 5) { $listenPids += [int]$parts[-1] }
  }
  foreach ($listenPid in ($listenPids | Sort-Object -Unique)) {
    Stop-Process -Id $listenPid -Force
  }
}

function Start-HelperProcess {
  param(
    [hashtable] $ExtraEnv = @{}
  )
  if (!$ExtraEnv.ContainsKey("FCDL_HELPER_CACHE_DIR")) {
    $ExtraEnv["FCDL_HELPER_CACHE_DIR"] = (Resolve-Path $CacheDir).Path
  }
  $oldValues = @{}
  foreach ($entry in $ExtraEnv.GetEnumerator()) {
    $oldValues[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, "Process")
    [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, "Process")
  }
  $process = Start-Process -FilePath $HelperExe -PassThru -WindowStyle Hidden
  foreach ($entry in $ExtraEnv.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $oldValues[$entry.Key], "Process")
  }
  return $process
}

function Wait-Healthy {
  for ($i = 0; $i -lt 30; $i += 1) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-Json 'http://127.0.0.1:8765/health'
      if ($health.ok) { return $health }
    } catch {}
  }
  throw "helper did not become healthy"
}

if (!(Test-Path -LiteralPath $HelperExe)) {
  throw "helper exe not found: $HelperExe"
}

Stop-Port8765
Remove-Item -LiteralPath $CacheDir,$OutDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $CacheDir,$OutDir | Out-Null

$process = Start-HelperProcess

try {
  $health = Wait-Healthy
  if ($health.ytDlpVersion -ne "2026.03.17") { throw "unexpected yt-dlp pin: $($health.ytDlpVersion)" }
  if (!$health.tools -or $health.tools.Count -lt 2) { throw "health did not report tool status" }

  $bad = & curl.exe -sS -o NUL -w '%{http_code}' --max-time 10 'http://127.0.0.1:8765/youtube-hd?url=https%3A%2F%2Fexample.com%2Fvideo.mp4'
  if ($bad -ne "400") { throw "youtube-hd non-youtube guard returned $bad, expected 400" }

  $toolStatus = Invoke-Json 'http://127.0.0.1:8765/tools'
  if (!$toolStatus.ok -or !$toolStatus.tools -or $toolStatus.tools.Count -lt 2) { throw "tools status regression failed" }

  $ensured = Invoke-Json 'http://127.0.0.1:8765/tools/ensure' -Retries 3 -MaxTime 300
  if (!$ensured.ok -or !$ensured.tools -or ($ensured.tools | Where-Object { !$_.installed }).Count -ne 0) {
    throw "tools ensure regression failed"
  }

  if ($process -and !$process.HasExited) {
    Stop-Process -Id $process.Id -Force
    $process = $null
  }
  $process = Start-HelperProcess @{
    FCDL_YTDLP_URL = "http://127.0.0.1:9/missing-yt-dlp.exe"
    FCDL_FFMPEG_BASE_URL = "http://127.0.0.1:9"
  }
  $offlineHealth = Wait-Healthy
  $offlineEnsured = Invoke-Json 'http://127.0.0.1:8765/tools/ensure' -Retries 1 -MaxTime 60
  if (!$offlineHealth.ok -or !$offlineEnsured.ok) {
    throw "offline-after-cache regression failed"
  }

  $encoded = [Uri]::EscapeDataString($SampleUrl)
  $formats = Invoke-Json "http://127.0.0.1:8765/formats?url=$encoded"
  if (!$formats.ok -or !$formats.formats -or $formats.formats.Count -lt 1) { throw "formats regression failed" }

  $downloadPath = Join-Path $OutDir "sample.mp4"
  & curl.exe -L --fail --max-time 300 "http://127.0.0.1:8765/download?url=$encoded&max_height=360" -o $downloadPath
  if ($LASTEXITCODE -ne 0) { throw "sample download failed" }
  if ((Get-Item $downloadPath).Length -lt 1024) { throw "downloaded sample is too small" }

  $ytResult = "skipped"
  if ($YouTubeUrl) {
    $ytEncoded = [Uri]::EscapeDataString($YouTubeUrl)
    $ytFormats = Invoke-Json "http://127.0.0.1:8765/formats?url=$ytEncoded"
    if (!$ytFormats.ok -or !$ytFormats.formats -or $ytFormats.formats.Count -lt 1) {
      throw "YouTube formats regression failed"
    }
    $ytResult = "passed"
  }

  [PSCustomObject]@{
    ok = $true
    health = $health
    sampleDownload = (Resolve-Path $downloadPath).Path
    youtubeFormats = $ytResult
    cacheFiles = Get-ChildItem $CacheDir -Recurse -File | Select-Object FullName,Length
  } | ConvertTo-Json -Depth 6
} finally {
  if ($process -and !$process.HasExited) {
    Stop-Process -Id $process.Id -Force
  }
}
