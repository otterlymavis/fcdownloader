$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$python = Join-Path $root ".venv/Scripts/python.exe"
if (!(Test-Path $python)) {
  $python = "python"
}

& $python -c "import imageio_ffmpeg" 2>$null
if ($LASTEXITCODE -ne 0) {
  & $python -m pip install imageio-ffmpeg
}

& $python (Join-Path $PSScriptRoot "local-youtube-helper.py")
