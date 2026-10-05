# Agent Vibes

English | [中文](README_zh.md)

[![CI](https://github.com/funny-vibes/agent-vibes/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/funny-vibes/agent-vibes/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com/)
[![Fastify](https://img.shields.io/badge/Fastify-HTTP%2F2-000000?logo=fastify&logoColor=white)](https://fastify.dev/)

<p align="center">
  <img src="apps/vscode-extension/resources/icon.png" alt="Agent Vibes logo" width="120" />
</p>

<p align="center">
  <strong>AI coding backends for Cursor</strong> — Connect
  <strong>Antigravity</strong>, <strong>Codex</strong>, and
  <strong>Kiro (AWS)</strong> to <strong>Cursor IDE</strong>,
  with support for <strong>Claude Code CLI</strong>.
</p>

## Overview

Agent Vibes connects Cursor to Antigravity, Codex, Claude-compatible, and Kiro backends
through an extension and a local bridge. It supports streaming conversations and
tool calls in Cursor Agent, with account management, model selection, and quota
views. Claude Code CLI is also supported.

**Clients** (front-end):

- **Cursor IDE** — Protocol-compatible ConnectRPC/gRPC implementation
- **Claude Code CLI** — Anthropic API

**Backends** (back-end):

- **Antigravity IDE** — Google Cloud Code API with protocol-compliant requests
- **Codex CLI** — OpenAI-compatible API for GPT and Codex models
- **Claude-Compatible API** — Anthropic-compatible `/v1/messages` with third-party keys
- **Kiro (AWS)** — AWS CodeWhisperer / Q Developer streaming endpoint via Builder ID, IdC, or social login

> **Disclaimer:** This project is for educational and research purposes only.
>
> Using this proxy may put your Antigravity account at risk of being banned. Proceed at your own discretion.

## Architecture

```text
+ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
│                          Clients                            │
│                                                             │
│  Claude Code CLI                Cursor IDE                  │
│  POST /v1/messages              POST /agent.v1.*            │
│  (Anthropic SSE)                (ConnectRPC/gRPC)           │
+ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
                              │
                              ▼
+ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
│                  Agent Vibes Proxy Server                   │
│                                                             │
│  Gemini           → Antigravity IDE (Cloud Code)            │
│  Claude           → Claude-Compatible API / Antigravity     │
│                     / Kiro (AWS CodeWhisperer)              │
│  GPT              → Codex CLI / OpenAI-compatible API       │
│                                                             │
+ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
```

## Features

| Area                             | Capabilities                                                                                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocols and clients            | Native support for Claude Code CLI and Cursor IDE; Claude Code CLI uses Anthropic API (SSE), while Cursor IDE uses a native ConnectRPC/gRPC agent channel implementation.                                                                                  |
| Cursor protocol implementation   | Direct implementation of the Cursor protocol (aligned with Cursor 3.15 message dumps), including the full streaming tool loop and tool protocol mapping; non-core RPCs use official passthrough.                                                           |
| Routing and backends             | Routes requests across Antigravity IDE, Claude-compatible API, Codex CLI, OpenAI-compatible API, and Kiro (AWS CodeWhisperer); covers Gemini, Claude, and GPT / O-series models with routing decisions based on backend availability and model capability. |
| Account pools and quotas         | Native worker / process pools, backend account state, cooldowns, model-level cooldowns, Google / Codex / Kiro quota views, rate-limit views, and multi-account rotation for availability.                                                                  |
| Extension and operations         | Dashboard, account management, OAuth / token import, manual account JSON editing, SSL certificate generation, Cursor direct-connection patching, legacy forwarding setup, logs, built-in diagnostics, usage / analytics, and update checks.                |
| Sessions, context, and toolchain | Session state management, context compaction / projection / summary, tool integrity handling, knowledge base support, semantic search, MCP tool integration, and related persistence.                                                                      |

## Quick Start

### Install Option 1: Prompt Install (Recommended for non-developers)

Copy the prompt below and send it to any LLM (ChatGPT / Claude / Gemini, etc.).
It will guide you through the entire installation and configuration process,
and fix issues by analyzing the source code and your environment:

```text
Please guide me through installing, configuring, and testing the Agent Vibes Cursor extension.
Answer in Chinese and prefer executable commands.

Follow these steps in order:

1. Environment check
   - Check my OS, architecture, Cursor version, Node.js version, and whether `cursor` CLI is available.
   - Confirm I am using a compatible Cursor version for this release.

2. Download and install the VSIX
   - Download the correct VSIX from GitHub Releases:
     <https://github.com/funny-vibes/agent-vibes/releases>
   - Install it with the correct command for my platform.

3. First launch and Cursor direct-connection patch
   - After installation, tell me to open or fully restart Cursor.
   - The extension should auto-start the local bridge and keep Cursor on the
     direct-connection patch by default (`agentVibes.trafficMode=cursorPatch`).
   - If the Dashboard reports that the patch still needs to be applied, use
     Dashboard > API > Cursor IDE Protocol or Command Palette > Agent Vibes:
     Apply Cursor Bridge Endpoint Patch.

4. Full Cursor restart
   - After the patch is applied, explicitly remind me that I must fully restart Cursor once before continuing.

5. Account configuration
   - Use Dashboard > Accounts as the primary path for account setup.
   - If needed, also use Command Palette sync commands or open the corresponding accounts JSON files for manual configuration.

6. Testing and verification
   - Verify the service is running.
   - Verify the Cursor direct-connection patch is active.
   - Verify at least one backend account is configured.
   - Use Dashboard > Diagnostics to run all checks and confirm each one passes:
     proxy bypass, SSL certificates, Cursor patch status, bridge health,
     end-to-end TLS (H2), and backend accounts.
   - Note: some Diagnostics tests may silently pass on platforms where the check is not
     actually implemented. Cross-check the test source code against the user's current
     platform and environment to determine if the result is trustworthy.

7. Troubleshooting
   - If any step fails, analyze the source code:
     <https://github.com/funny-vibes/agent-vibes>
   - Also analyze my current environment and provide a concrete fix.
   - Prefer minimal, executable repair steps.
   - Key areas to check based on required configuration steps:
     * Proxy environment: is a system proxy or TUN/VPN intercepting Cursor domain traffic?
       Analyze the forwarding scripts to understand how proxy bypass is handled.
     * SSL certificates: do the local CA and server cert exist, are they trusted by the OS,
       and do they cover the required domains?
     * Forwarding chain: is the full path (DNS → loopback → port relay → bridge) connected?
     * HTTP/2 TLS: does connecting to a Cursor domain resolve to a local address with valid
       cert and H2 negotiation?
     * The forwarding/proxy scripts may themselves have bugs — read the source to confirm.
   - Bridge log files are under the OS temp directory (`os.tmpdir()`):
     * macOS: `/private/var/folders/.../T/agent-vibes-bridge.log`
     * Linux: `/tmp/agent-vibes-bridge.log`
     * Windows: `%TEMP%\agent-vibes-bridge.log`
     * Detailed protocol logs: `<tmpdir>/agent-vibes-logs/`

8. Bug reporting
   - If the fix succeeds and we confirmed a real bug, help me prepare a GitHub issue with `gh issue create`.
   - Let me review and confirm before submitting.
```

### Install Option 2: Extension Install (Cursor IDE)

For the Cursor client side, a free account is enough. No paid Cursor plan is required.

One-click download + install from [GitHub Releases](https://github.com/funny-vibes/agent-vibes/releases):
Compatible Cursor version: `3.20.17`.

#### macOS Apple Silicon

```bash
# Download
curl -L -o agent-vibes-darwin-arm64-0.1.72.vsix https://github.com/funny-vibes/agent-vibes/releases/download/v0.1.72/agent-vibes-darwin-arm64-0.1.72.vsix

# Install
cursor --install-extension agent-vibes-darwin-arm64-0.1.72.vsix --force
```

#### macOS Intel

```bash
# Download
curl -L -o agent-vibes-darwin-x64-0.1.72.vsix https://github.com/funny-vibes/agent-vibes/releases/download/v0.1.72/agent-vibes-darwin-x64-0.1.72.vsix

# Install
cursor --install-extension agent-vibes-darwin-x64-0.1.72.vsix --force
```

#### Linux x64

```bash
# Download
curl -L -o agent-vibes-linux-x64-0.1.72.vsix https://github.com/funny-vibes/agent-vibes/releases/download/v0.1.72/agent-vibes-linux-x64-0.1.72.vsix

# Install
cursor --install-extension agent-vibes-linux-x64-0.1.72.vsix --force
```

#### Windows x64

```powershell
# Download
Invoke-WebRequest -Uri "https://github.com/funny-vibes/agent-vibes/releases/download/v0.1.72/agent-vibes-win32-x64-0.1.72.vsix" -OutFile "agent-vibes-win32-x64-0.1.72.vsix"

# Install
cursor --install-extension agent-vibes-win32-x64-0.1.72.vsix --force
```

Restart Cursor after installation.
The extension auto-starts the proxy server (the bridge only — it does not
modify Cursor automatically) and guides you through first-run setup
(SSL certificates and account sync from the Command Palette). To drive Cursor
IDE through the bridge, apply the Cursor direct-connection patch from
Dashboard > API > Cursor IDE Protocol.

### Install Option 3: From Source (All Platforms)

> **Note:** Primary development and testing is done on macOS.
> Linux and Windows support is implemented but not fully tested —
> scripts may have edge-case bugs on those platforms. PRs welcome!

```bash
git clone https://github.com/funny-vibes/agent-vibes.git
cd agent-vibes
npm install && npm run build
npm link                          # makes `agent-vibes` available globally
```

Generate SSL certificates:

```bash
# Install mkcert first: https://github.com/FiloSottile/mkcert#installation
mkcert -install
agent-vibes cert
```

Cursor direct connection — one-time setup:

```bash
agent-vibes                      # Start the bridge
# Then apply "Agent Vibes: Apply Cursor Bridge Endpoint Patch" from Cursor.
```

### Choose One Upstream Source

Antigravity ([Antigravity IDE](https://antigravity.google) or [Antigravity Manager](https://github.com/lbjlaq/Antigravity-Manager)):

```bash
agent-vibes sync --ide       # from Antigravity IDE
agent-vibes sync --tools     # from Antigravity Manager
```

Claude Code third-party config:

```bash
agent-vibes sync --claude
```

Codex:

```bash
codex --login
agent-vibes sync --codex
```

Kiro (AWS Builder ID / IdC / Kiro IDE):

- **Easiest:** open Dashboard → Accounts → Kiro → Add account → **Builder ID** tab.
  The bridge starts an OAuth device flow, opens your browser, and writes the
  resulting tokens to `~/.agent-vibes/data/kiro-accounts.json`.
- **From an existing Kiro IDE / AWS CLI login:** Command Palette →
  `Agent Vibes: Sync Kiro IDE Credentials`. The bridge scans
  `~/.aws/sso/cache/*.json` and Kiro IDE's
  `globalStorage/kiro.kiroagent/kiro-cache/` and imports any usable tokens.
- **Manual paste:** Dashboard → Accounts → Kiro → Add account → **Token** tab.
  Paste any of: an SSO cache JSON, a `kiro-auth-token.json`, or the
  `kiro-accounts.json` shape itself.

### Extension Commands

The extension keeps a small set of installation / configuration commands in the Command Palette, while the Dashboard handles most runtime management and detailed operations.

#### Installation / configuration commands

| Step | Command Palette title                             | Command ID                                  | Purpose                                                                                                         |
| ---- | ------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1    | Agent Vibes: Open Dashboard                       | `agentVibes.openDashboard`                  | Open the main Dashboard and review setup status.                                                                |
| 2    | Agent Vibes: Generate SSL Certificates            | `agentVibes.generateCert`                   | Generate local certificates required for HTTPS interception.                                                    |
| 3    | Dashboard → Accounts                              | _primary path_                              | Configure accounts in the Accounts tab, including add/edit flows, OAuth, and token import.                      |
| 3    | Agent Vibes: Sync Antigravity IDE Credentials     | `agentVibes.syncAntigravityIDE`             | Import credentials from Antigravity IDE.                                                                        |
| 3    | Agent Vibes: Sync Antigravity Tool Credentials    | `agentVibes.syncAntigravityTools`           | Import credentials from Antigravity Manager / tools.                                                            |
| 3    | Agent Vibes: Sync Claude Credentials              | `agentVibes.syncClaude`                     | Sync Claude-compatible credentials into Agent Vibes.                                                            |
| 3    | Agent Vibes: Sync Codex Credentials               | `agentVibes.syncCodex`                      | Sync Codex credentials into Agent Vibes.                                                                        |
| 3    | Agent Vibes: Open OpenAI-Compatible Accounts JSON | `agentVibes.openOpenAICompatAccounts`       | Open `openai-compat-accounts.json` for manual configuration.                                                    |
| 3    | Agent Vibes: Open Claude API Accounts JSON        | `agentVibes.openClaudeApiAccounts`          | Open `claude-api-accounts.json` for manual configuration.                                                       |
| 3    | Agent Vibes: Open Kiro Accounts JSON              | `agentVibes.openKiroAccounts`               | Open `kiro-accounts.json` for manual configuration.                                                             |
| 3    | Agent Vibes: Sync Kiro IDE Credentials            | `agentVibes.syncKiroIDE`                    | Import Kiro / AWS SSO tokens cached locally by Kiro IDE or AWS CLI.                                             |
| 4    | Agent Vibes: Start Server                         | `agentVibes.startServer`                    | Start the local bridge only (no forwarding) after certs and one account are ready.                              |
| 5    | Agent Vibes: Apply Cursor Bridge Endpoint Patch   | `agentVibes.applyCursorBridgeEndpointPatch` | Patch Cursor account, model, and agent traffic to connect to the local bridge without hosts or port forwarding. |
| 6    | Agent Vibes: Enable Port Forwarding               | `agentVibes.enableForwarding`               | Legacy fallback for local forwarding.                                                                           |
| 6    | Agent Vibes: Disable Port Forwarding              | `agentVibes.disableForwarding`              | Disable legacy local forwarding.                                                                                |
| 6    | Agent Vibes: Port Forwarding Status               | `agentVibes.forwardingStatus`               | Check legacy forwarding and hosts setup status.                                                                 |
| 7    | Agent Vibes: Edit Configuration                   | `agentVibes.openConfig`                     | Open `agentVibes` settings in Cursor.                                                                           |
| 8    | Agent Vibes: Check Extension Updates              | `agentVibes.checkExtensionUpdates`          | Check GitHub Releases for a newer VSIX.                                                                         |

#### Dashboard tabs

| Tab             | Purpose                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------- |
| **Overview**    | Setup status, quick actions (start/stop/restart), backend summary                         |
| **API**         | Exposed HTTP endpoints; Cursor direct-connection patch, Claude Code CLI wiring, copy/test |
| **Accounts**    | Account management, OAuth, token import, pool and quota details                           |
| **Analytics**   | Usage summary and backend/runtime statistics                                              |
| **Settings**    | Extension settings and path overrides                                                     |
| **Diagnostics** | Built-in checks                                                                           |
| **Logs**        | Bridge logs and debug toggles                                                             |

### Daily Use

#### Cursor IDE

- Open Cursor; the extension will auto-start the local bridge (start only).
- To drive Cursor IDE through the bridge, keep Settings > Bridge > Cursor Connection
  on Cursor Direct Patch. If the API tab reports that the patch is missing,
  apply it from Dashboard > API > Cursor IDE Protocol.
  Skip this if you only use the bridge as a relay for Claude Code CLI / API clients.
- To confirm runtime status, open the Dashboard and check Overview, API, Accounts, Logs, and Diagnostics.
- Send a real request in Cursor to verify that account setup, routing, and tool calls are working.

#### Claude Code CLI (optional)

If you also want to connect Claude Code CLI to the same local proxy, use:

```bash
agent-vibes                  # start proxy
```

In another terminal:

```bash
export ANTHROPIC_BASE_URL=https://localhost:8000
claude
```

> **Tip:** Add `export ANTHROPIC_BASE_URL=https://localhost:8000` to your shell profile to make it persistent.

## Backend Configuration Reference

### 1. Antigravity

Use for Antigravity / Google Cloud Code access.

Configuration:

```bash
agent-vibes sync --ide
agent-vibes sync --tools
```

Behavior:

- Credentials are synced into `~/.agent-vibes/data/antigravity-accounts.json`.
- Supports multi-account rotation.
- **Claude model routing:** When Claude Code CLI routes through the Google backend,
  only **Opus** models use the Claude-through-Google (Cloud Code) path.
  Non-Opus Claude models (Sonnet, Haiku, etc.) are automatically redirected to
  **Gemini 3.1 Pro High**, preserving Claude quota for complex agentic tasks.
- **Quota fallback (opt-in):** When all Google Cloud Code accounts are quota-exhausted
  and the cooldown exceeds the max wait threshold, the system can automatically fall back
  to a configured Gemini model instead of returning a 429 error.
  Configure by adding `"quotaFallbackModel"` to the top level of `antigravity-accounts.json`:

```json
{
  "quotaFallbackModel": "gemini-3.1-pro-high",
  "accounts": [...]
}
```

Set `"quotaFallbackModel"` to the desired fallback model ID, or remove the field entirely to disable (default: disabled — returns 429 as before).

### 2. GPT

Use for GPT models.

Configuration:

- Codex:

```bash
codex --login
agent-vibes sync --codex
```

- OpenAI-compatible file: `~/.agent-vibes/data/openai-compat-accounts.json`

```json
{
  "accounts": [
    {
      "label": "provider-1",
      "baseUrl": "https://a.example.com/v1",
      "apiKey": "sk-xxx"
    },
    {
      "label": "provider-2",
      "baseUrl": "https://b.example.com/v1",
      "apiKey": "sk-yyy",
      "proxyUrl": "http://127.0.0.1:7897",
      "preferResponsesApi": true,
      "maxContextTokens": 200000
    }
  ]
}
```

Behavior:

- Codex and OpenAI-compatible both support multi-account rotation.
- If both OpenAI-compatible and Codex are configured, GPT requests go to OpenAI-compatible first.
- When quota is exhausted, the system automatically switches to the next available account.
- `proxyUrl` routes requests through the specified HTTP/SOCKS proxy for that account.
- `preferResponsesApi=true` uses the OpenAI Responses API (`/v1/responses`) instead of Chat Completions.
- `maxContextTokens` sets a per-account input/context cap. When multiple OpenAI-compatible accounts are eligible, the bridge clamps to the
  smallest configured cap among the currently available accounts so rotation and failover stay within the provider window.

### 3. Claude API

Use for third-party Claude-compatible APIs.

Configuration:

- `agent-vibes sync --claude` reads `~/.claude/settings.json` and writes or updates a managed `claude-code-sync` entry in `~/.agent-vibes/data/claude-api-accounts.json`.
  The managed entry mirrors the current source settings; if the source no longer declares explicit model IDs, stale managed `models` are removed so
  dynamic discovery can take effect.
- Or edit `~/.agent-vibes/data/claude-api-accounts.json` manually:

```json
{
  "forceModelPrefix": false,
  "accounts": [
    {
      "label": "anthropic-official",
      "apiKey": "sk-ant-xxx",
      "baseUrl": "https://api.anthropic.com"
    },
    {
      "label": "third-party",
      "apiKey": "sk-third-yyy",
      "baseUrl": "https://claude.example.com",
      "maxContextTokens": 200000,
      "stripThinking": true,
      "proxyUrl": "socks5://127.0.0.1:1080",
      "prefix": "team-a",
      "priority": 10,
      "headers": {
        "X-Custom-Header": "value"
      },
      "excludedModels": ["claude-3-*"],
      "models": [
        {
          "name": "claude-opus-4-6",
          "alias": "claude-4.6-opus-thinking"
        }
      ]
    }
  ]
}
```

Behavior:

- Unprefixed Claude models prefer the Claude API backend when a matching account exists, and fall back to Antigravity/Google Cloud Code.
- `forceModelPrefix=false` means a prefixed account exposes both `claude-sonnet-latest` and `team-a/claude-sonnet-latest`.
- `forceModelPrefix=true` requires explicit prefixed requests for prefixed accounts.
- Prefixed models such as `team-a/claude-sonnet-latest` only route to the matching Claude API account prefix.
- If `models` is omitted, the proxy first tries to discover models from upstream via `GET /v1/models`;
  if discovery is unavailable, it falls back to the built-in defaults and still allows Claude-family passthrough.
- If `models` is configured, the explicit mappings take precedence and automatic discovery is skipped for that account.
- `stripThinking=true` removes Anthropic thinking fields before forwarding for providers that only support the base Claude model name.
- `excludedModels` supports case-insensitive wildcard patterns such as `claude-3-*`, `*-thinking`, or `*haiku*`.
- `maxContextTokens` sets a per-account input/context cap. When multiple Claude API accounts can serve the same model, the bridge clamps to the smallest
  configured cap among the currently available candidates so retries do not overflow a smaller provider window.
- Official `api.anthropic.com` accounts use `x-api-key`; third-party endpoints use `Authorization: Bearer ...`.

### 4. Kiro (AWS CodeWhisperer / Q Developer)

Use for Claude Sonnet / Opus / Haiku via AWS Builder ID, IAM Identity
Center (IdC), or social-login Kiro accounts.

Configuration (any of):

- **Builder ID OAuth (recommended):** Dashboard → Accounts → Kiro → Add → **Builder ID**.
- **Sync local cache:** Command Palette → `Agent Vibes: Sync Kiro IDE Credentials`. Imports tokens from `~/.aws/sso/cache/` and Kiro IDE's `globalStorage`.
- **Manual paste:** Dashboard → Accounts → Kiro → Add → **Token**.

Behavior:

- `authMethod`: `"idc"` (Builder ID / IdC, needs `clientId` + `clientSecret`) or `"social"` (GitHub / Google).
- AWS does not return Anthropic cache token counts; the bridge simulates `cache_read_input_tokens` / `cache_creation_input_tokens` client-side.
- Refreshed tokens are written back to `~/.agent-vibes/data/kiro-accounts.json` and re-refreshed every 15 minutes in the background.

## SSH Remote Development

When Cursor IDE is connected to a remote machine over SSH (the workspace
lives on the remote host, not on your laptop), agent traffic is generated
by the remote-side `cursor-server` process. The local hosts file /
loopback redirect that powers Agent Vibes on a regular workstation cannot
intercept that traffic — yet most users have no `sudo` on the remote
host to set up a second bridge there.

To handle this case, the bridge ships an HTTP forward proxy that lets
the remote `cursor-server` route Cursor traffic back to the bridge
running on your laptop, **without root on the remote**.

### How it works

```text
┌─ Local laptop (Cursor IDE host) ──────────────────────────┐
│                                                            │
│  Bridge process                                            │
│   ├─ HTTPS server   127.0.0.1:2026   (existing)            │
│   └─ Forward proxy  127.0.0.1:18080  (new, loopback only)  │
│         │                                                   │
│         │  CONNECT api2.cursor.sh:443                       │
│         ▼                                                   │
│         splice → 127.0.0.1:2026  (bridge handles TLS)       │
└────────┬───────────────────────────────────────────────────┘
         │   ssh -R 18080:127.0.0.1:18080 user@remote
         ▼
┌─ Remote SSH host (no sudo required) ──────────────────────┐
│                                                            │
│  HTTPS_PROXY=http://127.0.0.1:18080                        │
│  cursor-server / agent runtime                             │
│         │ HTTPS api2.cursor.sh:443                          │
│         ▼                                                   │
│  127.0.0.1:18080  (reverse-tunneled to your laptop)         │
└────────────────────────────────────────────────────────────┘
```

For Cursor agent domains the proxy splices the TLS connection straight
to the local bridge. For any other host the proxy behaves like a normal
HTTPS proxy and connects to the real upstream, so the remote shell can
keep using `HTTPS_PROXY` for everything.

### Setup

Configure on your local laptop (one-time):

1. Make sure the bridge is running. On startup the banner now shows:

   ```text
   ▸ SSH proxy http://127.0.0.1:18080
   ```

   The proxy binds to loopback only and is opt-out via
   `FORWARD_PROXY_ENABLED=false` or `FORWARD_PROXY_PORT=0`.

2. Open the SSH connection with a reverse tunnel that exposes port 18080
   on the remote host:

   ```bash
   ssh -R 18080:127.0.0.1:18080 user@remote-host
   ```

   Or add it to `~/.ssh/config`:

   ```sshconfig
   Host my-remote
     HostName remote-host
     User myuser
     RemoteForward 18080 127.0.0.1:18080
   ```

Configure on the remote host (each shell, no sudo):

1. Trust the bridge CA so HTTPS verification passes inside Node-based
   agents. Copy the CA from your laptop (`~/.agent-vibes/certs/ca.pem`)
   to the remote host once and point Node to it:

   ```bash
   # on the remote host
   mkdir -p ~/.agent-vibes/certs
   # copy ca.pem from your laptop, e.g. via scp from your laptop:
   #   scp ~/.agent-vibes/certs/ca.pem \
   #       user@remote-host:~/.agent-vibes/certs/ca.pem
   export NODE_EXTRA_CA_CERTS=$HOME/.agent-vibes/certs/ca.pem
   ```

2. Point the agent runtime at the proxy and start `cursor-server`:

   ```bash
   export HTTPS_PROXY=http://127.0.0.1:18080
   export HTTP_PROXY=http://127.0.0.1:18080
   # then launch / restart cursor-server in the same shell, e.g.
   #   ~/.cursor-server/bin/cursor-server &
   ```

   Persist by adding the same exports to `~/.bashrc` / `~/.zshrc` /
   `~/.profile`.

### Troubleshooting

- `curl -x http://127.0.0.1:18080 https://api2.cursor.sh/health` on the
  remote host should return `{"status":"ok",...}`. If it hangs, check
  that `ssh -R` is active and that `127.0.0.1:18080` on the remote
  really forwards back to your laptop.
- `tls: x509: certificate signed by unknown authority` —
  `NODE_EXTRA_CA_CERTS` was not set or points at a CA that does not
  match the bridge certificates. Re-copy `ca.pem`.
- The remote agent runtime ignores `HTTPS_PROXY` — confirm the env vars
  are exported in the same shell that starts `cursor-server`. Some
  launchers (`systemd --user`, tmux panes that pre-date the export)
  keep stale env.
- The proxy refuses the connection — verify the bridge is running
  (`▸ SSH proxy ...` banner line) and that no other process is listening
  on `127.0.0.1:18080` on your laptop.

## FAQ / Troubleshooting

### `agent-vibes forward on` does not take effect when a system-wide TUN proxy is enabled

Symptom: after running `npm run cursor:forward:on` (or `agent-vibes forward on`),
Cursor still cannot reach the bridge, Diagnostics report DNS/forwarding failures,
or `curl https://api2.cursor.sh/health` hangs.

Root cause: a system proxy in **TUN mode** (Clash Verge, Mihomo, V2RayN TUN,
sing-box, etc.) intercepts traffic at the network layer **before** the local
hosts file rewrite or loopback redirect can take effect. Even when proxy rules
declare `127.0.0.0/8 -> DIRECT`, the upstream resolver may already have hijacked
`localhost` / Cursor domains into a fake-ip range, so the IP-CIDR rule never
matches.

Fix (using Clash Verge Rev as an example — other TUN clients have equivalent
settings):

1. **Bypass loopback and private ranges from the TUN interface.** Add to the
   global merge / override config so it survives subscription updates:

   ```yaml
   tun:
     enable: true
     stack: system
     auto-route: true
     auto-detect-interface: true
     route-exclude-address:
       - 127.0.0.0/8
       - 192.168.0.0/16
       - 10.0.0.0/8
       - 172.16.0.0/12
   ```

2. **Exclude local domains from fake-ip resolution** so DNS hijacking does
   not rewrite `localhost` into the fake-ip pool:

   ```yaml
   dns:
     fake-ip-filter:
       - "localhost"
       - "*.localhost"
       - "*.local"
       - "*.cursor.sh"
   ```

3. **Add explicit DIRECT rules at the top of the rule list** so they take
   priority over `MATCH,PROXY`:

   ```yaml
   rules:
     - DOMAIN,localhost,DIRECT
     - DOMAIN-SUFFIX,.local,DIRECT
     - DOMAIN-SUFFIX,cursor.sh,DIRECT
     - IP-CIDR,127.0.0.0/8,DIRECT
     # ... existing rules
   ```

4. Reload the proxy configuration, then re-run `npm run cursor:forward:on`.

If you only need a quick test without changing the proxy config, switching
the TUN client to **Rule** mode (or temporarily disabling TUN) is enough to
verify whether TUN is the cause.

## Project Structure

```text
agent-vibes/
├── bin/
│   └── agent-vibes                            # CLI entry point
├── apps/
│   └── protocol-bridge/                         # Main proxy server (NestJS + Fastify)
│       ├── sea/                               # SEA packaging scripts and entry points
│       ├── src/
│       │   ├── main.ts                        # App bootstrap (Fastify adapter, CORS, Swagger)
│       │   ├── app.module.ts                  # NestJS root module
│       │   ├── health.controller.ts           # Health check + pool status
│       │   ├── usage.ts                       # UsageStatsModule + UsageStatsService
│       │   │
│       │   ├── protocol/                      # ← Protocol adapters
│       │   │   ├── cursor/                    #   CursorModule — Cursor IDE (ConnectRPC)
│       │   │   │   ├── controllers/
│       │   │   │   ├── session/
│       │   │   │   ├── tools/
│       │   │   │   ├── cursor-connect-stream.service.ts
│       │   │   │   ├── cursor-grpc.service.ts
│       │   │   │   └── ...                    #   (auth, knowledge base, model protocol, etc.)
│       │   │   └── anthropic/                 #   AnthropicModule — Claude Code CLI
│       │   │       ├── anthropic.module.ts
│       │   │       ├── tokenizer.service.ts   #   Local /count_tokens fallback
│       │   │       ├── messages.controller.ts #   POST /v1/messages
│       │   │       ├── messages.service.ts
│       │   │       └── dto/                   #   Request DTOs
│       │   │
│       │   ├── context/                       # ← Conversation context
│       │   │   ├── context.module.ts          #   ContextModule
│       │   │   ├── context-manager.service.ts
│       │   │   ├── context-compaction.service.ts
│       │   │   ├── token-counter.service.ts
│       │   │   └── tool-protocol-integrity.ts
│       │   │
│       │   ├── llm/                           # ← Provider implementations + shared routing
│       │   │   ├── anthropic/                 #   AnthropicApiModule — Claude-compatible key pool
│       │   │   ├── aws/                       #   KiroModule — AWS CodeWhisperer / Kiro IDE backend
│       │   │   ├── google/                    #   GoogleModule — Cloud Code API + Go worker pool
│       │   │   ├── openai/                    #   Codex + OpenAI-compatible providers
│       │   │   └── shared/                    #   Model routing, registry, backend utilities
│       │   │
│       │   ├── persistence/                   # SQLite persistence + migrations
│       │   ├── shared/                        # Paths, guards, request hooks, shared types
│       │   └── gen/                           # Auto-generated protobuf (DO NOT edit)
│       │
│       ├── proto/                             # Protobuf definitions (protocol-compatible, local only)
│       └── data/                              # Per-backend credential pools (JSON)
├── packages/
│   ├── eslint-config/                         # Shared ESLint config
│   ├── prettier-config/                       # Shared Prettier config
│   └── typescript-config/                     # Shared TypeScript base config
└── scripts/
    ├── lib/                                   # Shared cross-platform utilities
    ├── accounts/                              # Account credential sync helpers
    ├── proxy/                                 # Port forwarding (TCP relay/iptables/netsh)
    └── capture/                               # Traffic capture and dump inspection
```

## API Endpoints

The local bridge uses port `2026` by default.

| Path                                 | Method               | Purpose                                          |
| ------------------------------------ | -------------------- | ------------------------------------------------ |
| `/agent.v1.AgentService/Run`         | POST                 | Cursor Agent conversations and tool calls        |
| `/v1/messages`                       | POST                 | Claude Code / Anthropic-compatible conversations |
| `/v1/messages/count_tokens`          | POST                 | Request token counting                           |
| `/v1/chat/completions`               | POST                 | OpenAI Chat-compatible conversations             |
| `/v1/responses`                      | POST                 | OpenAI Responses-compatible conversations        |
| `/v1/web-gpt/chat/completions`       | POST                 | GPT Web conversations                            |
| `/v1/web-gpt/responses`              | POST                 | GPT Web Responses                                |
| `/v1/images/generations`             | POST                 | Image generation                                 |
| `/v1/images/edits`                   | POST                 | Reference-image editing                          |
| `/v1/images/jobs/{id}`               | GET                  | Image job status and results                     |
| `/v1/realtime/calls`                 | POST                 | Create a voice connection                        |
| `/v1/realtime/calls/{id}`            | GET / PATCH / DELETE | Voice session status, binding, and cleanup       |
| `/v1/realtime/files/{fileId}`        | GET                  | Download Web voice-generated files               |
| `/v1/models`, `/v1/anthropic/models` | GET                  | Model lists                                      |
| `/v1/web-gpt/models`                 | GET                  | GPT Web model list                               |
| `/health`                            | GET                  | Service health check                             |

## Tech Stack

| Component   | Technology                                         |
| ----------- | -------------------------------------------------- |
| Runtime     | Node.js ≥ 24                                       |
| Framework   | NestJS 11 + Fastify (HTTP/2 + HTTP/1.1)            |
| Language    | TypeScript (ES2021, CommonJS)                      |
| Protobuf    | `@bufbuild/protobuf` v2 + `@connectrpc/connect` v2 |
| Monorepo    | Turborepo + npm workspaces                         |
| Linting     | ESLint 9 + Prettier 3 + markdownlint               |
| Git Hooks   | Husky + lint-staged + commitlint                   |
| Testing     | Jest 30 + ts-jest                                  |
| Database    | better-sqlite3 (local KV store)                    |
| Tokenizer   | tiktoken                                           |
| HTTP Client | Native `fetch` + SOCKS/HTTP proxy agents           |
| Platform    | macOS, Linux, Windows                              |

## CI/CD

- **`ci.yml`** — Quality gate on push/PR
  - Runs `lint`, `types`, `build`, `test`
- **`deploy-proxy.yml`** — Auto-deploy on push to `main` (only `apps/protocol-bridge/**` changes)
  - Build → SCP to server → restart systemd service
  - Production uses Let's Encrypt SSL for HTTP/2
- **`claude.yml`** — Claude Code automation
  - Issue handling: `claude` label → auto-implement → create PR to `dev`
  - PR review: auto-review → merge after approval
  - Interactive: `@claude` or `@c` in comments

### Branch Strategy

| Branch             | Purpose                          |
| ------------------ | -------------------------------- |
| `dev`              | Development (default PR target)  |
| `main`             | Production (auto-deploy on push) |
| `issue-{N}-{slug}` | Feature branches (created by CI) |

## Community

Join the discussion and share your thoughts about Agent Vibes on [LINUX DO](https://linux.do/t/topic/1814066), or feel free to report bugs and feedback on
[GitHub Issues](https://github.com/funny-vibes/agent-vibes/issues).

## Contributing

Found a bug or have an idea? Use our [issue templates](https://github.com/funny-vibes/agent-vibes/issues/new/choose) to report bugs or request features.

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening PRs.

Pre-commit hooks automatically run lint + format checks.

---

Happy vibing!

## License

[MIT](LICENSE) © 2025-2026 recronin
