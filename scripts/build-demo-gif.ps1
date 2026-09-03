param(
  [Parameter(Mandatory = $true)]
  [string]$InputFile,
  [string]$OutputFile,
  [double]$StartAtSeconds = 0,
  [double]$DurationSeconds = 14
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$inputPath = [System.IO.Path]::GetFullPath($InputFile)
if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) {
  throw "Demo recording does not exist: $inputPath"
}

if ([string]::IsNullOrWhiteSpace($OutputFile)) {
  $OutputFile = Join-Path $repoRoot 'docs\images\demo.gif'
}
$outputPath = [System.IO.Path]::GetFullPath($OutputFile)
$outputDirectory = Split-Path -Parent $outputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
  throw 'ffmpeg is required to build the README demo GIF.'
}

$filter = "fps=12,scale='min(900,iw)':-2:flags=lanczos,split[original][paletteSource];[paletteSource]palettegen=max_colors=128:stats_mode=diff[palette];[original][palette]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle"
& $ffmpeg.Source -hide_banner -loglevel error -y -ss $StartAtSeconds -t $DurationSeconds -i $inputPath -filter_complex $filter -loop 0 $outputPath
if ($LASTEXITCODE -ne 0) {
  throw "ffmpeg failed with exit code $LASTEXITCODE."
}

$output = Get-Item -LiteralPath $outputPath
if ($output.Length -gt 8MB) {
  Write-Warning "The demo GIF is $([math]::Round($output.Length / 1MB, 2)) MB. Trim the clip or reduce its duration before committing."
}

Write-Host "Created README demo GIF: $outputPath ($([math]::Round($output.Length / 1MB, 2)) MB)"
