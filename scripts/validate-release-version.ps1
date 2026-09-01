param(
  [string]$ExpectedTag
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

$packageVersion = [string]((Get-Content -Raw (Join-Path $repoRoot 'package.json') | ConvertFrom-Json).version)
$tauriVersion = [string]((Get-Content -Raw (Join-Path $repoRoot 'src-tauri\tauri.conf.json') | ConvertFrom-Json).version)
$cargoText = Get-Content -Raw (Join-Path $repoRoot 'src-tauri\Cargo.toml')
$cargoMatch = [regex]::Match($cargoText, '(?m)^version\s*=\s*"([^"]+)"')

if (-not $cargoMatch.Success) {
  throw 'Could not read the package version from src-tauri/Cargo.toml.'
}

$cargoVersion = $cargoMatch.Groups[1].Value
$versions = @($packageVersion, $tauriVersion, $cargoVersion) | Select-Object -Unique
if ($versions.Count -ne 1) {
  throw "Release versions disagree: package.json=$packageVersion, tauri.conf.json=$tauriVersion, Cargo.toml=$cargoVersion"
}

if (-not [string]::IsNullOrWhiteSpace($ExpectedTag) -and $ExpectedTag -ne "v$packageVersion") {
  throw "Release tag '$ExpectedTag' does not match source version 'v$packageVersion'."
}

Write-Host "Release version validated: $packageVersion"
