# Self-managed Cursor Agent Gateway

This setup uses the readable `agent-vibes` source code directly. It does not
depend on `@cometix/ccursor`, Cursor++ Hub, LinuxDo login, or an obfuscated VSIX.

## What It Does

```text
Cursor Agent UI
  -> agent*.api5.cursor.sh / a.cursor.sh
  -> hosts: 127.0.0.1
  -> local TCP relay :443 -> 127.0.0.1:2026
  -> agent-vibes protocol bridge
  -> OpenAI-compatible backend
```

The OpenAI-compatible backend can be Skylink:

```text
https://skylink-gateway.com/api/v1
```

## Responses API Support

The protocol bridge supports OpenAI-compatible `/responses` routing.

Controls:

- Global mode: `OPENAI_COMPAT_USE_RESPONSES_API=auto|always|never`
- Per-account preference: `"preferResponsesApi": true`

`auto` tries Chat Completions first and falls back to `/responses` for eligible
reasoning models when provider errors indicate the chat endpoint is unsuitable.
`always` forces `/responses` for eligible models. `never` uses
`/chat/completions`.

## Configure Account

```bash
agent-vibes self-managed configure \
  --base-url https://skylink-gateway.com/api/v1 \
  --api-key "$SKYLINK_API_KEY" \
  --responses-mode auto
```

This writes:

```text
~/.agent-vibes/data/openai-compat-accounts.json
~/.agent-vibes/self-managed.json
```

Example account:

```json
{
  "accounts": [
    {
      "label": "skylink-ai",
      "baseUrl": "https://skylink-gateway.com/api/v1",
      "apiKey": "sk-...",
      "preferResponsesApi": false
    }
  ]
}
```

## macOS Install

Prerequisites:

- Node.js 24+
- npm 11+
- mkcert
- Cursor

Install:

```bash
npm install
agent-vibes self-managed install \
  --base-url https://skylink-gateway.com/api/v1 \
  --api-key "$SKYLINK_API_KEY" \
  --responses-mode auto
```

The installer creates launchd services:

```text
~/Library/LaunchAgents/com.agent-vibes.protocol-bridge.plist
~/Library/LaunchAgents/com.agent-vibes.cursor-agent-relay.plist
```

Fully quit and restart Cursor after install.

Status:

```bash
agent-vibes self-managed status
```

Uninstall:

```bash
agent-vibes self-managed uninstall
```

## Windows Install

Prerequisites:

- Run PowerShell as Administrator
- Node.js 24+
- npm 11+
- mkcert
- Cursor

Install from the repo:

```powershell
npm install
node .\bin\agent-vibes self-managed install `
  --base-url https://skylink-gateway.com/api/v1 `
  --api-key $env:SKYLINK_API_KEY `
  --responses-mode auto
```

The script writes:

```text
%USERPROFILE%\.agent-vibes\data\openai-compat-accounts.json
%USERPROFILE%\.agent-vibes\self-managed.json
```

It also creates scheduled tasks:

```text
AgentVibesProtocolBridge
AgentVibesCursorAgentRelay
```

Windows requires Administrator permission because the setup writes the hosts
file and binds/forwards port 443. If another program already owns port 443, stop
that program or change the local routing strategy before using this setup.

Status:

```powershell
node .\bin\agent-vibes self-managed status
```

Uninstall:

```powershell
node .\bin\agent-vibes self-managed uninstall
```

## Current Limitations

- The protocol bridge source is maintainable. The old `@cometix/ccursor` package
  and Cursor++ VSIX are not required for this self-managed path.
- Cursor can change its agent domains or protocol. If that happens, update
  `scripts/self-managed/cursor-agent-gateway.js` and the generated certificates.
- Windows install is implemented, but it still needs real Windows validation on
  the target Cursor version, admin policy, firewall, and port 443 availability.
