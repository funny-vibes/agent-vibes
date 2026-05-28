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
$CCursorBridgePort = if ($env:CCURSOR_BRIDGE_PORT) { [int]$env:CCURSOR_BRIDGE_PORT } else { 2026 }
$ForwardingScript = Join-Path $ScriptDir "scripts\setup-forwarding.js"

Write-Host "Checking Codex config..."
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "lib\Sync-CodexOpenAICompat.ps1") -CheckOnly
if ($LASTEXITCODE -ne 0) {
  throw "Codex config check failed"
}

Write-Host ""
Write-Host "Checking CCursor account file..."
$CCursorHome = if ($env:CCURSOR_HOME) { $env:CCURSOR_HOME } else { Join-Path $HOME ".ccursor" }
$AccountPath = if ($env:CCURSOR_OPENAI_COMPAT_ACCOUNTS_PATH) {
  $env:CCURSOR_OPENAI_COMPAT_ACCOUNTS_PATH
} else {
  Join-Path (Join-Path $CCursorHome "data") "openai-compat-accounts.json"
}

if (-not (Test-Path -LiteralPath $AccountPath)) {
  throw "$AccountPath not found"
}

$AccountData = Get-Content -LiteralPath $AccountPath -Raw | ConvertFrom-Json
$Accounts = @($AccountData.accounts)
$Managed = @($Accounts | Where-Object { $_.managedBy -eq "ccursor-colleague-kit" })
if ($Managed.Count -eq 0) {
  throw "no ccursor-colleague-kit account found in $AccountPath"
}

foreach ($item in $Managed) {
  Write-Host "Account: $($item.label) $($item.baseUrl) responses=$($item.preferResponsesApi)"
  if ($item.preferResponsesApi -ne $false) {
    throw "$($item.label) uses preferResponsesApi=$($item.preferResponsesApi). Rerun Install CCursor.ps1 to switch to the stable Chat Completions path."
  }
}

Write-Host ""
Write-Host "Checking installed Cursor extension..."
$CursorCli = Get-Command cursor -ErrorAction SilentlyContinue
if ($CursorCli) {
  $extensions = & $CursorCli.Source --list-extensions
  if ($extensions -match '^local-ai\.ccursor$') {
    Write-Host "Extension: local-ai.ccursor installed"
  } else {
    Write-Host "WARN: local-ai.ccursor not listed by Cursor CLI"
  }
} else {
  Write-Host "WARN: cursor CLI not in PATH; extension list skipped"
}

if ($CursorCli) {
  $profileExtensions = & $CursorCli.Source --user-data-dir $CCursorUserDataDir --extensions-dir $CCursorExtensionsDir --list-extensions 2>$null
  if ($profileExtensions -match '^local-ai\.ccursor$') {
    Write-Host "Extension: local-ai.ccursor installed in CCursor profile"
  } else {
    Write-Host "WARN: local-ai.ccursor not listed in CCursor profile. Rerun Install CCursor.ps1."
  }
}

Write-Host ""
Write-Host "Checking Cursor launch profiles..."
Write-Host "Official profile data: $OfficialUserDataDir"
Write-Host "Official profile extensions: $OfficialExtensionsDir"
Write-Host "CCursor profile data: $CCursorUserDataDir"
Write-Host "CCursor profile extensions: $CCursorExtensionsDir"

Write-Host ""
Write-Host "Checking CCursor system forwarding..."
if (Test-Path -LiteralPath $ForwardingScript) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($node) {
    $statusOutput = & $node $ForwardingScript status "--port=$CCursorBridgePort" --json 2>$null
    if ($statusOutput) {
      $forwarding = ($statusOutput -join "`n") | ConvertFrom-Json
      $checks = $forwarding.checks
      if ($LASTEXITCODE -eq 0) {
        Write-Host "Forwarding: active"
      } else {
        Write-Host "WARN: forwarding is not active"
      }
      Write-Host "Forwarding checks: hosts=$($checks.hosts) loopback=$($checks.loopbackAlias) backend=$($checks.backendConfigured) e2e=$($checks.endToEndReachable)"
      if ($LASTEXITCODE -ne 0) {
        Write-Host "WARN: run 'Enable CCursor Forwarding.ps1' as Administrator so Cursor Agent traffic cannot bypass the local bridge."
      }
    } else {
      Write-Host "WARN: forwarding status check failed"
    }
  } else {
    Write-Host "WARN: node not found; forwarding status skipped"
  }
} else {
  Write-Host "WARN: forwarding script missing. Reinstall the full CCursor colleague kit."
}

Write-Host ""
Write-Host "Checking CCursor bridge..."
try {
  $bridgeHandler = [System.Net.Http.HttpClientHandler]::new()
  $bridgeHandler.ServerCertificateCustomValidationCallback = { $true }
  $bridgeClient = [System.Net.Http.HttpClient]::new($bridgeHandler)
  $bridgeClient.Timeout = [TimeSpan]::FromSeconds(5)
  $statusBody = $null
  foreach ($uri in @("http://127.0.0.1:2026/pool/status", "https://localhost:2026/pool/status")) {
    try {
      $statusBody = $bridgeClient.GetStringAsync($uri).GetAwaiter().GetResult()
      break
    } catch {
      if ($uri -eq "https://localhost:2026/pool/status") {
        throw
      }
    }
  }
  $status = $statusBody | ConvertFrom-Json
  $pool = $status.backends.openaiCompat
  Write-Host "Bridge: running"
  Write-Host "OpenAI-compatible: configured=$($pool.configured) total=$($pool.total) ready=$($pool.ready) available=$($pool.available)"
} catch {
  Write-Host "WARN: bridge is not reachable yet. Open Cursor with the provided launcher and wait 10-20 seconds."
}

Write-Host ""
Write-Host "Checking Cursor proxy path..."
try {
  $proxy = [System.Net.WebProxy]::new("http://127.0.0.1:18080")
  $clientHandler = [System.Net.Http.HttpClientHandler]::new()
  $clientHandler.Proxy = $proxy
  $clientHandler.UseProxy = $true
  $clientHandler.ServerCertificateCustomValidationCallback = { $true }
  $client = [System.Net.Http.HttpClient]::new($clientHandler)
  $client.Timeout = [TimeSpan]::FromSeconds(8)
  $response = $client.GetAsync("https://api2.cursor.sh/health").GetAwaiter().GetResult()
  $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  if ($response.IsSuccessStatusCode) {
    Write-Host "Proxy: reachable"
    Write-Host $body
  } else {
    Write-Host "WARN: proxy health check returned HTTP $($response.StatusCode)"
  }
} catch {
  Write-Host "WARN: proxy health check failed. This is expected if Cursor/CCursor bridge is not running."
}
