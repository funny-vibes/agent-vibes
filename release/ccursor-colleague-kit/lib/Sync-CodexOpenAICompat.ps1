param(
  [switch]$CheckOnly,
  [switch]$DryRun,
  [switch]$Json
)

$ErrorActionPreference = "Stop"

$DefaultModel = "gpt-5.5"
$DefaultContextTokens = 200000
$ManagedBy = "ccursor-colleague-kit"

function Fail-With {
  param([string]$Message)
  Write-Error $Message
  exit 1
}

function Strip-InlineComment {
  param([string]$Line)

  $quote = $null
  $escaped = $false
  $chars = New-Object System.Collections.Generic.List[char]

  foreach ($char in $Line.ToCharArray()) {
    if ($escaped) {
      $chars.Add($char)
      $escaped = $false
      continue
    }

    if ($quote -eq '"' -and $char -eq '\') {
      $chars.Add($char)
      $escaped = $true
      continue
    }

    if ($quote) {
      if ($char -eq $quote) {
        $quote = $null
      }
      $chars.Add($char)
      continue
    }

    if ($char -eq '"' -or $char -eq "'") {
      $quote = $char
      $chars.Add($char)
      continue
    }

    if ($char -eq '#') {
      break
    }

    $chars.Add($char)
  }

  -join $chars
}

function Parse-TomlValue {
  param([string]$RawValue)

  $value = (Strip-InlineComment $RawValue).Trim()
  if ($value.StartsWith('"') -and $value.EndsWith('"')) {
    return $value.Substring(1, $value.Length - 2).Replace('\"', '"').Replace('\\', '\')
  }
  if ($value.StartsWith("'") -and $value.EndsWith("'")) {
    return $value.Substring(1, $value.Length - 2)
  }
  if ($value -eq "true") {
    return $true
  }
  if ($value -eq "false") {
    return $false
  }
  if ($value -match '^-?\d+$') {
    return [int]$value
  }
  return $value
}

function Parse-CodexConfig {
  param([string]$Path)

  $data = @{
    model_providers = @{}
  }
  $section = @()

  foreach ($line in Get-Content -LiteralPath $Path) {
    $cleaned = (Strip-InlineComment $line).Trim()
    if ([string]::IsNullOrWhiteSpace($cleaned)) {
      continue
    }

    if ($cleaned -match '^\[([^\]]+)\]$') {
      $section = $Matches[1].Split(".") | ForEach-Object { $_.Trim() }
      continue
    }

    if ($cleaned -notmatch '^([A-Za-z0-9_.-]+)\s*=\s*(.+)$') {
      continue
    }

    $key = $Matches[1]
    $value = Parse-TomlValue $Matches[2]

    if ($section.Count -eq 2 -and $section[0] -eq "model_providers") {
      $provider = $section[1]
      if (-not $data.model_providers.ContainsKey($provider)) {
        $data.model_providers[$provider] = @{}
      }
      $data.model_providers[$provider][$key] = $value
    } elseif ($section.Count -eq 0) {
      $data[$key] = $value
    }
  }

  return $data
}

function Get-FirstValue {
  param(
    [hashtable]$Map,
    [string[]]$Keys
  )

  foreach ($key in $Keys) {
    if ($Map.ContainsKey($key)) {
      $value = [string]$Map[$key]
      if (-not [string]::IsNullOrWhiteSpace($value)) {
        return $value.Trim()
      }
    }
  }

  return ""
}

function Find-Provider {
  param([hashtable]$Config)

  $providers = $Config.model_providers
  $configuredName = [string]($Config.model_provider)

  if (-not [string]::IsNullOrWhiteSpace($configuredName) -and $providers.ContainsKey($configuredName)) {
    return @($configuredName, $providers[$configuredName])
  }

  foreach ($name in $providers.Keys) {
    $provider = $providers[$name]
    $baseUrl = Get-FirstValue $provider @("base_url", "baseUrl")
    if (-not [string]::IsNullOrWhiteSpace($baseUrl)) {
      return @($name, $provider)
    }
  }

  Fail-With "No usable [model_providers.<name>] entry with base_url found in Codex config"
}

function Resolve-ApiKey {
  param([hashtable]$Provider)

  $directKeyFields = @(
    "api_key",
    "apiKey",
    "bearer_token",
    "bearerToken",
    "experimental_bearer_token",
    "token"
  )

  foreach ($field in $directKeyFields) {
    if (-not $Provider.ContainsKey($field)) {
      continue
    }

    $value = [string]$Provider[$field]
    if ([string]::IsNullOrWhiteSpace($value)) {
      continue
    }
    $value = $value.Trim()

    if ($value.StartsWith("env:")) {
      $envName = $value.Substring(4).Trim()
      $envValue = [Environment]::GetEnvironmentVariable($envName)
      if (-not [string]::IsNullOrWhiteSpace($envValue)) {
        return @($envValue.Trim(), "env:$envName")
      }
      Fail-With "Codex provider references $envName, but that environment variable is empty"
    }

    return @($value, $field)
  }

  foreach ($field in @("env_key", "api_key_env", "apiKeyEnv")) {
    if (-not $Provider.ContainsKey($field)) {
      continue
    }

    $envName = [string]$Provider[$field]
    if ([string]::IsNullOrWhiteSpace($envName)) {
      continue
    }
    $envName = $envName.Trim()
    $envValue = [Environment]::GetEnvironmentVariable($envName)
    if (-not [string]::IsNullOrWhiteSpace($envValue)) {
      return @($envValue.Trim(), "env:$envName")
    }
    Fail-With "Codex provider references $envName, but that environment variable is empty"
  }

  Fail-With "No api_key/apiKey/experimental_bearer_token/env_key found for the selected Codex provider"
}

function Load-ExistingAccounts {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return [ordered]@{ accounts = @() }
  }

  try {
    $parsed = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 16
    $accounts = @()
    if ($parsed.accounts -is [System.Array]) {
      $accounts = @($parsed.accounts)
    } elseif ($null -ne $parsed.accounts) {
      $accounts = @($parsed.accounts)
    }
    return [ordered]@{ accounts = $accounts }
  } catch {
    return [ordered]@{ accounts = @() }
  }
}

$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$CodexConfigPath = Join-Path $CodexHome "config.toml"
if (-not (Test-Path -LiteralPath $CodexConfigPath)) {
  Fail-With "Codex config not found at $CodexConfigPath"
}

$Config = Parse-CodexConfig $CodexConfigPath
$ProviderResult = Find-Provider $Config
$ProviderName = $ProviderResult[0]
$Provider = $ProviderResult[1]
$BaseUrl = Get-FirstValue $Provider @("base_url", "baseUrl")
if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  Fail-With "Selected Codex provider $ProviderName has empty base_url"
}

$ApiKeyResult = Resolve-ApiKey $Provider
$ApiKey = $ApiKeyResult[0]
$KeySource = $ApiKeyResult[1]

$Model = [string]$Config.model
if ([string]::IsNullOrWhiteSpace($Model)) {
  $Model = [string]$Provider.model
}
if ([string]::IsNullOrWhiteSpace($Model)) {
  $Model = $DefaultModel
}
$Model = $Model.Trim()

$Label = "codex-$ProviderName"
$Account = [ordered]@{
  label = $Label
  apiKey = $ApiKey
  baseUrl = $BaseUrl
  preferResponsesApi = $true
  maxContextTokens = $DefaultContextTokens
  managedBy = $ManagedBy
  sourceProvider = $ProviderName
  sourceModel = $Model
}

$CCursorHome = if ($env:CCURSOR_HOME) { $env:CCURSOR_HOME } else { Join-Path $HOME ".ccursor" }
$DestPath = if ($env:CCURSOR_OPENAI_COMPAT_ACCOUNTS_PATH) {
  $env:CCURSOR_OPENAI_COMPAT_ACCOUNTS_PATH
} else {
  Join-Path (Join-Path $CCursorHome "data") "openai-compat-accounts.json"
}

$Existing = Load-ExistingAccounts $DestPath
$NextAccounts = New-Object System.Collections.Generic.List[object]
$Replaced = $false

foreach ($item in @($Existing.accounts)) {
  $itemManagedBy = [string]$item.managedBy
  $itemLabel = [string]$item.label
  if ($itemManagedBy -eq $ManagedBy -or $itemLabel -eq $Label) {
    if (-not $Replaced) {
      $NextAccounts.Add([pscustomobject]$Account)
      $Replaced = $true
    }
  } else {
    $NextAccounts.Add($item)
  }
}

if (-not $Replaced) {
  $NextAccounts.Add([pscustomobject]$Account)
}

$Output = [ordered]@{
  codexConfig = $CodexConfigPath
  provider = $ProviderName
  model = $Model
  baseUrl = $BaseUrl
  keySource = $KeySource
  apiKey = "[hidden]"
  destination = $DestPath
  accountLabel = $Label
  wouldWrite = -not ($CheckOnly -or $DryRun)
}

if (-not $CheckOnly -and -not $DryRun) {
  $destDir = Split-Path -Parent $DestPath
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  if (Test-Path -LiteralPath $DestPath) {
    $backupPath = "$DestPath.bak.$((Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss"))"
    Copy-Item -LiteralPath $DestPath -Destination $backupPath -Force
    $Output.backup = $backupPath
  }
  [ordered]@{ accounts = @($NextAccounts) } |
    ConvertTo-Json -Depth 16 |
    Set-Content -LiteralPath $DestPath -Encoding UTF8
}

if ($Json) {
  $Output | ConvertTo-Json -Depth 8
} else {
  Write-Host "Codex config: $($Output.codexConfig)"
  Write-Host "Provider: $($Output.provider)"
  Write-Host "Model: $($Output.model)"
  Write-Host "Base URL: $($Output.baseUrl)"
  Write-Host "API key: [hidden] ($($Output.keySource))"
  Write-Host "CCursor account: $($Output.accountLabel)"
  Write-Host "Destination: $($Output.destination)"
  if ($Output.backup) {
    Write-Host "Backup: $($Output.backup)"
  }
  if ($CheckOnly -or $DryRun) {
    Write-Host "Mode: check only"
  } else {
    Write-Host "Synced: yes"
  }
}
