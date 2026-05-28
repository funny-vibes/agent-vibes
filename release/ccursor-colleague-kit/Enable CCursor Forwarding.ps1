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
  Write-Host "Enabling CCursor system forwarding requires Administrator."
  Start-Process -FilePath "powershell" -Verb RunAs -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$PSCommandPath`""
  )
  exit 0
}

Write-Host "Enabling CCursor system forwarding..."
Write-Host "Managed changes:"
Write-Host "  - Windows hosts block for Cursor API domains"
Write-Host "  - 127.0.0.2 loopback alias"
Write-Host "  - portproxy: 127.0.0.2:443 -> 127.0.0.1:$CCursorBridgePort"
Write-Host ""

& $Node $ScriptPath on "--port=$CCursorBridgePort"
if ($LASTEXITCODE -ne 0) {
  throw "failed to enable forwarding"
}

Write-Host ""
Write-Host "Checking forwarding status..."
& $Node $ScriptPath status "--port=$CCursorBridgePort"
