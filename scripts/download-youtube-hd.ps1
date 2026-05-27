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

$ffmpeg = & python -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"
if (!$ffmpeg -or !(Test-Path $ffmpeg)) {
  throw "imageio-ffmpeg is not installed. Run: python -m pip install imageio-ffmpeg"
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
