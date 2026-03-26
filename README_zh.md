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
- **Cursor IDE** — 逆向实现的原生 ConnectRPC/gRPC 协议

**后端**（后端）：

- **Antigravity IDE** — 带原生指纹与原生协议的 Google Cloud Code API
- **Codex CLI** — 面向 GPT 与 Codex 模型的 OpenAI 兼容 API

作为一名长期远程做自由开发和 AI 编程辅导的独立开发者，我几乎每天都在高频使用 AI 编程工具。
Agent Vibes 的诞生，来自于把多个 AI 后端统一到同一个代理之后的实际需求。这样我就能在本地和云端都使用当前最强的模型，在 Claude Code CLI 和 Cursor IDE 之间无缝切换，而不必关心背后到底是哪一个后端在处理请求。在此之前，我的日常主力环境是 **Antigravity IDE Ultra**。

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
│  Gemini / Claude  → Antigravity IDE (Cloud Code)            │
│  GPT / Codex      → Codex CLI                               │
│                                                             │
+ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
```

## 功能特性

| 客户端          | 协议                         | 后端                       | 模型                       |
| --------------- | ---------------------------- | -------------------------- | -------------------------- |
| Claude Code CLI | Anthropic Messages API (SSE) | Antigravity IDE, Codex CLI | Gemini, Claude, GPT, Codex |
| Cursor IDE      | ConnectRPC/gRPC（逆向实现）  | Antigravity IDE, Codex CLI | Gemini, Claude, GPT, Codex |

## 与 CLIProxyAPI 的差异

CLIProxyAPI 是这个项目最接近的参考项目，但两者重心不同。
CLIProxyAPI 更偏 API-first 和 CLI 场景；Agent Vibes 则把主要精力放在 Cursor 的原生客户端兼容性，以及 Antigravity 的原生上游保真度上。

- **Cursor：** Agent Vibes 并不止步于 OpenAI / Claude 兼容接口，而是直接逆向了 Cursor 原生 ConnectRPC/gRPC Agent 通道，从 Cursor 二进制中提取 protobuf 定义，并直接实现流式工具循环。
- **Antigravity：** 本仓库当前的主路径是较新的 worker-native 防封导向方案，围绕运行 Antigravity 自身运行时与模块来构建，使 Cloud Code 请求尽量保持 IDE 原生指纹，并在此基础上实现配额感知的 worker 轮转。
- **实现方式：** 代码库中有大量部分移植、改造并融合自 CLIProxyAPI 和许多其他开源项目，再在 TypeScript/NestJS 架构中重新落地。整个项目本身也是以 vibe-coding 的方式端到端搭建出来的。

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

同步你的 Antigravity 凭据（[Antigravity IDE](https://antigravity.google) 或 [Antigravity Manager](https://github.com/lbjlaq/Antigravity-Manager)，需要 Pro 或 Ultra）：

```bash
agent-vibes sync --ide       # 从 Antigravity IDE 同步
agent-vibes sync --tools     # 从 Antigravity Manager 同步
```

### 配合 Claude Code CLI 使用

```bash
agent-vibes                  # 启动代理
```

在另一个终端中：

```bash
export ANTHROPIC_BASE_URL=https://localhost:8000
claude
```

> **提示：** 可以把 `export ANTHROPIC_BASE_URL=https://localhost:8000` 写入你的 shell profile，以便长期生效。

### 配合 Cursor IDE 使用

Cursor 客户端侧使用 free 账号即可，不需要开通 Cursor 付费订阅。

Cursor 需要 HTTPS 拦截，以下为一次性设置：

```bash
# 1. 在 hosts 中添加 DNS 重定向
agent-vibes forward hosts

# 2. 开启端口转发（macOS 使用 TCP relay，Linux 使用 iptables，Windows 使用 netsh）
agent-vibes forward on
```

> **可选：** `agent-vibes patch` 会对 Cursor 二进制进行补丁处理，以便代理拦截和调试抓取。

然后启动代理：

```bash
agent-vibes
```

验证是否正常工作：

```bash
agent-vibes forward status
```

> **提示：** 当 Cursor 通过 Codex 后端使用 GPT / O 系列 / Codex 模型时，普通 Thinking 对应标准推理档位。若要加载 Codex 最高推理档位，需要同时开启 `Thinking` 与 `Max mode`。

### 环境变量

本地开发默认可零配置启动。部署到服务器时，请在 `apps/protocol-bridge/.env.local` 中配置：

| 变量                   | 默认值               | 说明                        |
| ---------------------- | -------------------- | --------------------------- |
| `PORT`                 | `8000`               | 服务端口                    |
| `PROXY_API_KEY`        | _(disabled)_         | 为所有请求启用 API Key 校验 |
| `ANTIGRAVITY_STORAGE`  | `~/.protocol-bridge` | Antigravity 凭据目录        |
| `ANTIGRAVITY_APP_PATH` | _(auto-detect)_      | 可选的 Antigravity.app 路径 |

## Codex 后端（GPT / O 系列模型）

如果你需要使用 GPT、O 系列或 Codex 模型，可以这样配置：

目前 Codex 后端支持三种接入方式：

- 同步本地 Codex CLI / ChatGPT 登录态
- 直接填写官方 OpenAI API Key
- 填写第三方 Codex-compatible Key，并指定自定义 Base URL

**方式 1：同步 Codex CLI 登录态**

```bash
agent-vibes sync --codex
# or
npm run codex:sync
```

**方式 2：直接填写 API Key**

在 `apps/protocol-bridge/.env.local` 中设置 `CODEX_API_KEY`。

**方式 3：使用第三方 Codex-compatible Key**

在 `apps/protocol-bridge/.env.local` 中同时设置 `CODEX_BASE_URL` 和 `CODEX_API_KEY`：

```dotenv
CODEX_BASE_URL=https://example.com/codex
CODEX_API_KEY=sk-xxx
```

`CODEX_BASE_URL` 需要填写 Codex / Responses 接口的父路径，不要带末尾的 `/responses`，因为 Agent Vibes 会自动拼接。

> **说明：** 如果同时配置了 `OPENAI_COMPAT_BASE_URL` + `OPENAI_COMPAT_API_KEY` 和 `CODEX_*`，那么 GPT / O 系列请求会优先走 OpenAI-compatible 后端；否则走 Codex 后端。

然后启动代理：

```bash
agent-vibes
```

之后就可以在 Claude Code CLI 或 Cursor 中直接选择 GPT / O 系列 / Codex 模型。

在 Cursor 中，Codex 的最高推理档位通过 `Thinking + Max mode` 加载。

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
│       ├── proto/                             # Protobuf 定义（从 Cursor 二进制提取）
│       └── data/                              # Antigravity OAuth 账号数据
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

## 命令

### 开发

```bash
npm run dev                    # 启动开发服务器（turbo watch mode）
npm run build                  # 构建所有包
npm run start                  # 启动生产服务
```

### 代码质量

```bash
npm run lint                   # ESLint 检查
npm run lint:fix               # 自动修复 lint 问题
npm run format                 # Prettier 检查
npm run format:fix             # 自动修复格式问题
npm run types                  # TypeScript 类型检查
```

### Proxy 应用（在 `apps/protocol-bridge/` 目录下）

```bash
npm run dev                    # NestJS watch mode
npm run build                  # 构建到 dist/
npm run test                   # 运行 Jest 测试
npm run proto:gen              # 由 proto 生成 TypeScript
```

### Cursor 集成

```bash
npm run cursor:cert            # 生成 SSL 证书（mkcert）
npm run cursor:patch           # 给 Cursor 二进制打补丁以进行代理拦截
npm run cursor:debug           # 调试 Cursor 连接
npm run cursor:forward:on      # 开启端口转发（需要 sudo/admin）
npm run cursor:forward:off     # 关闭端口转发（需要 sudo/admin）
npm run cursor:forward:status  # 查看转发状态
```

如果 Cursor 安装在非默认位置，可为这些工具脚本设置 `CURSOR_BINARY_PATH`、`CURSOR_WORKBENCH_PATH` 或 `CURSOR_APP_ROOT`。

### 部署

```bash
npm run release                # 合并 dev → master → push（触发 CI 部署）
npm run antigravity:sync       # 同步 Antigravity OAuth 账号到 ANTIGRAVITY_STORAGE
npm run codex:sync             # 将 Codex CLI auth.json 同步到 CODEX_* 环境变量
```

### 诊断

```bash
npm run issues                 # 收集日志与环境信息，并复制到剪贴板
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
- **`deploy-proxy.yml`** — push 到 `master` 时自动部署（仅在 `apps/protocol-bridge/**` 变更时触发）
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
| `master`           | 生产分支（push 后自动部署） |
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
