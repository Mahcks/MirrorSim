param(
  [string]$SourceDir,
  [string]$DestinationDir,
  [switch]$IncludeDebugSymbols,
  [switch]$NoClean
)

$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

$defaultSourceCandidates = @(
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot '..\AirPlayServer\AirPlayServer\bin\x64')),
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot '..\AirPlayServer\x64\Release')),
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot '..\AirPlayServer\x64\Debug'))
)

if ([string]::IsNullOrWhiteSpace($SourceDir)) {
  $SourceDir = $defaultSourceCandidates |
    Where-Object { Test-Path (Join-Path $_ 'MirrorSimAdapter.exe') } |
    Select-Object -First 1

  if (-not $SourceDir) {
    $SourceDir = $defaultSourceCandidates |
      Where-Object { Test-Path $_ } |
      Select-Object -First 1
  }
}

if ([string]::IsNullOrWhiteSpace($SourceDir)) {
  if ([string]::IsNullOrWhiteSpace($DestinationDir)) {
    $DestinationDir = Join-Path $repoRoot 'receivers\AirPlayServer'
  }

  $DestinationDir = [System.IO.Path]::GetFullPath($DestinationDir)
  $existingAdapter = Join-Path $DestinationDir 'MirrorSimAdapter.exe'

  if (Test-Path $existingAdapter) {
    throw "No local AirPlayServer build output was found. Refusing to reuse the unverified runtime already present in $DestinationDir. Fetch the pinned runtime or pass -SourceDir explicitly."
  }

  throw "Could not find an AirPlayServer build output. Build MirrorSimAdapter first, fetch the versioned runtime bundle, or pass -SourceDir explicitly."
}

$SourceDir = [System.IO.Path]::GetFullPath($SourceDir)

if ([string]::IsNullOrWhiteSpace($DestinationDir)) {
  $DestinationDir = Join-Path $repoRoot 'receivers\AirPlayServer'
}

$DestinationDir = [System.IO.Path]::GetFullPath($DestinationDir)

if (-not (Test-Path $SourceDir)) {
  throw "Source directory does not exist: $SourceDir"
}

& (Join-Path $repoRoot 'scripts\validate-airplay-runtime.ps1') -RuntimeDir $SourceDir
if (-not $?) {
  throw "AirPlay runtime failed inventory or protocol validation."
}

New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null

$patterns = @('*.exe', '*.dll')
if ($IncludeDebugSymbols) {
  $patterns += '*.pdb'
}

$sourceFiles = foreach ($pattern in $patterns) {
  Get-ChildItem -Path $SourceDir -Filter $pattern -File -ErrorAction SilentlyContinue
}

$sourceFiles = $sourceFiles | Sort-Object FullName -Unique

if (-not $sourceFiles) {
  throw "No runtime files matched in $SourceDir"
}

if (-not $NoClean) {
  $existingRuntimeFiles = foreach ($pattern in $patterns) {
    Get-ChildItem -Path $DestinationDir -Filter $pattern -File -ErrorAction SilentlyContinue
  }

  foreach ($existingFile in ($existingRuntimeFiles | Sort-Object FullName -Unique)) {
    if ($existingFile.Name -ne 'README.md') {
      try {
        Remove-Item -Force $existingFile.FullName
      }
      catch {
      throw "Could not remove locked runtime file: $($existingFile.FullName). Close the process and retry to avoid a mixed runtime bundle."
      }
    }
  }
}

$copiedNames = New-Object System.Collections.Generic.List[string]
$skippedNames = New-Object System.Collections.Generic.List[string]

foreach ($file in $sourceFiles) {
  $destinationPath = Join-Path $DestinationDir $file.Name
  if (Test-Path $destinationPath) {
    $destinationFile = Get-Item $destinationPath
    if ($destinationFile.Length -eq $file.Length -and $destinationFile.LastWriteTimeUtc -eq $file.LastWriteTimeUtc) {
      $skippedNames.Add($file.Name) | Out-Null
      continue
    }
  }

  try {
    Copy-Item -Path $file.FullName -Destination $destinationPath -Force
    $copiedNames.Add($file.Name) | Out-Null
  }
  catch {
    throw "Could not copy runtime file to $destinationPath. Close any process using it and retry. $($_.Exception.Message)"
  }
}

Write-Host "Synced AirPlay receiver runtime from $SourceDir to $DestinationDir"
if ($copiedNames.Count -gt 0) {
  Write-Host "Copied files:"
  $copiedNames | ForEach-Object { Write-Host " - $_" }
}
if ($skippedNames.Count -gt 0) {
  Write-Host "Reused existing files:"
  $skippedNames | ForEach-Object { Write-Host " - $_" }
}
