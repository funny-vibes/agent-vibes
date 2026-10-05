# Agent Vibes

[English](README.md) | 中文

[![CI](https://github.com/funny-vibes/agent-vibes/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/funny-vibes/agent-vibes/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com/)
[![Fastify](https://img.shields.io/badge/Fastify-HTTP%2F2-000000?logo=fastify&logoColor=white)](https://fastify.dev/)

<p align="center">
  <img src="apps/vscode-extension/resources/icon.png" alt="Agent Vibes 标志" width="120" />
</p>

<p align="center">
  <strong>在 Cursor 中使用多种 AI 编程后端</strong> — 接入
  <strong>Antigravity</strong>、<strong>Codex</strong> 和
  <strong>Kiro (AWS)</strong>，也支持 <strong>Claude Code CLI</strong>。
</p>

## 概览

Agent Vibes 是面向 Cursor 的扩展与本地桥接服务，用于连接 Antigravity、Codex、Claude 兼容接口和 Kiro 等后端。支持 Cursor Agent 的流式对话与工具调用，并提供账号管理、模型选择和额度查看；也支持 Claude Code CLI。

**客户端**（前端）：

- **Cursor IDE** — 协议兼容的原生 ConnectRPC/gRPC 实现
- **Claude Code CLI** — Anthropic API

**后端**（后端）：

- **Antigravity IDE** — 协议兼容的 Google Cloud Code API
- **Codex CLI** — 面向 GPT 与 Codex 模型的 OpenAI 兼容 API
- **Claude 兼容 API** — 通过第三方 key 直连 Anthropic-compatible `/v1/messages`
- **Kiro (AWS)** — 通过 AWS Builder ID / IdC / 社交登录接入 CodeWhisperer / Q Developer 流式接口

> **免责声明：** 本项目仅用于学习与研究目的。
>
> 使用该代理可能会让你的 Antigravity 账号面临封禁风险，请自行评估并承担相关风险。

## 架构

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
│  Claude           → Claude API / Antigravity                │
│                     / Kiro (AWS CodeWhisperer)              │
│  GPT              → Codex CLI / OpenAI-compatible API       │
│                                                             │
+ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
```

## 功能特性

<!-- markdownlint-disable MD060 -->

| 领域                 | 能力                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议与客户端         | 原生支持 Claude Code CLI 与 Cursor IDE；其中 Claude Code CLI 走 Anthropic API (SSE)，Cursor IDE 走原生 ConnectRPC/gRPC Agent 通道实现。                                                       |
| Cursor 协议实现      | 直接实现 Cursor 协议本身（对齐 Cursor 3.15 消息面），包含完整的流式工具调用循环与工具协议映射；非核心 RPC 走官方穿透。                                                                        |
| 路由与后端           | 在 Antigravity IDE、Claude 兼容 API、Codex CLI、OpenAI-compatible API 与 Kiro (AWS CodeWhisperer) 之间路由请求；覆盖 Gemini、Claude、GPT / O 系列模型，并结合后端可用性与模型能力做路由决策。 |
| 账号池与配额         | 包含原生 worker / process pool、账号池状态、cooldown、模型级 cooldown、Google / Codex / Kiro 配额视图、速率限制视图，以及面向多账号的轮转与可用性管理。                                       |
| 扩展与运维           | 提供 Dashboard、账号管理、OAuth / token 导入、账号 JSON 手动配置、SSL 证书生成、Cursor 直连接入补丁、legacy forwarding 配置、日志查看、内置诊断、usage / analytics 与更新检查。               |
| 会话、上下文与工具链 | 包含会话状态管理、context compaction / projection / summary、tool integrity、knowledge base、semantic search、MCP 工具接入以及相关持久化能力。                                                |

<!-- markdownlint-enable MD060 -->

## 快速开始

### 安装方式一：Prompt 安装（推荐非开发者使用）

把下面这段 Prompt 发给任意大模型（ChatGPT / Claude / Gemini 等），
它会全程指导你完成安装配置，遇到问题会直接分析源码和你的环境来修复：

```text
请指导我完成 Agent Vibes 的 Cursor 扩展安装、配置和测试。
用中文回答，并优先给我可执行命令。

请严格按下面步骤依次指导我：

1. 环境检查
   - 检查我的操作系统、CPU 架构、Cursor 版本、Node.js 版本，以及 `cursor` CLI 是否可用。
   - 确认我当前 Cursor 版本是否与这个 release 兼容。

2. 下载并安装 VSIX
   - 从 GitHub Releases 下载正确的 VSIX：
     <https://github.com/funny-vibes/agent-vibes/releases>
   - 按我的平台给出正确的安装命令。

3. 首次启动与 Cursor 直连接入补丁
   - 安装完成后，提醒我打开或完全重启 Cursor。
   - 扩展应自动启动本地 bridge，并默认保持 Cursor 直连接入补丁
     （`agentVibes.trafficMode=cursorPatch`）。
   - 如果 Dashboard 显示补丁仍需应用，从 Dashboard > API > Cursor IDE Protocol
     或命令面板 > Agent Vibes: Apply Cursor Bridge Endpoint Patch 应用。

4. 完全重启 Cursor
   - 在补丁应用后，明确提醒我：必须完整重启 Cursor 一次，然后再继续下一步。

5. 账号配置
   - 以 Dashboard > Accounts 作为账号配置主入口。
   - 如有需要，再指导我使用命令面板中的 sync 命令，或直接打开对应的 accounts JSON 文件进行手动配置。

6. 测试与验证
   - 验证服务是否已启动。
   - 验证 Cursor 直连接入补丁是否已生效。
   - 验证是否至少配置好了一个后端账号。
   - 用 Dashboard > Diagnostics 运行所有检查项并确认全部通过：
     代理绕过、SSL 证书、Cursor 补丁状态、bridge 健康、端到端 TLS (H2)、后端账号。
   - 注意：部分 Diagnostics 测试在未适配的平台上可能直接显示通过但实际并未检查。
     请结合测试源码和用户当前平台/环境判断结果是否可信。

7. 出错排查
   - 如果任一步骤失败，请直接分析源码：
     <https://github.com/funny-vibes/agent-vibes>
   - 同时结合我当前环境给出明确修复方案。
   - 优先提供最小、可执行的修复步骤。
   - 根据必须配置的环节，重点排查以下方向：
     * 代理环境：系统代理或 TUN/VPN 是否拦截了 Cursor 域名流量？
       分析 forwarding 脚本了解代理绕过是如何处理的。
     * SSL 证书：本地 CA 和服务器证书是否存在、是否被系统信任、是否覆盖了所需域名？
     * 转发链路：完整路径（DNS → 回环 → 端口中继 → bridge）是否连通？
     * HTTP/2 TLS：连接 Cursor 域名后是否解析到本地地址、证书有效、H2 协商正常？
     * forwarding/proxy 脚本本身也可能有 bug——请阅读源码确认。
   - Bridge 日志位于系统临时目录（`os.tmpdir()`）下：
     * macOS: `/private/var/folders/.../T/agent-vibes-bridge.log`
     * Linux: `/tmp/agent-vibes-bridge.log`
     * Windows: `%TEMP%\agent-vibes-bridge.log`
     * 详细 protocol 日志: `<tmpdir>/agent-vibes-logs/`

8. bug 提交
   - 如果问题修复成功且确认发现了真实 bug，请帮我准备 `gh issue create` 的提交内容。
   - 在真正提交前，先让我确认。
```

### 安装方式二：扩展安装（Cursor IDE）

Cursor 客户端侧使用 free 账号即可，不需要开通 Cursor 付费订阅。

从 [GitHub Releases](https://github.com/funny-vibes/agent-vibes/releases) 一键下载并安装：
兼容 Cursor 版本：`3.20.17`。

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

安装后重启 Cursor，扩展会自动启动代理服务器（仅启动 bridge，不会自动修改 Cursor），
并引导你完成首次配置（SSL 证书与账号同步均可在命令面板中操作）。如需让 Cursor IDE 走 bridge，
请从 Dashboard > API > Cursor IDE Protocol 应用 Cursor 直连接入补丁。

### 安装方式三：源码安装（全平台）

> **说明：** 当前主要在 macOS 上开发与测试。
> Linux 和 Windows 虽然都已实现支持，但尚未完整验证，脚本在这些平台上仍可能存在边界问题。欢迎 PR。

```bash
git clone https://github.com/funny-vibes/agent-vibes.git
cd agent-vibes
npm install && npm run build
npm link                          # 将 `agent-vibes` 注册为全局命令
```

生成 SSL 证书：

```bash
# 先安装 mkcert: https://github.com/FiloSottile/mkcert#installation
mkcert -install
agent-vibes cert
```

Cursor 直连接入，以下为一次性设置：

```bash
agent-vibes                      # 启动 bridge
# 然后在 Cursor 命令面板执行 "Agent Vibes: Apply Cursor Bridge Endpoint Patch"
```

### 选择一个上游来源

Antigravity（[Antigravity IDE](https://antigravity.google) 或 [Antigravity Manager](https://github.com/lbjlaq/Antigravity-Manager)）：

```bash
agent-vibes sync --ide       # 从 Antigravity IDE 同步
agent-vibes sync --tools     # 从 Antigravity Manager 同步
```

Claude Code 第三方配置：

```bash
agent-vibes sync --claude
```

Codex：

```bash
codex --login
agent-vibes sync --codex
```

Kiro（AWS Builder ID / IdC / Kiro IDE）：

- **最简单：** Dashboard → Accounts → Kiro → 新增账号 → **Builder ID** 标签页。
  Bridge 会全程跑完 OAuth device flow，自动打开浏览器，并把令牌写入
  `~/.agent-vibes/data/kiro-accounts.json`。
- **从已登录的 Kiro IDE / AWS CLI 同步：** 命令面板 →
  `Agent Vibes: Sync Kiro IDE Credentials`。Bridge 会扫描
  `~/.aws/sso/cache/*.json` 与 Kiro IDE 的
  `globalStorage/kiro.kiroagent/kiro-cache/`，自动配对 token 与 client
  registration 后导入可用条目。
- **手动粘贴 JSON：** Dashboard → Accounts → Kiro → 新增账号 → **Token** 标签页。
  接受 SSO cache JSON、Kiro IDE `kiro-auth-token.json`，或直接粘贴
  `kiro-accounts.json` 整体结构。

### 扩展命令

这个扩展会在命令面板里保留一组安装 / 配置相关的必要命令，而运行期状态与细粒度操作主要放在 Dashboard 中完成。

#### 安装 / 配置命令

| 步骤 | 命令面板标题                                      | Command ID                                  | 用途                                                                                |
| ---- | ------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1    | Agent Vibes: Open Dashboard                       | `agentVibes.openDashboard`                  | 打开主 Dashboard，先查看当前安装状态。                                              |
| 2    | Agent Vibes: Generate SSL Certificates            | `agentVibes.generateCert`                   | 生成 HTTPS 拦截所需的本地证书。                                                     |
| 3    | Dashboard → Accounts                              | _主入口_                                    | 在账号管理 tab 中完成账号配置；支持新增、编辑、OAuth、token 导入等操作。            |
| 3    | Agent Vibes: Sync Antigravity IDE Credentials     | `agentVibes.syncAntigravityIDE`             | 从 Antigravity IDE 导入凭据。                                                       |
| 3    | Agent Vibes: Sync Antigravity Tool Credentials    | `agentVibes.syncAntigravityTools`           | 从 Antigravity Manager / tools 导入凭据。                                           |
| 3    | Agent Vibes: Sync Claude Credentials              | `agentVibes.syncClaude`                     | 将 Claude 兼容凭据同步到 Agent Vibes。                                              |
| 3    | Agent Vibes: Sync Codex Credentials               | `agentVibes.syncCodex`                      | 将 Codex 凭据同步到 Agent Vibes。                                                   |
| 3    | Agent Vibes: Open OpenAI-Compatible Accounts JSON | `agentVibes.openOpenAICompatAccounts`       | 打开 `openai-compat-accounts.json` 进行手动配置。                                   |
| 3    | Agent Vibes: Open Claude API Accounts JSON        | `agentVibes.openClaudeApiAccounts`          | 打开 `claude-api-accounts.json` 进行手动配置。                                      |
| 3    | Agent Vibes: Open Kiro Accounts JSON              | `agentVibes.openKiroAccounts`               | 打开 `kiro-accounts.json` 进行手动配置。                                            |
| 3    | Agent Vibes: Sync Kiro IDE Credentials            | `agentVibes.syncKiroIDE`                    | 导入 Kiro IDE 或 AWS CLI 在本地缓存的 Kiro / AWS SSO token。                        |
| 4    | Agent Vibes: Start Server                         | `agentVibes.startServer`                    | 在证书和至少一个账号准备完成后仅启动本地 bridge（不开启转发）。                     |
| 5    | Agent Vibes: Apply Cursor Bridge Endpoint Patch   | `agentVibes.applyCursorBridgeEndpointPatch` | 让 Cursor 的账号、模型和 Agent 流量直接连接本机 bridge，不再依赖 hosts 或端口转发。 |
| 6    | Agent Vibes: Enable Port Forwarding               | `agentVibes.enableForwarding`               | legacy 本地转发备用路径。                                                           |
| 6    | Agent Vibes: Disable Port Forwarding              | `agentVibes.disableForwarding`              | 关闭 legacy 本地转发。                                                              |
| 6    | Agent Vibes: Port Forwarding Status               | `agentVibes.forwardingStatus`               | 检查 legacy forwarding 与 hosts 配置状态。                                          |
| 7    | Agent Vibes: Edit Configuration                   | `agentVibes.openConfig`                     | 打开 Cursor 中的 `agentVibes` 设置。                                                |
| 8    | Agent Vibes: Check Extension Updates              | `agentVibes.checkExtensionUpdates`          | 检查 GitHub Releases 上是否有新的 VSIX。                                            |

#### Dashboard tabs

| Tab             | 用途                                                                     |
| --------------- | ------------------------------------------------------------------------ |
| **Overview**    | 安装状态、快捷操作（启动 / 停止 / 重启）、后端概览                       |
| **API**         | 暴露的 HTTP 端点；Cursor 直连接入补丁、Claude Code CLI 接入、复制 / 测试 |
| **Accounts**    | 账号管理、OAuth、token 导入、pool / quota 详情                           |
| **Analytics**   | usage summary 与后端 / 运行期统计                                        |
| **Settings**    | 扩展设置与路径覆盖                                                       |
| **Diagnostics** | 内置检查项                                                               |
| **Logs**        | bridge 日志与 debug 开关                                                 |

### 日常使用

#### Cursor IDE

- 打开 Cursor，扩展会自动启动本地 bridge（仅启动服务）。
- 如需让 Cursor IDE 走 bridge，请保持 Settings > Bridge > Cursor 接入方式为 Cursor 直连补丁。如果 API 页显示补丁缺失，再从 Dashboard > API > Cursor IDE Protocol 应用。若仅把 bridge 当作 Claude Code CLI / API 客户端的中转，可跳过此步。
- 如需确认运行状态，打开 Dashboard 查看 Overview、API、Accounts、Logs 与 Diagnostics。
- 在 Cursor 中直接发起一次真实请求，验证账号、路由与工具调用是否正常。

#### Claude Code CLI（可选）

如果你还需要把 Claude Code CLI 接到同一个本地代理，可使用：

```bash
agent-vibes                  # 启动代理
```

在另一个终端中：

```bash
export ANTHROPIC_BASE_URL=https://localhost:8000
claude
```

> **提示：** 可以把 `export ANTHROPIC_BASE_URL=https://localhost:8000` 写入你的 shell profile，以便长期生效。

## 后端配置参考

### 1. Antigravity

用于接入 Antigravity / Google Cloud Code。

配置方式：

```bash
agent-vibes sync --ide
agent-vibes sync --tools
```

行为：

- 凭据会同步到 `~/.agent-vibes/data/antigravity-accounts.json`。
- 支持多账号轮转。
- **Claude 模型路由：** 当 Claude Code CLI 通过 Google 后端路由时，
  只有 **Opus** 模型走 Claude-through-Google（Cloud Code）路径。
  非 Opus 的 Claude 模型（Sonnet、Haiku 等）会自动重定向到
  **Gemini 3.1 Pro High**，从而节省 Claude 配额用于复杂的 agentic 任务。
- **配额降级（可选）：** 当所有 Google Cloud Code 账号配额耗尽，
  且冷却时间超过最大等待阈值时，系统可以自动降级到配置的
  Gemini 模型，而非返回 429 错误。
  在 `antigravity-accounts.json` 顶层添加 `"quotaFallbackModel"` 即可开启：

```json
{
  "quotaFallbackModel": "gemini-3.1-pro-high",
  "accounts": [...]
}
```

将 `"quotaFallbackModel"` 设为目标降级模型 ID，
或删除该字段以禁用（默认：禁用，行为与之前一致，返回 429）。

### 2. GPT

用于接入 GPT 模型。

配置方式：

- Codex：

```bash
codex --login
agent-vibes sync --codex
```

- OpenAI 兼容配置文件：`~/.agent-vibes/data/openai-compat-accounts.json`

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

行为：

- Codex 和 OpenAI 兼容后端都支持多账号轮转。
- 同时配置 OpenAI 兼容后端和 Codex 后端时，GPT 请求优先走 Codex 后端，OpenAI 兼容后端作为回退。
- 额度耗尽时自动切换到下一个可用账号。
- `proxyUrl` 可为该账号指定 HTTP/SOCKS 代理地址。
- `preferResponsesApi=true` 时使用 OpenAI Responses API（`/v1/responses`）代替 Chat Completions。
- `maxContextTokens` 可为账号设置输入/上下文上限。若当前有多个可用的 OpenAI 兼容账号可参与轮转，bridge 会取其中已配置上限的最小值进行 clamp，避免切换或回退到较小窗口的提供方时溢出。

### 3. Claude API

用于接入第三方 Claude 兼容 API。

配置方式：

- `agent-vibes sync --claude` 会读取 `~/.claude/settings.json`，并在 `~/.agent-vibes/data/claude-api-accounts.json` 中写入或更新一个受管理的 `claude-code-sync` 条目。
  这个受管理条目会以当前源设置为准；如果源设置里已经没有显式模型 ID，旧的受管 `models` 也会被清掉，以便动态发现生效。
- 或手动编辑 `~/.agent-vibes/data/claude-api-accounts.json`：

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

行为：

- 未加前缀的 Claude 模型，如果存在匹配账号，会优先走 Claude API 后端，失败后再回退到 Antigravity / Google Cloud Code。
- `forceModelPrefix=false` 时，带前缀账号会同时暴露 `claude-sonnet-latest` 和 `team-a/claude-sonnet-latest`。
- `forceModelPrefix=true` 时，带前缀账号必须显式用前缀模型名访问。
- 带前缀的模型，例如 `team-a/claude-sonnet-latest`，只会命中对应 `prefix` 的 Claude API 账号。
- 如果没有配置 `models`，代理会优先尝试从上游 `GET /v1/models` 动态发现可用模型；发现失败时，仍会保留内置默认列表并继续支持 Claude-family 模型名原样透传。
- 如果配置了 `models`，则以手动映射为准，不再自动发现该账号的模型列表。
- `stripThinking=true` 时，会在转发前移除 Anthropic thinking 相关字段，适合只支持基础 Claude 模型名的第三方端点。
- `excludedModels` 支持大小写不敏感的通配符写法，例如 `claude-3-*`、`*-thinking`、`*haiku*`。
- `maxContextTokens` 可为账号设置输入/上下文上限。若多个 Claude API 账号都能服务同一个模型，bridge 会取当前可用候选中已配置上限的最小值做 clamp，
  确保失败回退时也不会撞上较小提供方的窗口。
- 官方 `api.anthropic.com` 使用 `x-api-key`；第三方兼容端点使用 `Authorization: Bearer ...`。

### 4. Kiro（AWS CodeWhisperer / Q Developer）

通过 AWS Builder ID、IAM Identity Center (IdC) 或社交登录的 Kiro 账号访问 Claude Sonnet / Opus / Haiku。

配置方式（任选其一）：

- **Builder ID OAuth（推荐）：** Dashboard → Accounts → Kiro → 新增 → **Builder ID**。
- **同步本地缓存：** 命令面板 → `Agent Vibes: Sync Kiro IDE Credentials`。从 `~/.aws/sso/cache/` 与 Kiro IDE `globalStorage` 导入已登录的 token。
- **手动粘贴：** Dashboard → Accounts → Kiro → 新增 → **Token**。

行为：

- `authMethod`：`"idc"`（Builder ID / IdC，需要 `clientId` + `clientSecret`）或 `"social"`（GitHub / Google）。
- AWS 不返回 Anthropic 格式的 cache token 计数，Bridge 在客户端模拟 `cache_read_input_tokens` / `cache_creation_input_tokens`。
- 刷新后的 token 会写回 `~/.agent-vibes/data/kiro-accounts.json`，后台每 15 分钟自动刷新一次。

## SSH 远程开发

当 Cursor IDE 通过 SSH 连接远程主机（工作区在远端而非本地笔记本）时，agent 流量是由远端的 `cursor-server` 进程发出的。本地的 hosts/回环重定向无法拦截远端流量；同时大多数用户在远端主机上没有 `sudo`，无法再装一份 bridge。

为此 bridge 内置了一个 HTTP 正向代理，让远端 `cursor-server` 在**无需 root** 的情况下，把 Cursor 流量回转到本机笔记本上的 bridge。

### 工作原理

```text
┌─ 本地笔记本（运行 Cursor IDE） ──────────────────────────┐
│                                                          │
│  Bridge 进程                                             │
│   ├─ HTTPS 服务   127.0.0.1:2026   （已有）              │
│   └─ Forward 代理 127.0.0.1:18080  （新增，仅回环）       │
│         │                                                 │
│         │  CONNECT api2.cursor.sh:443                     │
│         ▼                                                 │
│         splice → 127.0.0.1:2026  （bridge 处理 TLS）       │
└────────┬─────────────────────────────────────────────────┘
         │   ssh -R 18080:127.0.0.1:18080 user@remote
         ▼
┌─ 远端 SSH 主机（无需 sudo） ─────────────────────────────┐
│                                                          │
│  HTTPS_PROXY=http://127.0.0.1:18080                      │
│  cursor-server / agent runtime                           │
│         │ HTTPS api2.cursor.sh:443                        │
│         ▼                                                 │
│  127.0.0.1:18080  （由 ssh -R 反向隧道转回笔记本）         │
└──────────────────────────────────────────────────────────┘
```

对 Cursor agent 域名，代理会把 TLS 连接直接 splice 到本地 bridge；对其他域名，代理表现为普通 HTTPS 代理，连到真实上游。这样远端 shell 可以全程使用同一个 `HTTPS_PROXY`。

### 配置步骤

本地笔记本（一次配置）：

1. 启动 bridge。启动 banner 中应能看到：

   ```text
   ▸ SSH proxy http://127.0.0.1:18080
   ```

   代理仅绑定回环地址；可通过 `FORWARD_PROXY_ENABLED=false` 或 `FORWARD_PROXY_PORT=0` 关闭。

2. 通过反向隧道开启 SSH 连接，把 18080 暴露到远端：

   ```bash
   ssh -R 18080:127.0.0.1:18080 user@remote-host
   ```

   或写入 `~/.ssh/config`：

   ```sshconfig
   Host my-remote
     HostName remote-host
     User myuser
     RemoteForward 18080 127.0.0.1:18080
   ```

远端主机（每个 shell，无需 sudo）：

1. 把本机 bridge 的 CA 拷到远端，让 Node 信任：

   ```bash
   # 在远端
   mkdir -p ~/.agent-vibes/certs
   # 把本机 ~/.agent-vibes/certs/ca.pem 拷过来，例如在本机：
   #   scp ~/.agent-vibes/certs/ca.pem user@remote-host:~/.agent-vibes/certs/ca.pem
   export NODE_EXTRA_CA_CERTS=$HOME/.agent-vibes/certs/ca.pem
   ```

2. 让 agent runtime 走代理，再启动 `cursor-server`：

   ```bash
   export HTTPS_PROXY=http://127.0.0.1:18080
   export HTTP_PROXY=http://127.0.0.1:18080
   # 在同一 shell 中重启 cursor-server，例如：
   #   ~/.cursor-server/bin/cursor-server &
   ```

   把上面 export 写入 `~/.bashrc` / `~/.zshrc` / `~/.profile` 即可持久化。

### 故障排查

- 在远端执行 `curl -x http://127.0.0.1:18080 https://api2.cursor.sh/health`，应返回 `{"status":"ok",...}`。如果卡住，先确认 `ssh -R` 仍在生效，远端 `127.0.0.1:18080` 真的回转到笔记本。
- 出现 `tls: x509: certificate signed by unknown authority`：未设置 `NODE_EXTRA_CA_CERTS`，或 CA 与 bridge 证书不匹配；重新拷贝 `ca.pem`。
- 远端 agent runtime 不走代理：确认 `HTTPS_PROXY` 等环境变量是在拉起 `cursor-server` 的那个 shell 中导出的；某些启动方式（`systemd --user`、早于 `export` 的 tmux 面板）会保留旧 env。
- 代理拒绝连接：确认本地 bridge 在跑（banner 显示 `▸ SSH proxy ...`），并且笔记本上 `127.0.0.1:18080` 没有被其他进程占用。

## 常见问题 / 故障排查

### `agent-vibes forward on` 在系统全局 TUN 代理下不生效

现象：执行 `npm run cursor:forward:on`（或 `agent-vibes forward on`）后，Cursor 仍然无法连到 bridge，Diagnostics 报 DNS / 转发失败，或 `curl https://api2.cursor.sh/health` 卡住。

根因：系统代理工作在 **TUN 模式**（Clash Verge、Mihomo、V2RayN TUN、sing-box 等）下，会在网络层拦截所有流量，**早于** hosts 文件改写或回环重定向生效。
即使代理规则里写了 `127.0.0.0/8 -> DIRECT`，上游解析器也可能已经把 `localhost` / Cursor 域名劫持到 fake-ip 段，导致 IP-CIDR 规则根本没匹配上。

修复方案（以 Clash Verge Rev 为例，其他 TUN 客户端有等价配置项）：

1. **把回环和私网段从 TUN 接口排除。** 写到全局 merge / override 配置中，避免被订阅更新覆盖：

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

2. **把本地域名加入 fake-ip 过滤**，防止 DNS 劫持把 `localhost` 改写到 fake-ip 池：

   ```yaml
   dns:
     fake-ip-filter:
       - "localhost"
       - "*.localhost"
       - "*.local"
       - "*.cursor.sh"
   ```

3. **在规则列表最前面显式追加 DIRECT 规则**，确保优先级高于 `MATCH,PROXY`：

   ```yaml
   rules:
     - DOMAIN,localhost,DIRECT
     - DOMAIN-SUFFIX,.local,DIRECT
     - DOMAIN-SUFFIX,cursor.sh,DIRECT
     - IP-CIDR,127.0.0.0/8,DIRECT
     # ... 已有规则
   ```

4. 重新加载代理配置后，再次执行 `npm run cursor:forward:on` 即可生效。

如果只是想快速验证是否是 TUN 引起的，可以临时把 TUN 客户端切到 **Rule** 模式（或临时关闭 TUN），观察转发是否恢复正常。

## 项目结构

```text
agent-vibes/
├── bin/
│   └── agent-vibes                            # CLI 入口
├── apps/
│   └── protocol-bridge/                       # 主代理服务（NestJS + Fastify）
│       ├── sea/                               # SEA 打包脚本与入口
│       ├── src/
│       │   ├── main.ts                        # 应用启动（Fastify 适配器、CORS、Swagger）
│       │   ├── app.module.ts                  # NestJS 根模块
│       │   ├── health.controller.ts           # 健康检查 + 进程池状态
│       │   ├── usage.ts                       # UsageStatsModule + UsageStatsService
│       │   │
│       │   ├── protocol/                      # ← 协议适配层
│       │   │   ├── cursor/                    #   CursorModule — Cursor IDE (ConnectRPC)
│       │   │   │   ├── controllers/
│       │   │   │   ├── session/
│       │   │   │   ├── tools/
│       │   │   │   ├── cursor-connect-stream.service.ts
│       │   │   │   ├── cursor-grpc.service.ts
│       │   │   │   └── ...                    #   （鉴权、知识库、模型协议等）
│       │   │   └── anthropic/                 #   AnthropicModule — Claude Code CLI
│       │   │       ├── anthropic.module.ts
│       │   │       ├── tokenizer.service.ts   #   本地 /count_tokens fallback
│       │   │       ├── messages.controller.ts #   POST /v1/messages
│       │   │       ├── messages.service.ts
│       │   │       └── dto/                   #   请求 DTO
│       │   │
│       │   ├── context/                       # ← 会话上下文
│       │   │   ├── context.module.ts          #   ContextModule
│       │   │   ├── context-manager.service.ts
│       │   │   ├── context-compaction.service.ts
│       │   │   ├── token-counter.service.ts
│       │   │   └── tool-protocol-integrity.ts
│       │   │
│       │   ├── llm/                           # ← Provider 实现与共享路由
│       │   │   ├── anthropic/                 #   AnthropicApiModule — Claude 兼容 key 池
│       │   │   ├── aws/                       #   KiroModule — AWS CodeWhisperer / Kiro IDE 后端
│       │   │   ├── google/                    #   GoogleModule — Cloud Code API + Go worker 池
│       │   │   ├── openai/                    #   Codex + OpenAI 兼容 provider
│       │   │   └── shared/                    #   模型路由、注册表、后端通用工具
│       │   │
│       │   ├── persistence/                   # SQLite 持久化与 migration
│       │   ├── shared/                        # 路径、守卫、请求钩子、共享类型
│       │   └── gen/                           # 自动生成的 protobuf（不要手改）
│       │
│       ├── proto/                             # Protobuf 定义（协议兼容，仅本地）
│       └── data/                              # 各后端凭据池（JSON）
├── packages/
│   ├── eslint-config/                         # 共享 ESLint 配置
│   ├── prettier-config/                       # 共享 Prettier 配置
│   └── typescript-config/                     # 共享 TypeScript 基础配置
└── scripts/
    ├── lib/                                   # 跨平台共享工具
    ├── accounts/                              # 账号同步脚本
    ├── cursor/                                # Cursor 补丁 / 调试脚本
    ├── proxy/                                 # 端口转发（TCP relay / iptables / netsh）
    └── capture/                               # 抓包与流量分析
```

## API 端点

本地桥接服务默认端口为 `2026`。

| 路径                                 | 方法                 | 用途                             |
| ------------------------------------ | -------------------- | -------------------------------- |
| `/agent.v1.AgentService/Run`         | POST                 | Cursor Agent 对话与工具调用      |
| `/v1/messages`                       | POST                 | Claude Code / Anthropic 兼容对话 |
| `/v1/messages/count_tokens`          | POST                 | 请求 token 计数                  |
| `/v1/chat/completions`               | POST                 | OpenAI Chat 兼容对话             |
| `/v1/responses`                      | POST                 | OpenAI Responses 兼容对话        |
| `/v1/web-gpt/chat/completions`       | POST                 | GPT Web 对话                     |
| `/v1/web-gpt/responses`              | POST                 | GPT Web Responses                |
| `/v1/images/generations`             | POST                 | 图片生成                         |
| `/v1/images/edits`                   | POST                 | 参考图编辑                       |
| `/v1/images/jobs/{id}`               | GET                  | 图片任务状态与结果               |
| `/v1/realtime/calls`                 | POST                 | 创建语音连接                     |
| `/v1/realtime/calls/{id}`            | GET / PATCH / DELETE | 语音会话查询、关联与清理         |
| `/v1/realtime/files/{fileId}`        | GET                  | 获取 Web 语音生成的文件          |
| `/v1/models`、`/v1/anthropic/models` | GET                  | 模型列表                         |
| `/v1/web-gpt/models`                 | GET                  | GPT Web 模型列表                 |
| `/health`                            | GET                  | 服务健康检查                     |

## 技术栈

| 组件        | 技术                                               |
| ----------- | -------------------------------------------------- |
| Runtime     | Node.js ≥ 24                                       |
| Framework   | NestJS 11 + Fastify (HTTP/2 + HTTP/1.1)            |
| Language    | TypeScript (ES2021, CommonJS)                      |
| Protobuf    | `@bufbuild/protobuf` v2 + `@connectrpc/connect` v2 |
| Monorepo    | Turborepo + npm workspaces                         |
| Linting     | ESLint 9 + Prettier 3 + markdownlint               |
| Git Hooks   | Husky + lint-staged + commitlint                   |
| Testing     | Jest 30 + ts-jest                                  |
| Database    | better-sqlite3（本地 KV 存储）                     |
| Tokenizer   | tiktoken                                           |
| HTTP Client | 原生 `fetch` + SOCKS/HTTP 代理 agent               |
| Platform    | macOS, Linux, Windows                              |

## CI/CD

- **`ci.yml`** — push / PR 时的质量门禁
  - 运行 `lint`、`types`、`build`、`test`
- **`deploy-proxy.yml`** — push 到 `main` 时自动部署（仅在 `apps/protocol-bridge/**` 变更时触发）
  - Build → SCP 上传到服务器 → 重启 systemd 服务
  - 生产环境使用 Let's Encrypt SSL 以支持 HTTP/2
- **`claude.yml`** — Claude Code 自动化
  - Issue 处理：打上 `claude` 标签 → 自动实现 → 向 `dev` 创建 PR
  - PR 审查：自动 review → 审批后合并
  - 交互触发：评论中使用 `@claude` 或 `@c`

### 分支策略

| 分支               | 用途                        |
| ------------------ | --------------------------- |
| `dev`              | 开发分支（默认 PR 目标）    |
| `main`             | 生产分支（push 后自动部署） |
| `issue-{N}-{slug}` | 功能分支（由 CI 创建）      |

## 交流讨论

欢迎在 [LINUX DO](https://linux.do/t/topic/1814066) 参与关于 Agent Vibes 的讨论与交流，或者随时在 [GitHub Issues](https://github.com/funny-vibes/agent-vibes/issues) 反馈问题。

## 贡献

如果你发现了 bug，或者有新的想法，欢迎使用我们的 [issue templates](https://github.com/funny-vibes/agent-vibes/issues/new/choose) 提交 bug 或功能请求。

提交 PR 前，请先阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

pre-commit hooks 会自动执行 lint 和 format 检查。

---

祝你 Vibe Coding 顺利！

## License

[MIT](LICENSE) © 2025-2026 recronin
