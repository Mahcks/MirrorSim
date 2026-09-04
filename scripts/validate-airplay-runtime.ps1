param(
  [Parameter(Mandatory = $true)]
  [string]$RuntimeDir,
  [string]$ExpectedProtocolVersion = '0.8.0'
)

$ErrorActionPreference = 'Stop'
$RuntimeDir = [System.IO.Path]::GetFullPath($RuntimeDir)
$requiredFiles = @(
  'airplay2dll.dll',
  'avcodec-62.dll',
  'avutil-60.dll',
  'MirrorSimAdapter.exe',
  'swscale-9.dll'
)
$allowedDocumentationFiles = @(
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md'
)

if (-not (Test-Path -LiteralPath $RuntimeDir -PathType Container)) {
  throw "AirPlay runtime directory does not exist: $RuntimeDir"
}

$actualFiles = @(Get-ChildItem -LiteralPath $RuntimeDir -File | ForEach-Object Name | Sort-Object)
$unexpectedFiles = @(
  $actualFiles | Where-Object {
    $_ -notin $requiredFiles -and $_ -notin $allowedDocumentationFiles
  }
)
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
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = Join-Path $RuntimeDir 'MirrorSimAdapter.exe'
  $startInfo.WorkingDirectory = $RuntimeDir
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.EnvironmentVariables['MIRRORSIM_EXTERNAL_DNSSD'] = '1'
  $startInfo.EnvironmentVariables['MIRRORSIM_HARDWARE_ADDRESS'] = '0210ABCDEF08'

  $adapterProcess = [System.Diagnostics.Process]::new()
  $adapterProcess.StartInfo = $startInfo
  if (-not $adapterProcess.Start()) {
    throw 'MirrorSimAdapter smoke test could not start.'
  }

  try {
    $readyTask = $adapterProcess.StandardOutput.ReadLineAsync()
    if (-not $readyTask.Wait(5000)) {
      throw 'MirrorSimAdapter did not emit receiver_ready within five seconds.'
    }
    $ready = $readyTask.Result | ConvertFrom-Json
    if ($ready.name -ne 'receiver_ready') {
      throw "MirrorSimAdapter emitted '$($ready.name)' before receiver_ready."
    }
    if ($ready.protocol_version -ne $ExpectedProtocolVersion) {
      throw "Expected adapter protocol $ExpectedProtocolVersion, received '$($ready.protocol_version)'."
    }
    if ($ready.capabilities -notcontains 'pcm-audio') {
      throw 'MirrorSimAdapter did not advertise the required pcm-audio capability.'
    }
    if ($ready.capabilities -notcontains 'sender-volume') {
      throw 'MirrorSimAdapter did not advertise the required sender-volume capability.'
    }
    if ($ready.capabilities -notcontains 'video-geometry') {
      throw 'MirrorSimAdapter did not advertise the required video-geometry capability.'
    }
    if ($ready.capabilities -notcontains 'video-sender-state') {
      throw 'MirrorSimAdapter did not advertise the required video-sender-state capability.'
    }
    if ($ready.capabilities -notcontains 'external-dnssd') {
      throw 'MirrorSimAdapter did not advertise the required external-dnssd capability.'
    }

    $adapterProcess.StandardInput.WriteLine('{"name":"start_session","session_id":"runtime-smoke-session","expected_stream_id":"runtime-smoke-stream","receiver_name":"MirrorSim Runtime Smoke","trusted_device_ids":[],"blocked_device_ids":[]}')
    $adapterProcess.StandardInput.Flush()

    $listenDeadline = [DateTime]::UtcNow.AddSeconds(8)
    $listeningPorts = @()
    do {
      if ($adapterProcess.HasExited) {
        $stderr = $adapterProcess.StandardError.ReadToEnd()
        throw "MirrorSimAdapter exited while starting its AirPlay listeners. $stderr"
      }
      $listeningPorts = @(
        Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
          Where-Object { $_.OwningProcess -eq $adapterProcess.Id -and $_.LocalPort -in @(5001, 7001) } |
          Select-Object -ExpandProperty LocalPort -Unique
      )
      if ($listeningPorts.Count -lt 2) {
        Start-Sleep -Milliseconds 100
      }
    } while ($listeningPorts.Count -lt 2 -and [DateTime]::UtcNow -lt $listenDeadline)

    if (5001 -notin $listeningPorts -or 7001 -notin $listeningPorts) {
      throw "MirrorSimAdapter did not listen on both AirPlay ports. Observed: $($listeningPorts -join ', ')."
    }

    $adapterProcess.StandardInput.WriteLine('{"name":"shutdown"}')
    $adapterProcess.StandardInput.Close()
    if (-not $adapterProcess.WaitForExit(10000)) {
      throw 'MirrorSimAdapter did not stop within ten seconds.'
    }
    if ($adapterProcess.ExitCode -ne 0) {
      $stderr = $adapterProcess.StandardError.ReadToEnd()
      throw "MirrorSimAdapter smoke test exited with code $($adapterProcess.ExitCode). $stderr"
    }
  }
  finally {
    if (-not $adapterProcess.HasExited) {
      $adapterProcess.Kill()
      $adapterProcess.WaitForExit()
    }
    $adapterProcess.Dispose()
  }
}
finally {
  Pop-Location
}

Write-Host "Validated x64 AirPlay runtime inventory and protocol $ExpectedProtocolVersion in $RuntimeDir"
