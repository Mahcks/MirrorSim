param(
  [Parameter(Mandatory = $true)]
  [string]$Repository,

  [Parameter(Mandatory = $true)]
  [string]$Tag
)

$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packageJson = Get-Content -Raw (Join-Path $repoRoot 'package.json') | ConvertFrom-Json
$version = $packageJson.version

$nsisDir = Join-Path $repoRoot 'src-tauri\target\release\bundle\nsis'
$releaseRoot = Join-Path $repoRoot 'release'
$manifestPath = Join-Path $releaseRoot 'latest.json'

if (-not (Test-Path $nsisDir)) {
  throw "NSIS bundle directory not found: $nsisDir"
}

$installer = Get-ChildItem -Path $nsisDir -File -Filter '*.exe' |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1

if (-not $installer) {
  throw "Could not find an NSIS updater installer under $nsisDir"
}

$signaturePath = "$($installer.FullName).sig"
if (-not (Test-Path $signaturePath)) {
  throw "Updater signature file not found: $signaturePath"
}

$signature = (Get-Content -Raw $signaturePath).Trim()
if ([string]::IsNullOrWhiteSpace($signature)) {
  throw "Updater signature file is empty: $signaturePath"
}

$releaseUrl = "https://github.com/$Repository/releases/download/$Tag/$($installer.Name)"
$manifest = [ordered]@{
  version = $version
  notes = "See the GitHub Release notes for this MirrorSim build."
  pub_date = (Get-Date).ToUniversalTime().ToString('o')
  platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
      signature = $signature
      url = $releaseUrl
    }
  }
}

New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding utf8

Write-Host "Updater manifest created: $manifestPath"