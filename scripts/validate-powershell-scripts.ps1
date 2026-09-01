$ErrorActionPreference = 'Stop'

$parseFailures = @()
Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File | ForEach-Object {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile(
    $_.FullName,
    [ref]$tokens,
    [ref]$errors
  )

  foreach ($parseError in $errors) {
    $parseFailures += "{0}:{1}:{2}: {3}" -f @(
      $_.Name,
      $parseError.Extent.StartLineNumber,
      $parseError.Extent.StartColumnNumber,
      $parseError.Message
    )
  }
}

if ($parseFailures.Count -gt 0) {
  throw "PowerShell script validation failed:`n$($parseFailures -join "`n")"
}

Write-Host 'All PowerShell scripts parse successfully.'
