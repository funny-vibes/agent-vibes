param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Paths
)

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

$AgentVibesUserDataDir = if ($env:AGENT_VIBES_USER_DATA_DIR) {
  $env:AGENT_VIBES_USER_DATA_DIR
} else {
  Join-Path $HOME ".cursor-agent-vibes-profile"
}
$AgentVibesExtensionsDir = if ($env:AGENT_VIBES_EXTENSIONS_DIR) {
  $env:AGENT_VIBES_EXTENSIONS_DIR
} else {
  Join-Path $AgentVibesUserDataDir "extensions"
}
$AgentVibesForwardProxyPort = if ($env:AGENT_VIBES_FORWARD_PROXY_PORT) {
  [int]$env:AGENT_VIBES_FORWARD_PROXY_PORT
} else {
  18080
}
$ProxyUrl = "http://127.0.0.1:$AgentVibesForwardProxyPort"

New-Item -ItemType Directory -Force -Path $AgentVibesUserDataDir, $AgentVibesExtensionsDir | Out-Null

$env:HTTP_PROXY = $ProxyUrl
$env:HTTPS_PROXY = $ProxyUrl
$env:ALL_PROXY = $ProxyUrl
$env:http_proxy = $ProxyUrl
$env:https_proxy = $ProxyUrl
$env:all_proxy = $ProxyUrl
$env:NO_PROXY = "localhost,127.0.0.1,::1"
$env:no_proxy = "localhost,127.0.0.1,::1"

$CursorExe = Find-CursorExe
$Args = @(
  "--user-data-dir=$AgentVibesUserDataDir",
  "--extensions-dir=$AgentVibesExtensionsDir",
  "--proxy-server=$ProxyUrl",
  "--ignore-certificate-errors",
  "--new-window"
) + $Paths

Write-Host "Opening isolated Cursor profile through Agent Vibes proxy..."
Write-Host "Profile: $AgentVibesUserDataDir"
Write-Host "Proxy:   $ProxyUrl"
Start-Process -FilePath $CursorExe -ArgumentList $Args
