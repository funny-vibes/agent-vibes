# Agent Vibes

English | [中文](README_zh.md)

> **Unified Agent Gateway** — Use **Antigravity** and **Codex** AI backends with **Claude Code CLI** and **Cursor IDE**.

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
│  Gemini / Claude  → Antigravity IDE (Cloud Code)            │
│  GPT / Codex      → Codex CLI                               │
│                                                             │
+ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
```

## Features

| Client          | Protocol                              | Backend                    | Models                     |
| --------------- | ------------------------------------- | -------------------------- | -------------------------- |
| Claude Code CLI | Anthropic Messages API (SSE)          | Antigravity IDE, Codex CLI | Gemini, Claude, GPT, Codex |
| Cursor IDE      | ConnectRPC/gRPC (protocol-compatible) | Antigravity IDE, Codex CLI | Gemini, Claude, GPT, Codex |

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

### Install & Setup (Required)

**From source (all platforms):**

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

Sync your Antigravity credentials ([Antigravity IDE](https://antigravity.google) or [Antigravity Manager](https://github.com/lbjlaq/Antigravity-Manager)):

```bash
agent-vibes sync --ide       # from Antigravity IDE
agent-vibes sync --tools     # from Antigravity Manager
```

### Use with Claude Code CLI

```bash
agent-vibes                  # start proxy
```

In another terminal:

```bash
export ANTHROPIC_BASE_URL=https://localhost:8000
claude
```

> **Tip:** Add `export ANTHROPIC_BASE_URL=https://localhost:8000` to your shell profile to make it persistent.

### Use with Cursor IDE

For the Cursor client side, a free account is enough. No paid Cursor plan is required.

Cursor requires HTTPS interception — one-time setup:

```bash
# 1. Add DNS redirect to hosts file
agent-vibes forward hosts

# 2. Enable port forwarding (uses TCP relay on macOS, iptables on Linux, netsh on Windows)
agent-vibes forward on
```

Then start the proxy:

```bash
agent-vibes
```

Verify everything is working:

```bash
agent-vibes forward status
```

### Environment Variables

| Variable               | Default              | Description                      |
| ---------------------- | -------------------- | -------------------------------- |
| `PORT`                 | `8000`               | Server port                      |
| `PROXY_API_KEY`        | _(disabled)_         | Require API key for all requests |
| `ANTIGRAVITY_STORAGE`  | `~/.protocol-bridge` | Path to Antigravity credentials  |
| `ANTIGRAVITY_APP_PATH` | _(auto-detect)_      | Optional Antigravity.app path    |

## Codex Backend (GPT / O-series Models)

```bash
# Login and sync (supports multiple accounts / team workspaces, sync after each login to add)
codex --login
agent-vibes sync --codex

# Start proxy
agent-vibes
```

Multiple accounts are automatically rotated. When quota is exhausted, the system automatically switches to the next available account.

## OpenAI-Compatible Backend (Third-party GPT APIs)

Add accounts to `apps/protocol-bridge/data/openai-compat-accounts.json` (supports multi-account rotation):

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
      "apiKey": "sk-yyy"
    }
  ]
}
```

When both OpenAI-compatible and Codex backends are configured,
GPT / O-series requests are routed to the OpenAI-compatible backend first.
When quota is exhausted, the system automatically switches to the next available account.

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
    ├── diagnostics/                           # One-click issue report collector
    ├── proxy/                                 # Port forwarding (TCP relay/iptables/netsh)
    └── capture/                               # Traffic capture and dump inspection
```

## Commands

### Development

```bash
npm run dev                    # Start dev server (turbo watch mode)
npm run build                  # Build all packages
npm run start                  # Start production server
```

### Code Quality

```bash
npm run lint                   # ESLint check
npm run lint:fix               # Auto-fix lint issues
npm run format                 # Prettier check
npm run format:fix             # Auto-fix formatting
npm run types                  # TypeScript type check
```

### Proxy App (from `apps/protocol-bridge/`)

```bash
npm run dev                    # NestJS watch mode
npm run build                  # Build to dist/
npm run test                   # Run Jest tests
npm run proto:gen              # Generate TypeScript from proto files
```

### Cursor Integration

```bash
npm run cursor:cert            # Generate SSL certificates (mkcert)
npm run cursor:forward:on      # Enable port forwarding (requires sudo/admin)
npm run cursor:forward:off     # Disable port forwarding (requires sudo/admin)
npm run cursor:forward:status  # Show forwarding status
```

If Cursor is installed in a non-standard location, set `CURSOR_BINARY_PATH`, `CURSOR_WORKBENCH_PATH`, or `CURSOR_APP_ROOT` for the tooling scripts.

### Credential Sync & Deployment

```bash
npm run antigravity:sync       # Sync Antigravity accounts → data/antigravity-accounts.json
npm run codex:sync             # Sync Codex CLI auth → data/codex-accounts.json
npm run deploy:sync            # Upload all credentials to GitHub Secrets
npm run deploy:sync -- --run   # Upload + trigger CI/CD deployment
npm run release                # Merge dev → main → push (triggers CI deploy)
```

### Diagnostics

```bash
npm run issues                 # Collect logs & environment info, copy to clipboard
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

Join the discussion and share your thoughts about Agent Vibes on [LINUX DO](https://linux.do/t/topic/1814066), or feel free to report bugs and feedback on [GitHub Issues](https://github.com/funny-vibes/agent-vibes/issues).

## Contributing

Found a bug or have an idea? Use our [issue templates](https://github.com/funny-vibes/agent-vibes/issues/new/choose) to report bugs or request features.

> **Tip:** Run `agent-vibes issues` (or `npm run issues`) to auto-collect diagnostics — the report is copied to your clipboard, ready to paste into the bug report template.

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening PRs.

Pre-commit hooks automatically run lint + format checks.

---

Happy vibing!

## License

[MIT](LICENSE) © 2025-2026 recronin
