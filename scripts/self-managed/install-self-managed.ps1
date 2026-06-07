param(
  [string]$ApiKey = $env:SKYLINK_API_KEY,
  [string]$BaseUrl = $(if ($env:OPENAI_COMPAT_BASE_URL) { $env:OPENAI_COMPAT_BASE_URL } elseif ($env:SKYLINK_BASE_URL) { $env:SKYLINK_BASE_URL } else { "https://skylink-gateway.com/api/v1" }),
  [ValidateSet("auto", "always", "never")]
  [string]$ResponsesMode = $(if ($env:OPENAI_COMPAT_USE_RESPONSES_API) { $env:OPENAI_COMPAT_USE_RESPONSES_API } else { "always" }),
  [string]$ServiceTier = $(if ($env:OPENAI_COMPAT_SERVICE_TIER) { $env:OPENAI_COMPAT_SERVICE_TIER } else { "priority" }),
  [int]$MaxContextTokens = $(if ($env:OPENAI_COMPAT_MAX_CONTEXT_TOKENS) { [int]$env:OPENAI_COMPAT_MAX_CONTEXT_TOKENS } else { 200000 }),
  [switch]$NoFast,
  [switch]$SkipBuild,
  [switch]$SkipCert,
  [switch]$SkipRoute
)

$ErrorActionPreference = "Stop"

if (-not $ApiKey) {
  throw "Missing API key. Set SKYLINK_API_KEY or pass -ApiKey."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node is required. Install Node.js 24+ first."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required. Install npm 11+ first."
}

$root = Resolve-Path (Join-Path $PSScriptRoot "../..")
Set-Location $root

npm install

$argsList = @(
  "self-managed",
  "install",
  "--base-url",
  $BaseUrl,
  "--api-key",
  $ApiKey,
  "--responses-mode",
  $ResponsesMode,
  "--prefer-responses",
  "--max-context-tokens",
  "$MaxContextTokens"
)

if ($NoFast) {
  $argsList += "--no-fast"
} elseif ($ServiceTier) {
  $argsList += @("--service-tier", $ServiceTier)
}
if ($SkipBuild) { $argsList += "--skip-build" }
if ($SkipCert) { $argsList += "--skip-cert" }
if ($SkipRoute) { $argsList += "--skip-route" }

node .\bin\agent-vibes @argsList

Write-Host ""
Write-Host "Done."
Write-Host "Fully quit and restart Cursor, then select gpt-5.5 xHigh in the Agent panel."
Write-Host "Check status with:"
Write-Host "  node .\bin\agent-vibes self-managed status"
