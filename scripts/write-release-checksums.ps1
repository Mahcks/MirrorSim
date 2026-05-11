param(
  [string]$OutputPath = "release/checksums.txt"
)

$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

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

$resolvedOutputPath = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
  $OutputPath
}
else {
  Join-Path $repoRoot $OutputPath
}

$patterns = @(
  'src-tauri/target/release/bundle/nsis/*.exe',
  'src-tauri/target/release/bundle/msi/*.msi',
  'release/portable/*.zip',
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
  $relativePath = [System.IO.Path]::GetRelativePath($repoRoot, $artifact.FullName).Replace('\', '/')
  "$hash  $relativePath"
}

$lines | Set-Content -Path $resolvedOutputPath -Encoding utf8
Write-Host "Wrote release checksums to $resolvedOutputPath"
