param(
  [string]$OutputPath = "release/checksums.txt"
)

$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packageJson = Get-Content -Raw (Join-Path $repoRoot 'package.json') | ConvertFrom-Json
$version = [string]$packageJson.version

function Get-Sha256Hex {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hashBytes = $sha256.ComputeHash($stream)
      return [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
    }
    finally {
      $sha256.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }
}

function Get-RelativeArtifactPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BasePath,

    [Parameter(Mandatory = $true)]
    [string]$TargetPath
  )

  $baseFullPath = [System.IO.Path]::GetFullPath($BasePath)
  if (-not $baseFullPath.EndsWith([System.IO.Path]::DirectorySeparatorChar.ToString())) {
    $baseFullPath += [System.IO.Path]::DirectorySeparatorChar
  }

  $targetFullPath = [System.IO.Path]::GetFullPath($TargetPath)
  $baseUri = New-Object System.Uri($baseFullPath)
  $targetUri = New-Object System.Uri($targetFullPath)

  return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace('\', '/')
}

$resolvedOutputPath = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
  $OutputPath
}
else {
  Join-Path $repoRoot $OutputPath
}

$patterns = @(
  "src-tauri/target/release/bundle/nsis/*$version*.exe",
  "src-tauri/target/release/bundle/msi/*$version*.msi",
  "release/portable/*$version*.zip",
  'release/latest.json'
)

$artifacts = foreach ($pattern in $patterns) {
  Get-ChildItem -Path (Join-Path $repoRoot $pattern) -File -ErrorAction SilentlyContinue
}

if (-not $artifacts) {
  throw 'No release artifacts found to checksum.'
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedOutputPath) | Out-Null

$lines = foreach ($artifact in ($artifacts | Sort-Object FullName)) {
  $hash = Get-Sha256Hex -Path $artifact.FullName
  $relativePath = Get-RelativeArtifactPath -BasePath $repoRoot -TargetPath $artifact.FullName
  "$hash  $relativePath"
}

$lines | Set-Content -Path $resolvedOutputPath -Encoding utf8
Write-Host "Wrote release checksums to $resolvedOutputPath"
