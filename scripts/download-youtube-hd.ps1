param(
  [Parameter(Mandatory = $true)]
  [string] $Url,

  [string] $OutputDir = "artifacts/youtube-hd",
  [string] $Format = "137+140/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bestvideo[height<=1080]+bestaudio"
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$python = Join-Path $root ".venv/Scripts/python.exe"
if (!(Test-Path $python)) {
  $python = "python"
}

$helper = Join-Path $PSScriptRoot "local-youtube-helper.py"
$ffmpeg = & $python -c "import importlib.util; spec=importlib.util.spec_from_file_location('fcdl_helper', r'$helper'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); print(m._ffmpeg_path())"
if (!$ffmpeg -or !(Test-Path $ffmpeg)) {
  throw "ffmpeg could not be resolved"
}

$out = Join-Path $root $OutputDir
New-Item -ItemType Directory -Force -Path $out | Out-Null

& $python -m yt_dlp `
  -f $Format `
  --merge-output-format mp4 `
  --js-runtimes node `
  --remote-components ejs:github `
  --ffmpeg-location $ffmpeg `
  -o (Join-Path $out "%(id)s-%(height)sp.%(ext)s") `
  $Url
