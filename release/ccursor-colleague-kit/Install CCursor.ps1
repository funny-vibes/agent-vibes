$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Vsix = Get-ChildItem -LiteralPath $ScriptDir -Filter "ccursor-*.vsix" |
  Sort-Object Name |
  Select-Object -Last 1

if (-not $Vsix) {
  throw "ccursor-*.vsix not found in $ScriptDir"
}

function Find-CursorCli {
  $command = Get-Command cursor -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\cursor\resources\app\bin\cursor.cmd"),
    (Join-Path $env:LOCALAPPDATA "Programs\cursor\Cursor.exe"),
    (Join-Path $env:LOCALAPPDATA "cursor\resources\app\bin\cursor.cmd"),
    (Join-Path $env:LOCALAPPDATA "cursor\Cursor.exe")
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }

  throw "Cursor CLI not found. Install Cursor first, then rerun this installer."
}

$CursorCli = Find-CursorCli

Write-Host "Installing CCursor extension..."
& $CursorCli --install-extension $Vsix.FullName --force
if ($LASTEXITCODE -ne 0) {
  throw "Cursor extension installation failed"
}

Write-Host ""
Write-Host "Reading Codex config and writing CCursor OpenAI-compatible account..."
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "lib\Sync-CodexOpenAICompat.ps1")
if ($LASTEXITCODE -ne 0) {
  throw "Codex config sync failed"
}

Write-Host ""
Write-Host "Install finished."
Write-Host "Next: run 'Open Cursor with CCursor.ps1'."
