param(
  [string]$ManifestPath,
  [string]$DestinationDir
)

$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
  $ManifestPath = Join-Path $repoRoot 'receivers\runtime-manifest.json'
}

if ([string]::IsNullOrWhiteSpace($DestinationDir)) {
  $DestinationDir = Join-Path $repoRoot 'receivers\AirPlayServer'
}

$ManifestPath = [System.IO.Path]::GetFullPath($ManifestPath)
$DestinationDir = [System.IO.Path]::GetFullPath($DestinationDir)

if (-not (Test-Path $ManifestPath)) {
  throw "Runtime manifest not found: $ManifestPath"
}

$manifest = Get-Content -Raw $ManifestPath | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($manifest.url)) {
  throw "Runtime manifest is missing 'url'. Update $ManifestPath first."
}

if ([string]::IsNullOrWhiteSpace($manifest.sha256)) {
  throw "Runtime manifest is missing 'sha256'. Update $ManifestPath first."
}

$runtimeVersion = [string]$manifest.version
$downloadUrl = [string]$manifest.url
$expectedSha256 = ([string]$manifest.sha256).Trim().ToLowerInvariant()

if ($downloadUrl -match 'example\.com|<fill-me>|YOUR_') {
  throw "Runtime manifest still contains a placeholder URL. Update $ManifestPath with your real runtime release asset URL."
}

if ($expectedSha256 -match '^0+$|fill-me|your_') {
  throw "Runtime manifest still contains a placeholder sha256. Update $ManifestPath with the real archive checksum."
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("mirrorsim-runtime-" + [System.Guid]::NewGuid().ToString('N'))
$archivePath = Join-Path $tempRoot 'airplay-runtime.zip'
$extractRoot = Join-Path $tempRoot 'expanded'

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null

try {
  Write-Host "Downloading AirPlay runtime $runtimeVersion from $downloadUrl"
  Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath

  $actualSha256 = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) {
    throw "Runtime archive checksum mismatch. Expected $expectedSha256 but got $actualSha256"
  }

  Expand-Archive -Path $archivePath -DestinationPath $extractRoot -Force

  $rootEntries = Get-ChildItem -Path $extractRoot
  $sourceRoot = $extractRoot
  if ($rootEntries.Count -eq 1 -and $rootEntries[0].PSIsContainer) {
    $sourceRoot = $rootEntries[0].FullName
  }

  if (-not (Test-Path (Join-Path $sourceRoot 'MirrorSimAdapter.exe'))) {
    throw "Downloaded runtime bundle does not contain MirrorSimAdapter.exe at its root."
  }

  & (Join-Path $repoRoot 'scripts\sync-airplay-runtime.ps1') -SourceDir $sourceRoot -DestinationDir $DestinationDir
  if (-not $?) {
    throw "sync-airplay-runtime.ps1 failed. See the output above for details."
  }

  Write-Host "Fetched AirPlay runtime $runtimeVersion into $DestinationDir"
}
finally {
  if (Test-Path $tempRoot) {
    Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue
  }
}