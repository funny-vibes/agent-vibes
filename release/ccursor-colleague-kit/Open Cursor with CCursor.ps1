$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-CursorExe {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\cursor\Cursor.exe"),
    (Join-Path $env:LOCALAPPDATA "cursor\Cursor.exe")
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }

  $command = Get-Command cursor -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  throw "Cursor.exe not found. Install Cursor first."
}

Write-Host "Refreshing CCursor account from Codex config..."
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "lib\Sync-CodexOpenAICompat.ps1")
if ($LASTEXITCODE -ne 0) {
  throw "Codex config sync failed"
}

$CursorExe = Find-CursorExe

Write-Host ""
Write-Host "Opening Cursor through CCursor local proxy..."
Start-Process -FilePath $CursorExe -ArgumentList @(
  "--proxy-server=http://127.0.0.1:18080",
  "--ignore-certificate-errors"
)

Write-Host ""
Write-Host "Cursor is starting. Wait 10-20 seconds, then run 'Check CCursor.ps1' if needed."
