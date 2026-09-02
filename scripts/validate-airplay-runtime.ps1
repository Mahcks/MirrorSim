param(
  [Parameter(Mandatory = $true)]
  [string]$RuntimeDir,
  [string]$ExpectedProtocolVersion = '0.5.0'
)

$ErrorActionPreference = 'Stop'
$RuntimeDir = [System.IO.Path]::GetFullPath($RuntimeDir)
$requiredFiles = @(
  'airplay2dll.dll',
  'avcodec-58.dll',
  'avutil-56.dll',
  'MirrorSimAdapter.exe',
  'msys-2.0.dll',
  'swscale-5.dll'
)

if (-not (Test-Path -LiteralPath $RuntimeDir -PathType Container)) {
  throw "AirPlay runtime directory does not exist: $RuntimeDir"
}

$actualFiles = @(Get-ChildItem -LiteralPath $RuntimeDir -File | ForEach-Object Name | Sort-Object)
$unexpectedFiles = @($actualFiles | Where-Object { $_ -notin $requiredFiles -and $_ -ne 'README.md' })
$missingFiles = @($requiredFiles | Where-Object { $_ -notin $actualFiles })
if ($missingFiles.Count -gt 0 -or $unexpectedFiles.Count -gt 0) {
  throw "AirPlay runtime inventory mismatch. Missing: $($missingFiles -join ', '). Unexpected: $($unexpectedFiles -join ', ')."
}

foreach ($fileName in $requiredFiles) {
  $path = Join-Path $RuntimeDir $fileName
  $stream = [System.IO.File]::OpenRead($path)
  try {
    if ($stream.Length -lt 64) {
      throw "Runtime PE file is unexpectedly small: $path"
    }
    $reader = [System.IO.BinaryReader]::new($stream)
    if ($reader.ReadUInt16() -ne 0x5A4D) {
      throw "Runtime file is not a Windows PE image: $path"
    }
    $stream.Position = 0x3C
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 0 -or $peOffset + 6 -gt $stream.Length) {
      throw "Runtime file has an invalid PE header: $path"
    }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) {
      throw "Runtime file has an invalid PE signature: $path"
    }
    if ($reader.ReadUInt16() -ne 0x8664) {
      throw "Runtime file is not x64: $path"
    }
  }
  finally {
    $stream.Dispose()
  }
}

Push-Location $RuntimeDir
try {
  $output = '{"name":"shutdown"}' | & '.\MirrorSimAdapter.exe'
  if ($LASTEXITCODE -ne 0) {
    throw "MirrorSimAdapter smoke test exited with code $LASTEXITCODE."
  }
  $events = @($output | ForEach-Object { $_ | ConvertFrom-Json })
  $ready = $events | Where-Object { $_.name -eq 'receiver_ready' } | Select-Object -First 1
  if ($null -eq $ready) {
    throw 'MirrorSimAdapter did not emit receiver_ready.'
  }
  if ($ready.protocol_version -ne $ExpectedProtocolVersion) {
    throw "Expected adapter protocol $ExpectedProtocolVersion, received '$($ready.protocol_version)'."
  }
}
finally {
  Pop-Location
}

Write-Host "Validated x64 AirPlay runtime inventory and protocol $ExpectedProtocolVersion in $RuntimeDir"
