$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
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
$CCursorHome = if ($env:CCURSOR_HOME) {
  $env:CCURSOR_HOME
} else {
  Join-Path $HOME ".ccursor"
}
$CCursorBridgePort = if ($env:CCURSOR_BRIDGE_PORT) {
  [int]$env:CCURSOR_BRIDGE_PORT
} else {
  2026
}
$CCursorForwardProxyPort = if ($env:CCURSOR_FORWARD_PROXY_PORT) {
  [int]$env:CCURSOR_FORWARD_PROXY_PORT
} else {
  18080
}
New-Item -ItemType Directory -Force -Path $CCursorUserDataDir, $CCursorExtensionsDir, (Join-Path $CCursorHome "logs") | Out-Null

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

function Test-BridgeHealth {
  try {
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.ServerCertificateCustomValidationCallback = { $true }
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(3)
    foreach ($uri in @(
      "https://localhost:$CCursorBridgePort/health",
      "http://127.0.0.1:$CCursorBridgePort/health"
    )) {
      try {
        $response = $client.GetAsync($uri).GetAwaiter().GetResult()
        if ($response.IsSuccessStatusCode) {
          return $true
        }
      } catch {
      }
    }
  } catch {
  }
  return $false
}

function Test-ProxyHealth {
  try {
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.Proxy = [System.Net.WebProxy]::new("http://127.0.0.1:$CCursorForwardProxyPort")
    $handler.UseProxy = $true
    $handler.ServerCertificateCustomValidationCallback = { $true }
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(5)
    $response = $client.GetAsync("https://api2.cursor.sh/health").GetAwaiter().GetResult()
    return $response.IsSuccessStatusCode
  } catch {
    return $false
  }
}

function Test-RuntimeReady {
  return (Test-BridgeHealth) -and (Test-ProxyHealth)
}

function Find-BridgeExe {
  $candidate = Get-ChildItem -LiteralPath $CCursorExtensionsDir -Recurse -Filter "agent-vibes-bridge.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\bridge\\win32-x64\\agent-vibes-bridge\.exe$" } |
    Sort-Object FullName |
    Select-Object -Last 1
  if ($candidate) {
    return $candidate.FullName
  }
  return $null
}

function Ensure-BridgeRunning {
  if (Test-RuntimeReady) {
    Write-Host "CCursor bridge/proxy: already running"
    return
  }

  $bridgeExe = Find-BridgeExe
  if (-not $bridgeExe) {
    Write-Host "WARN: CCursor bridge binary not found in $CCursorExtensionsDir"
    Write-Host "WARN: Cursor will still open; rerun Install CCursor.ps1 if the bridge does not start."
    return
  }

  Write-Host "Starting CCursor bridge before Cursor..."
  $env:PORT = [string]$CCursorBridgePort
  $env:AGENT_VIBES_DATA_DIR = $CCursorHome
  $env:AGENT_VIBES_OPENAI_COMPAT_ACCOUNTS_PATH = Join-Path (Join-Path $CCursorHome "data") "openai-compat-accounts.json"
  $env:CURSOR_PROTOCOL_TRACE_FILE = Join-Path (Join-Path $CCursorHome "logs") "cursor_protocol_trace.jsonl"
  $env:NO_COLOR = "1"
  $env:FORCE_COLOR = "0"
  $caPath = Join-Path (Join-Path $CCursorHome "certs") "ca.pem"
  if (Test-Path -LiteralPath $caPath) {
    $env:NODE_EXTRA_CA_CERTS = $caPath
  }
  Start-Process -FilePath $bridgeExe -WindowStyle Hidden | Out-Null

  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline) {
    if (Test-RuntimeReady) {
      Write-Host "CCursor bridge/proxy: healthy"
      return
    }
    Start-Sleep -Seconds 1
  }

  Write-Host "WARN: CCursor bridge/proxy did not become healthy within 25 seconds."
  Write-Host "WARN: Continue opening Cursor; run Check CCursor.ps1 if the Agent cannot connect."
}

Write-Host "Refreshing CCursor account from Codex config..."
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "lib\Sync-CodexOpenAICompat.ps1")
if ($LASTEXITCODE -ne 0) {
  throw "Codex config sync failed"
}

$CursorExe = Find-CursorExe

Write-Host ""
Ensure-BridgeRunning

Write-Host ""
Write-Host "Opening Cursor through CCursor local proxy..."
Start-Process -FilePath $CursorExe -ArgumentList @(
  "--user-data-dir=$CCursorUserDataDir",
  "--extensions-dir=$CCursorExtensionsDir",
  "--proxy-server=http://127.0.0.1:$CCursorForwardProxyPort",
  "--ignore-certificate-errors"
)

Write-Host ""
Write-Host "Cursor CCursor profile is starting. Run 'Check CCursor.ps1' if needed."
