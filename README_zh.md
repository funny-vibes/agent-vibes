# Agent Vibes

[English](README.md) | 中文

> **统一 Agent 网关** — 通过 **Claude Code CLI** 和 **Cursor IDE** 使用 **Antigravity** 与 **Codex** AI 后端。

[![CI](https://github.com/funny-vibes/agent-vibes/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/funny-vibes/agent-vibes/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com/)
[![Fastify](https://img.shields.io/badge/Fastify-HTTP%2F2-000000?logo=fastify&logoColor=white)](https://fastify.dev/)

## 概览

Agent Vibes 是一个代理服务器，通过协议转换将 AI 编程客户端连接到不同的 AI 后端。

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

- `Claude Code CLI`: 协议 `Anthropic Messages API (SSE)`，后端 `Antigravity IDE / Claude 兼容 API / Codex CLI`，模型 `Gemini / Claude / GPT`
- `Cursor IDE`: 协议 `ConnectRPC/gRPC（协议兼容）`，后端 `Antigravity IDE / Claude 兼容 API / Codex CLI`，模型 `Gemini / Claude / GPT`

## 与 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的差异

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 是这个项目最接近的参考项目，但两者重心不同。
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 更偏 API-first 和 CLI 场景；Agent Vibes 则把主要精力放在 Cursor 的原生客户端兼容性，以及 Antigravity 的原生上游保真度上。

- **Cursor：** Agent Vibes 并不止步于 OpenAI / Claude 兼容接口，而是直接实现了 Cursor 原生 ConnectRPC/gRPC Agent 通道，以协议兼容的 protobuf 定义实现了互操作性，并直接实现流式工具循环。
- **Antigravity：** 本仓库当前的主路径是较新的 worker-native 方案，围绕运行 Antigravity 自身运行时与模块来构建，使 Cloud Code 请求保持协议兼容，并在此基础上实现配额感知的 worker 轮转。
- **致谢：** 本项目借鉴和移植了大量开源项目的代码与思路，其中 Claude Code CLI 和 Codex CLI 主要参考
  [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)，在 TypeScript/NestJS 架构下重写。Cursor 原生协议层和 Antigravity worker 池为原创实现。

## 快速开始

### 安装与初始化（必需）

**源码安装（全平台）：**

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

上面这一步完成安装。下面开始选择你的上游来源。

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

### 日常使用

#### 配合 Claude Code CLI 使用

```bash
agent-vibes                  # 启动代理
```

在另一个终端中：

```bash
export ANTHROPIC_BASE_URL=https://localhost:8000
claude
```

> **提示：** 可以把 `export ANTHROPIC_BASE_URL=https://localhost:8000` 写入你的 shell profile，以便长期生效。

#### 配合 Cursor IDE 使用

Cursor 客户端侧使用 free 账号即可，不需要开通 Cursor 付费订阅。

Cursor 需要 HTTPS 拦截，以下为一次性设置：

```bash
# 1. 在 hosts 中添加 DNS 重定向
agent-vibes forward hosts

# 2. 开启端口转发（macOS 使用 TCP relay，Linux 使用 iptables，Windows 使用 netsh）
agent-vibes forward on
```

然后启动代理：

```bash
agent-vibes
```

验证是否正常工作：

```bash
agent-vibes forward status
```

## 后端配置参考

### 1. Antigravity

用于接入 Antigravity / Google Cloud Code。

配置方式：

```bash
agent-vibes sync --ide
agent-vibes sync --tools
```

行为：

- 凭据会同步到 `apps/protocol-bridge/data/antigravity-accounts.json`。
- 支持多账号轮转。

### 2. GPT

用于接入 GPT 模型。

配置方式：

- Codex：

```bash
codex --login
agent-vibes sync --codex
```

- OpenAI 兼容配置文件：`apps/protocol-bridge/data/openai-compat-accounts.json`

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

行为：

- Codex 和 OpenAI 兼容后端都支持多账号轮转。
- 同时配置 OpenAI 兼容后端和 Codex 后端时，GPT 请求优先走 OpenAI 兼容后端。
- 额度耗尽时自动切换到下一个可用账号。

### 3. Claude API

用于接入第三方 Claude 兼容 API。

配置方式：

- `agent-vibes sync --claude` 会读取 `~/.claude/settings.json`，并在 `apps/protocol-bridge/data/claude-api-accounts.json` 中写入或更新一个受管理的 `claude-code-sync` 条目。
- 或手动编辑 `apps/protocol-bridge/data/claude-api-accounts.json`：

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
- 如果没有配置 `models`，则会把请求里的 Claude 模型名原样透传到上游。
- `stripThinking=true` 时，会在转发前移除 Anthropic thinking 相关字段，适合只支持基础 Claude 模型名的第三方端点。
- `excludedModels` 支持大小写不敏感的通配符写法，例如 `claude-3-*`、`*-thinking`、`*haiku*`。
- 官方 `api.anthropic.com` 使用 `x-api-key`；第三方兼容端点使用 `Authorization: Bearer ...`。

## 项目结构

```text
agent-vibes/
├── bin/
│   └── agent-vibes                            # CLI 入口
├── apps/
│   └── protocol-bridge/                       # 主代理服务（NestJS + Fastify）
│       ├── src/
│       │   ├── main.ts                        # 应用启动（Fastify 适配器、CORS、Swagger）
│       │   ├── app.module.ts                  # NestJS 根模块
│       │   ├── health.controller.ts           # 健康检查 + 进程池状态
│       │   │
│       │   ├── protocol/                      # ← 协议适配层
│       │   │   ├── cursor/                    #   CursorModule — Cursor IDE (ConnectRPC)
│       │   │   │   ├── cursor.module.ts
│       │   │   │   ├── cursor-adapter.controller.ts
│       │   │   │   ├── cursor-connect-stream.service.ts
│       │   │   │   ├── cursor-grpc.service.ts
│       │   │   │   └── ...                    #   （认证、解析、会话等）
│       │   │   └── anthropic/                 #   AnthropicModule — Claude Code CLI
│       │   │       ├── anthropic.module.ts
│       │   │       ├── messages.controller.ts #   POST /v1/messages
│       │   │       ├── messages.service.ts
│       │   │       └── dto/                   #   请求 DTO
│       │   │
│       │   ├── context/                       # ← 会话上下文
│       │   │   ├── history.module.ts          #   HistoryModule
│       │   │   ├── tokenizer.module.ts        #   TokenizerModule
│       │   │   ├── conversation-truncator.service.ts
│       │   │   ├── tokenizer.service.ts
│       │   │   └── ...                        #   （摘要、计数、工具一致性等）
│       │   │
│       │   ├── llm/                           # ← LLM 层（路由 + Provider）
│       │   │   ├── model.module.ts            #   ModelModule
│       │   │   ├── model-registry.ts          #   模型别名 → 后端 ID 映射
│       │   │   ├── model-router.service.ts    #   多后端分发
│       │   │   ├── claude-api/                #   ClaudeApiModule — Claude 兼容 key 池
│       │   │   ├── google/                    #   GoogleModule — Cloud Code API
│       │   │   ├── codex/                     #   CodexModule — OpenAI Codex 反向代理
│       │   │   ├── native/                    #   NativeModule — 进程池 workers
│       │   │   └── websearch/                 #   WebsearchModule — 网络搜索
│       │   │
│       │   ├── shared/                        # 基础设施（启动、守卫、环境、类型）
│       │   │   ├── content-type-parsers.ts    #   gRPC/ConnectRPC 请求体解析
│       │   │   ├── request-hooks.ts           #   请求日志钩子
│       │   │   ├── env.validation.ts          #   环境变量校验
│       │   │   ├── api-key.guard.ts           #   API Key 鉴权守卫
│       │   │   └── anthropic.ts, cloud-code.ts #  共享 TypeScript 类型
│       │   │
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
    ├── diagnostics/                           # 一键问题收集
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

> **提示：** 可以运行 `agent-vibes issues`（或 `npm run issues`）自动收集诊断信息，结果会复制到剪贴板中，方便你直接粘贴到 bug 模板里。

提交 PR 前，请先阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

pre-commit hooks 会自动执行 lint 和 format 检查。

---

祝你 Vibe Coding 顺利！

## License

[MIT](LICENSE) © 2025-2026 recronin
