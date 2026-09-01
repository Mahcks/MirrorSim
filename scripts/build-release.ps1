param(
  [ValidateSet('prep', 'installer', 'portable', 'all')]
  [string]$Target = 'all',
  [ValidateSet('sync', 'fetch')]
  [string]$RuntimeSource = 'sync'
)

$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRustToolchain = '1.88.0-x86_64-pc-windows-msvc'
$packageJsonPath = Join-Path $repoRoot 'package.json'
$packageJson = Get-Content -Raw $packageJsonPath | ConvertFrom-Json
$version = $packageJson.version
$productName = 'MirrorSim'

& (Join-Path $PSScriptRoot 'validate-release-version.ps1')
if (-not $?) {
  throw 'Release version validation failed.'
}

$releaseRoot = Join-Path $repoRoot 'release'
$portableRoot = Join-Path $releaseRoot 'portable'
$portableFolderName = "$productName-portable-v$version"
$portableFolder = Join-Path $portableRoot $portableFolderName
$portableZip = Join-Path $portableRoot ("$portableFolderName.zip")

$tauriManifest = Join-Path $repoRoot 'src-tauri\Cargo.toml'
$releaseTargetDir = Join-Path $repoRoot 'src-tauri\target\release'
$releaseSupportDir = Join-Path $repoRoot 'src-tauri\target\release\_up_'
$receiverBundle = Join-Path $repoRoot 'receivers\AirPlayServer'

function Normalize-UpdaterEnvironment {
  if (-not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD.Trim()
  }
}

function Invoke-Step {
  param(
    [string]$Command,
    [string]$WorkingDirectory = $repoRoot,
    [string]$RustToolchain
  )

  Push-Location $WorkingDirectory
  try {
    $previousRustToolchain = $null
    $hadRustToolchain = Test-Path Env:RUSTUP_TOOLCHAIN
    if ($hadRustToolchain) {
      $previousRustToolchain = $env:RUSTUP_TOOLCHAIN
    }

    if (-not [string]::IsNullOrWhiteSpace($RustToolchain)) {
      $env:RUSTUP_TOOLCHAIN = $RustToolchain
    }

    Write-Host "> $Command"
    Invoke-Expression $Command
    if ($LASTEXITCODE -ne 0) {
      throw "Command failed with exit code ${LASTEXITCODE}: $Command"
    }
  }
  finally {
    if (-not [string]::IsNullOrWhiteSpace($RustToolchain)) {
      if ($hadRustToolchain) {
        $env:RUSTUP_TOOLCHAIN = $previousRustToolchain
      }
      else {
        Remove-Item Env:RUSTUP_TOOLCHAIN -ErrorAction SilentlyContinue
      }
    }

    Pop-Location
  }
}

function Assert-UpdaterReleaseConfig {
  Normalize-UpdaterEnvironment

  if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)) {
    throw "TAURI_SIGNING_PRIVATE_KEY is required for release builds so Tauri can sign updater artifacts."
  }
}

function Resolve-ReleaseExecutable {
  $candidateNames = @('MirrorSim.exe', 'mirrorsim.exe')

  foreach ($candidateName in $candidateNames) {
    $candidatePath = Join-Path $releaseTargetDir $candidateName
    if (Test-Path $candidatePath) {
      return $candidatePath
    }
  }

  $exeCandidates = Get-ChildItem -Path $releaseTargetDir -File -Filter '*.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending

  if ($exeCandidates.Count -gt 0) {
    return $exeCandidates[0].FullName
  }

  throw "Release executable not found under $releaseTargetDir"
}

function Invoke-Prep {
  if ($RuntimeSource -eq 'fetch') {
    Invoke-Step 'bun run fetch:airplay-runtime'
  }
  else {
    Invoke-Step 'bun run sync:airplay-runtime'
  }

  Invoke-Step 'bun run build'
}

function Invoke-InstallerBuild {
  Assert-UpdaterReleaseConfig
  $bundleRoot = [System.IO.Path]::GetFullPath((Join-Path $releaseTargetDir 'bundle'))
  $bundleRootPrefix = $bundleRoot.TrimEnd('\') + '\'
  foreach ($bundleName in @('nsis', 'msi')) {
    $bundlePath = [System.IO.Path]::GetFullPath((Join-Path $bundleRoot $bundleName))
    if (-not $bundlePath.StartsWith($bundleRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to clean bundle path outside ${bundleRoot}: $bundlePath"
    }
    if (Test-Path $bundlePath) {
      Remove-Item -Recurse -Force -LiteralPath $bundlePath
    }
  }
  Invoke-Step 'bunx tauri build --bundles nsis,msi' -RustToolchain $releaseRustToolchain
}

function Invoke-PortableBuild {
  Assert-UpdaterReleaseConfig
  Invoke-Step 'bunx tauri build --no-bundle' -RustToolchain $releaseRustToolchain

  $releaseExe = Resolve-ReleaseExecutable

  if (-not (Test-Path (Join-Path $receiverBundle 'MirrorSimAdapter.exe'))) {
    throw "Receiver runtime is missing. Run 'bun run sync:airplay-runtime' first."
  }

  New-Item -ItemType Directory -Force -Path $portableRoot | Out-Null

  if (Test-Path $portableFolder) {
    try {
      Remove-Item -Recurse -Force $portableFolder
    }
    catch {
      throw "Could not refresh $portableFolder. Close any running copy of MirrorSim from the previous portable package and try again."
    }
  }

  if (Test-Path $portableZip) {
    Remove-Item -Force $portableZip
  }

  New-Item -ItemType Directory -Force -Path $portableFolder | Out-Null

  Copy-Item $releaseExe (Join-Path $portableFolder 'MirrorSim.exe') -Force
  Copy-Item (Join-Path $repoRoot 'README.md') (Join-Path $portableFolder 'README.md') -Force
  Copy-Item (Join-Path $repoRoot 'LICENSE') (Join-Path $portableFolder 'LICENSE') -Force
  Copy-Item (Join-Path $repoRoot 'LICENSES\AirPlayServer-LICENSE') (Join-Path $portableFolder 'AirPlayServer-LICENSE') -Force

  if (Test-Path $releaseSupportDir) {
    Copy-Item $releaseSupportDir (Join-Path $portableFolder '_up_') -Recurse -Force
  }
  else {
    New-Item -ItemType Directory -Force -Path (Join-Path $portableFolder 'receivers\AirPlayServer') | Out-Null
    Copy-Item (Join-Path $receiverBundle '*') (Join-Path $portableFolder 'receivers\AirPlayServer') -Recurse -Force
  }

  Compress-Archive -Path (Join-Path $portableFolder '*') -DestinationPath $portableZip -Force

  Write-Host "Portable package created: $portableZip"
}

switch ($Target) {
  'prep' {
    Invoke-Prep
  }
  'installer' {
    Invoke-Prep
    Invoke-InstallerBuild
  }
  'portable' {
    Invoke-Prep
    Invoke-PortableBuild
  }
  'all' {
    Invoke-Prep
    Invoke-InstallerBuild
    Invoke-PortableBuild
  }
}

Write-Host "Release target '$Target' completed using runtime source '$RuntimeSource' and Rust toolchain '$releaseRustToolchain' for packaging steps."
