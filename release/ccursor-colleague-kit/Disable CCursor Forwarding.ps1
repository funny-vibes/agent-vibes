$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CCursorBridgePort = if ($env:CCURSOR_BRIDGE_PORT) { [int]$env:CCURSOR_BRIDGE_PORT } else { 2026 }
$ScriptPath = Join-Path $ScriptDir "scripts\setup-forwarding.js"

if (-not (Test-Path -LiteralPath $ScriptPath)) {
  throw "forwarding script not found: $ScriptPath. Reinstall the full CCursor colleague kit."
}

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) {
  throw "node is required but was not found in PATH."
}

$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
$IsAdmin = $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $IsAdmin) {
  Write-Host "Disabling CCursor system forwarding requires Administrator."
  Start-Process -FilePath "powershell" -Verb RunAs -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$PSCommandPath`""
  )
  exit 0
}

Write-Host "Disabling CCursor system forwarding..."
Write-Host ""

& $Node $ScriptPath off "--port=$CCursorBridgePort"
if ($LASTEXITCODE -ne 0) {
  throw "failed to disable forwarding"
}

Write-Host ""
Write-Host "Checking forwarding status..."
& $Node $ScriptPath status "--port=$CCursorBridgePort"
