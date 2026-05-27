$ErrorActionPreference = "Stop"

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

$OfficialUserDataDir = if ($env:CURSOR_OFFICIAL_USER_DATA_DIR) {
  $env:CURSOR_OFFICIAL_USER_DATA_DIR
} else {
  Join-Path $HOME ".cursor-official-profile"
}
$OfficialExtensionsDir = if ($env:CURSOR_OFFICIAL_EXTENSIONS_DIR) {
  $env:CURSOR_OFFICIAL_EXTENSIONS_DIR
} else {
  Join-Path $OfficialUserDataDir "extensions"
}
New-Item -ItemType Directory -Force -Path $OfficialUserDataDir, $OfficialExtensionsDir | Out-Null

$CursorExe = Find-CursorExe

Write-Host "Opening Cursor official profile without CCursor proxy..."
Start-Process -FilePath $CursorExe -ArgumentList @(
  "--user-data-dir=$OfficialUserDataDir",
  "--extensions-dir=$OfficialExtensionsDir"
)

Write-Host ""
Write-Host "Cursor official profile is starting. This window uses Cursor official models and account settings."
