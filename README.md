# Agent Vibes

English | [中文](README_zh.md)

> [!WARNING]
> The **dev** branch is currently undergoing a major refactoring based on
> the **Claude Code** source architecture, along with extensive testing.
> **Not recommended for production coding tasks.**
> A stable LTS release will be published once testing is complete.
> Versions prior to **Agent Vibes v0.1.10 (Cursor 3.0.16)** contain
> numerous known defects. Please update to v0.1.10 or later.

**Unified Agent Gateway** — Use **Antigravity** and **Codex** AI backends with **Claude Code CLI** and **Cursor IDE**.

[![CI](https://github.com/funny-vibes/agent-vibes/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/funny-vibes/agent-vibes/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com/)
[![Fastify](https://img.shields.io/badge/Fastify-HTTP%2F2-000000?logo=fastify&logoColor=white)](https://fastify.dev/)

## Overview

Agent Vibes is a proxy server that connects AI coding clients to AI backends through protocol translation.

**Clients** (front-end):

- **Claude Code CLI** — Anthropic Messages API
- **Cursor IDE** — Protocol-compatible ConnectRPC/gRPC implementation

**Backends** (back-end):

- **Antigravity IDE** — Google Cloud Code API with protocol-compliant requests
- **Codex CLI** — OpenAI-compatible API for GPT and Codex models
- **Claude-Compatible API** — Anthropic-compatible `/v1/messages` with third-party keys

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
│  GPT              → Codex CLI / OpenAI-compatible API       │
│                                                             │
+ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
```

## Features

| Client          | Protocol                              | Backend                                           | Models              |
| --------------- | ------------------------------------- | ------------------------------------------------- | ------------------- |
| Claude Code CLI | Anthropic Messages API (SSE)          | Antigravity IDE, Claude-Compatible API, Codex CLI | Gemini, Claude, GPT |
| Cursor IDE      | ConnectRPC/gRPC (protocol-compatible) | Antigravity IDE, Claude-Compatible API, Codex CLI | Gemini, Claude, GPT |

## Compared with [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) is the closest reference project for this repo, but the focus is different.
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) is primarily API-first and CLI-oriented. Agent Vibes puts its main weight on
native client compatibility for Cursor and native upstream fidelity for Antigravity.

- **Cursor:** instead of stopping at OpenAI/Claude-compatible endpoints,
  Agent Vibes implements Cursor's native ConnectRPC/gRPC agent channel
  with protocol-compatible protobuf definitions for interoperability,
  and implements the streaming tool loop directly.
- **Antigravity:** this repo's main Antigravity path is a newer
  worker-native approach, built around running Antigravity's own runtime
  and modules so Cloud Code requests stay protocol-compliant,
  with quota-aware worker rotation around that model.
- **Credits:** this project ports and adapts code from many open-source projects.
  The Claude Code CLI and Codex CLI integrations are primarily based on
  [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), rebuilt in a
  TypeScript/NestJS architecture. The Cursor native protocol layer and
  Antigravity worker pool are original implementations.

## Quick Start

### Install Option 1: Prompt Install (Recommended)

Copy the prompt below and send it to any LLM (ChatGPT / Claude / Gemini, etc.).
It will guide you through installation and configuration, and fix issues by analyzing the source and your environment:

> Please guide me through installing, configuring, and testing
> the Agent Vibes Cursor extension. The extension is installed via VSIX
> from GitHub Releases. If any step fails, analyze the source code
> (<https://github.com/funny-vibes/agent-vibes>) and my current environment
> and provide a fix. Answer in Chinese, prefer executable commands.
> If the fix succeeds and a bug was found, help me submit an issue to
> funny-vibes/agent-vibes using `gh issue create`,
> and let me confirm before submitting.

### Install Option 2: Extension Install (Cursor IDE)

For the Cursor client side, a free account is enough. No paid Cursor plan is required.

One-click download + install from [GitHub Releases](https://github.com/funny-vibes/agent-vibes/releases):
Compatible Cursor version: `3.0.16`.

#### macOS Apple Silicon

```bash
# Download
curl -L -o agent-vibes-darwin-arm64-0.1.10.vsix https://github.com/funny-vibes/agent-vibes/releases/download/v0.1.10/agent-vibes-darwin-arm64-0.1.10.vsix

# Install
cursor --install-extension agent-vibes-darwin-arm64-0.1.10.vsix --force
```

#### macOS Intel

```bash
# Download
curl -L -o agent-vibes-darwin-x64-0.1.10.vsix https://github.com/funny-vibes/agent-vibes/releases/download/v0.1.10/agent-vibes-darwin-x64-0.1.10.vsix

# Install
cursor --install-extension agent-vibes-darwin-x64-0.1.10.vsix --force
```

#### Linux x64

```bash
# Download
curl -L -o agent-vibes-linux-x64-0.1.10.vsix https://github.com/funny-vibes/agent-vibes/releases/download/v0.1.10/agent-vibes-linux-x64-0.1.10.vsix

# Install
cursor --install-extension agent-vibes-linux-x64-0.1.10.vsix --force
```

#### Windows x64

```powershell
# Download
Invoke-WebRequest -Uri "https://github.com/funny-vibes/agent-vibes/releases/download/v0.1.10/agent-vibes-win32-x64-0.1.10.vsix" -OutFile "agent-vibes-win32-x64-0.1.10.vsix"

# Install
cursor --install-extension agent-vibes-win32-x64-0.1.10.vsix --force
```

Restart Cursor after installation.
The extension auto-starts the proxy server and guides you through first-run setup
(SSL certificates, account sync, network forwarding — all from the Command Palette).

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

Cursor requires HTTPS interception — one-time setup:

```bash
agent-vibes forward hosts        # Add DNS redirect to hosts file
agent-vibes forward on           # Enable port forwarding
agent-vibes                      # Start the proxy
agent-vibes forward status       # Verify everything is working
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

### Daily Use

#### Claude Code CLI

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

## Project Structure

```text
agent-vibes/
├── bin/
│   └── agent-vibes                            # CLI entry point
├── apps/
│   └── protocol-bridge/                         # Main proxy server (NestJS + Fastify)
│       ├── src/
│       │   ├── main.ts                        # App bootstrap (Fastify adapter, CORS, Swagger)
│       │   ├── app.module.ts                  # NestJS root module
│       │   ├── health.controller.ts           # Health check + pool status
│       │   │
│       │   ├── protocol/                      # ← Protocol adapters
│       │   │   ├── cursor/                    #   CursorModule — Cursor IDE (ConnectRPC)
│       │   │   │   ├── cursor.module.ts
│       │   │   │   ├── cursor-adapter.controller.ts
│       │   │   │   ├── cursor-connect-stream.service.ts
│       │   │   │   ├── cursor-grpc.service.ts
│       │   │   │   └── ...                    #   (auth, parser, session, etc.)
│       │   │   └── anthropic/                 #   AnthropicModule — Claude Code CLI
│       │   │       ├── anthropic.module.ts
│       │   │       ├── messages.controller.ts  #   POST /v1/messages
│       │   │       ├── messages.service.ts
│       │   │       └── dto/                   #   Request DTOs
│       │   │
│       │   ├── context/                       # ← Conversation context
│       │   │   ├── history.module.ts          #   HistoryModule
│       │   │   ├── tokenizer.module.ts        #   TokenizerModule
│       │   │   ├── conversation-truncator.service.ts
│       │   │   ├── tokenizer.service.ts
│       │   │   └── ...                        #   (summary, token counting, tool integrity)
│       │   │
│       │   ├── llm/                           # ← LLM layer (Routing + Providers)
│       │   │   ├── model.module.ts            #   ModelModule
│       │   │   ├── model-registry.ts          #   Model alias → backend ID mapping
│       │   │   ├── model-router.service.ts    #   Multi-backend dispatcher
│       │   │   ├── claude-api/                #   ClaudeApiModule — Claude-compatible key pool
│       │   │   ├── google/                    #   GoogleModule — Cloud Code API
│       │   │   ├── codex/                     #   CodexModule — OpenAI Codex reverse proxy
│       │   │   ├── native/                    #   NativeModule — Process pool workers
│       │   │   └── websearch/                 #   WebsearchModule — Web search
│       │   │
│       │   ├── shared/                        # Infrastructure (bootstrap, guards, env, types)
│       │   │   ├── content-type-parsers.ts    #   gRPC/ConnectRPC body parsers
│       │   │   ├── request-hooks.ts           #   Request logging hooks
│       │   │   ├── env.validation.ts          #   Environment variable validation
│       │   │   ├── api-key.guard.ts           #   API key authentication guard
│       │   │   └── anthropic.ts, cloud-code.ts #  Shared TypeScript types
│       │   │
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

| Path                         | Method | Protocol                     | Description             |
| ---------------------------- | ------ | ---------------------------- | ----------------------- |
| `/v1/messages`               | POST   | Anthropic Messages API (SSE) | Claude Code CLI         |
| `/v1/messages/count_tokens`  | POST   | Anthropic Messages API       | Count request tokens    |
| `/agent.v1.AgentService/Run` | POST   | ConnectRPC (HTTP/2 BiDi)     | Cursor IDE (Agent mode) |
| `/v1/models`                 | GET    | REST JSON                    | Anthropic model list    |
| `/v1/anthropic/models`       | GET    | REST JSON                    | List available models   |
| `/health`                    | GET    | REST JSON                    | Health check            |
| `/docs`                      | GET    | Swagger UI                   | API documentation       |

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
