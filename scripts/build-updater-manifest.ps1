param(
  [Parameter(Mandatory = $true)]
  [string]$Repository,

  [Parameter(Mandatory = $true)]
  [string]$Tag
)

$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
& (Join-Path $PSScriptRoot 'validate-release-version.ps1') -ExpectedTag $Tag
if (-not $?) {
  throw 'Release version validation failed.'
}
$packageJson = Get-Content -Raw (Join-Path $repoRoot 'package.json') | ConvertFrom-Json
$version = $packageJson.version
$bundleVersion = ($version -split '-')[0]

$nsisDir = Join-Path $repoRoot 'src-tauri\target\release\bundle\nsis'
$releaseRoot = Join-Path $repoRoot 'release'
$manifestPath = Join-Path $releaseRoot 'latest.json'

if (-not (Test-Path $nsisDir)) {
  throw "NSIS bundle directory not found: $nsisDir"
}

$installerCandidates = @(Get-ChildItem -Path $nsisDir -File -Filter "*$bundleVersion*.exe")

if ($installerCandidates.Count -ne 1) {
  $names = ($installerCandidates | ForEach-Object Name) -join ', '
  throw "Expected exactly one NSIS installer for version $bundleVersion under $nsisDir, found $($installerCandidates.Count): $names"
}

$installer = $installerCandidates[0]

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
$manifestJson = $manifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText(
  $manifestPath,
  $manifestJson,
  [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Updater manifest created: $manifestPath"
