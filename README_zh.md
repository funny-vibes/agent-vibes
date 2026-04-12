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
  <strong>统一 Agent 网关</strong> — 通过 <strong>Claude Code CLI</strong> 和 <strong>Cursor IDE</strong> 使用 <strong>Antigravity</strong> 与 <strong>Codex</strong> AI 后端。
</p>

> [!WARNING]
> **dev** 分支正在基于 **Claude Code** 源码架构进行大规模重构和密集测试，
> **不建议用于生产环境的编码任务。** 稳定后将发布 LTS 版本。
> **Agent Vibes v0.1.10 (Cursor 3.0.16)** 之前的版本存在许多已知缺陷，
> 建议及时更新至 v0.1.10 或更高版本。

## 概览

Agent Vibes 是一个统一的 AI Agent 网关。它不只是做客户端与后端之间的协议转换，还完整实现了 Cursor 原生 ConnectRPC/gRPC Agent 通道与流式工具调用循环，并在 Antigravity、Claude 兼容、Codex 与 OpenAI-compatible 等后端之间进行请求路由。

**客户端**（前端）：

- **Claude Code CLI** — Anthropic Messages API
- **Cursor IDE** — 协议兼容的原生 ConnectRPC/gRPC 实现

**后端**（后端）：

- **Antigravity IDE** — 协议兼容的 Google Cloud Code API
- **Codex CLI** — 面向 GPT 与 Codex 模型的 OpenAI 兼容 API
- **Claude 兼容 API** — 通过第三方 key 直连 Anthropic-compatible `/v1/messages`

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
│  GPT              → Codex CLI / OpenAI-compatible API       │
│                                                             │
+ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
```

## 功能特性

| 领域                 | 能力                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议与客户端         | 原生支持 Claude Code CLI 与 Cursor IDE；其中 Claude Code CLI 走 Anthropic Messages API (SSE)，Cursor IDE 走原生 ConnectRPC/gRPC Agent 通道实现。                    |
| Cursor 协议实现      | 直接实现 Cursor 协议本身，包含完整的流式工具调用循环（streaming tool loop）与相关工具协议映射，而不只是兼容接口或简单转发。                                         |
| 路由与后端           | 在 Antigravity IDE、Claude 兼容 API、Codex CLI 与 OpenAI-compatible API 之间路由请求；覆盖 Gemini、Claude、GPT / O 系列模型，并结合后端可用性与模型能力做路由决策。 |
| 账号池与配额         | 包含原生 worker / process pool、账号池状态、cooldown、模型级 cooldown、Google / Codex 配额视图、速率限制视图，以及面向多账号的轮转与可用性管理。                    |
| 扩展与运维           | 提供 Dashboard、账号管理、OAuth / token 导入、账号 JSON 手动配置、SSL 证书生成、forwarding 配置、日志查看、内置诊断、usage / analytics 与更新检查。                 |
| 会话、上下文与工具链 | 包含会话状态管理、context compaction / projection / summary、tool integrity、knowledge base、semantic search、MCP 工具接入以及相关持久化能力。                      |

## 与 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的差异

CLIProxyAPI 是这个项目最接近的参考项目，但两者重心不同。
CLIProxyAPI 更偏 API-first 和 CLI 场景；Agent Vibes 则把主要精力放在 Cursor 的原生客户端兼容性，以及 Antigravity 的原生上游保真度上。

- **Cursor：** Agent Vibes 并不止步于 OpenAI / Claude 兼容接口，而是直接实现了 Cursor 原生 ConnectRPC/gRPC Agent 通道，以协议兼容的 protobuf 定义实现了互操作性，并直接实现流式工具循环。
- **Antigravity：** 本仓库当前的主路径是较新的 worker-native 方案，围绕运行 Antigravity 自身运行时与模块来构建，使 Cloud Code 请求保持协议兼容，并在此基础上实现配额感知的 worker 轮转。
- **致谢：** 本项目借鉴和移植了大量开源项目的代码与思路，其中 Claude Code CLI 和 Codex CLI 主要参考
  CLIProxyAPI，在 TypeScript/NestJS 架构下重写。Cursor 原生协议层和 Antigravity worker 池为原创实现。

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

3. 首次启动与 forwarding
   - 安装完成后，提醒我打开或完全重启 Cursor。
   - 扩展应自动启动本地服务。
   - 指导我完成 forwarding 相关提示和设置。

4. 完全重启 Cursor
   - 在 forwarding 完成后，明确提醒我：必须完整重启 Cursor 一次，然后再继续下一步。

5. 账号配置
   - 以 Dashboard > Accounts 作为账号配置主入口。
   - 如有需要，再指导我使用命令面板中的 sync 命令，或直接打开对应的 accounts JSON 文件进行手动配置。

6. 测试与验证
   - 验证服务是否已启动。
   - 验证 forwarding 是否已生效。
   - 验证是否至少配置好了一个后端账号。
   - 用 Dashboard > Diagnostics 运行所有检查项并确认全部通过：
     代理绕过、SSL 证书、DNS 解析、流量转发、bridge 健康、端到端 TLS (H2)、后端账号。
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
兼容 Cursor 版本：`3.0.16`。

#### macOS Apple Silicon

```bash
# Download
curl -L -o agent-vibes-darwin-arm64-0.1.12.vsix https://github.com/funny-vibes/agent-vibes/releases/download/v0.1.12/agent-vibes-darwin-arm64-0.1.12.vsix

# Install
cursor --install-extension agent-vibes-darwin-arm64-0.1.12.vsix --force
```

#### macOS Intel

```bash
# Download
curl -L -o agent-vibes-darwin-x64-0.1.12.vsix https://github.com/funny-vibes/agent-vibes/releases/download/v0.1.12/agent-vibes-darwin-x64-0.1.12.vsix

# Install
cursor --install-extension agent-vibes-darwin-x64-0.1.12.vsix --force
```

#### Linux x64

```bash
# Download
curl -L -o agent-vibes-linux-x64-0.1.12.vsix https://github.com/funny-vibes/agent-vibes/releases/download/v0.1.12/agent-vibes-linux-x64-0.1.12.vsix

# Install
cursor --install-extension agent-vibes-linux-x64-0.1.12.vsix --force
```

#### Windows x64

```powershell
# Download
Invoke-WebRequest -Uri "https://github.com/funny-vibes/agent-vibes/releases/download/v0.1.12/agent-vibes-win32-x64-0.1.12.vsix" -OutFile "agent-vibes-win32-x64-0.1.12.vsix"

# Install
cursor --install-extension agent-vibes-win32-x64-0.1.12.vsix --force
```

安装后重启 Cursor，扩展会自动启动代理服务器并引导你完成首次配置（SSL 证书、账号同步、网络转发等均可在命令面板中操作）。

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

Cursor 需要 HTTPS 拦截，以下为一次性设置：

```bash
agent-vibes forward hosts        # 在 hosts 中添加 DNS 重定向
agent-vibes forward on           # 开启端口转发
agent-vibes                      # 启动代理
agent-vibes forward status       # 验证是否正常工作
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

### 扩展命令

这个扩展会在命令面板里保留一组安装 / 配置相关的必要命令，而运行期状态与细粒度操作主要放在 Dashboard 中完成。

#### 安装 / 配置命令

| 步骤 | 命令面板标题                                      | Command ID                            | 用途                                                                     |
| ---- | ------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| 1    | Agent Vibes: Open Dashboard                       | `agentVibes.openDashboard`            | 打开主 Dashboard，先查看当前安装状态。                                   |
| 2    | Agent Vibes: Generate SSL Certificates            | `agentVibes.generateCert`             | 生成 HTTPS 拦截所需的本地证书。                                          |
| 3    | Dashboard → Accounts                              | _主入口_                              | 在账号管理 tab 中完成账号配置；支持新增、编辑、OAuth、token 导入等操作。 |
| 3    | Agent Vibes: Sync Antigravity IDE Credentials     | `agentVibes.syncAntigravityIDE`       | 从 Antigravity IDE 导入凭据。                                            |
| 3    | Agent Vibes: Sync Antigravity Tool Credentials    | `agentVibes.syncAntigravityTools`     | 从 Antigravity Manager / tools 导入凭据。                                |
| 3    | Agent Vibes: Sync Claude Credentials              | `agentVibes.syncClaude`               | 将 Claude 兼容凭据同步到 Agent Vibes。                                   |
| 3    | Agent Vibes: Sync Codex Credentials               | `agentVibes.syncCodex`                | 将 Codex 凭据同步到 Agent Vibes。                                        |
| 3    | Agent Vibes: Open OpenAI-Compatible Accounts JSON | `agentVibes.openOpenAICompatAccounts` | 打开 `openai-compat-accounts.json` 进行手动配置。                        |
| 3    | Agent Vibes: Open Claude API Accounts JSON        | `agentVibes.openClaudeApiAccounts`    | 打开 `claude-api-accounts.json` 进行手动配置。                           |
| 4    | Agent Vibes: Start Server                         | `agentVibes.startServer`              | 在证书和至少一个账号准备完成后启动本地 bridge。                          |
| 5    | Agent Vibes: Enable Port Forwarding               | `agentVibes.enableForwarding`         | 启用 Cursor 流量拦截所需的本地转发。                                     |
| 5    | Agent Vibes: Disable Port Forwarding              | `agentVibes.disableForwarding`        | 关闭本地转发。                                                           |
| 6    | Agent Vibes: Port Forwarding Status               | `agentVibes.forwardingStatus`         | 检查 forwarding 与 hosts 配置状态。                                      |
| 7    | Agent Vibes: Edit Configuration                   | `agentVibes.openConfig`               | 打开 Cursor 中的 `agentVibes` 设置。                                     |
| 8    | Agent Vibes: Check Extension Updates              | `agentVibes.checkExtensionUpdates`    | 检查 GitHub Releases 上是否有新的 VSIX。                                 |

#### Dashboard tabs

| Tab             | 用途                                           |
| --------------- | ---------------------------------------------- |
| **Overview**    | 安装状态、快捷操作、后端概览                   |
| **Accounts**    | 账号管理、OAuth、token 导入、pool / quota 详情 |
| **Analytics**   | usage summary 与后端 / 运行期统计              |
| **Settings**    | 扩展设置与路径覆盖                             |
| **Diagnostics** | 内置检查项                                     |
| **Logs**        | bridge 日志与 debug 开关                       |

### 日常使用

#### Cursor IDE

- 打开 Cursor，扩展会自动启动本地 bridge。
- 如需确认运行状态，打开 Dashboard 查看 Overview、Accounts、Logs 与 Diagnostics。
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

| 路径                         | 方法 | 协议                         | 说明                     |
| ---------------------------- | ---- | ---------------------------- | ------------------------ |
| `/v1/messages`               | POST | Anthropic Messages API (SSE) | Claude Code CLI          |
| `/v1/messages/count_tokens`  | POST | Anthropic Messages API       | 请求 token 计数          |
| `/agent.v1.AgentService/Run` | POST | ConnectRPC (HTTP/2 BiDi)     | Cursor IDE（Agent 模式） |
| `/v1/models`                 | GET  | REST JSON                    | Anthropic 模型列表       |
| `/v1/anthropic/models`       | GET  | REST JSON                    | 可用模型列表             |
| `/health`                    | GET  | REST JSON                    | 健康检查                 |
| `/docs`                      | GET  | Swagger UI                   | API 文档                 |

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
