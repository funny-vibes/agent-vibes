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

$CCursorUserDataDir = if ($env:CCURSOR_USER_DATA_DIR) {
  $env:CCURSOR_USER_DATA_DIR
} else {
  Join-Path $HOME ".cursor-ccursor-profile"
}
$CCursorExtensionsDir = if ($env:CCURSOR_EXTENSIONS_DIR) {
  $env:CCURSOR_EXTENSIONS_DIR
} else {
  Join-Path $CCursorUserDataDir "extensions"
}
New-Item -ItemType Directory -Force -Path $CCursorUserDataDir, $CCursorExtensionsDir | Out-Null

Write-Host "Installing CCursor extension into isolated CCursor profile..."
& $CursorCli `
  --user-data-dir $CCursorUserDataDir `
  --extensions-dir $CCursorExtensionsDir `
  --install-extension $Vsix.FullName `
  --force
if ($LASTEXITCODE -ne 0) {
  throw "Cursor extension installation into isolated profile failed"
}

Write-Host ""
Write-Host "Reading Codex config and writing CCursor OpenAI-compatible account..."
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "lib\Sync-CodexOpenAICompat.ps1")
if ($LASTEXITCODE -ne 0) {
  throw "Codex config sync failed"
}

Write-Host ""
Write-Host "Install finished."
Write-Host "Next:"
Write-Host "  - run 'Open Cursor Official.ps1' for Cursor official models"
Write-Host "  - run 'Open Cursor with CCursor.ps1' for your AI gateway"
