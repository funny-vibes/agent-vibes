# CCursor 同事安装包

用途：让 Cursor 原生 Agent 通过公司 AI 中台调用模型。同事只需要本机已经有 Codex，并且 `~/.codex/config.toml` 里配置好了 `model_provider`、`base_url` 和 key。

默认走 OpenAI Chat Completions 协议，也就是 `preferResponsesApi=false`。当前 Skylink AI 中台的 Responses API 在大上下文/流式场景下不稳定，安装包会主动避开这条路径。

这个包提供两个入口：

- `Open Cursor Official`：不走 CCursor 代理，使用 Cursor 官方账号和官方模型。
- `Open Cursor with CCursor`：走本机 CCursor 代理，使用 Codex 配置里的 AI 中台。

两个入口使用独立 Cursor profile，避免官方模型、AI 中台、扩展和登录态互相污染。

## macOS 安装

1. 双击 `Install CCursor.command`
2. 使用官方模型时，双击 `Open Cursor Official.command`
3. 使用 AI 中台时，双击 `Open Cursor with CCursor.command`
4. 启动器会先确认本机 bridge 健康，再打开 Cursor
5. 在 Cursor Agent 里选择 `gpt-5.5`，发起一次真实任务测试

## Windows 安装

1. 右键 `Install CCursor.ps1`，选择 `Run with PowerShell`
2. 使用官方模型时，右键 `Open Cursor Official.ps1`，选择 `Run with PowerShell`
3. 使用 AI 中台时，右键 `Open Cursor with CCursor.ps1`，选择 `Run with PowerShell`
4. 启动器会先确认本机 bridge 健康，再打开 Cursor
5. 在 Cursor Agent 里选择 `gpt-5.5`，发起一次真实任务测试

## 如何同时使用官方模型和 AI 中台

同时打开两个窗口即可：

- 官方窗口：从 `Open Cursor Official` 启动。这里使用 Cursor 官方模型。
- 中台窗口：从 `Open Cursor with CCursor` 启动。这里使用你的 AI 中台模型。

不要用同一个 Cursor 窗口来回切。当前 CCursor 实现是在启动时给整个 Cursor 进程挂本地代理，所以同一实例内不适合同时混用官方链路和中台链路。

## 检查

macOS 双击 `Check CCursor.command`。

Windows 右键 `Check CCursor.ps1`，选择 `Run with PowerShell`。

检查项包括：

- 是否能读取 `~/.codex/config.toml`
- 是否已写入 `~/.ccursor/data/openai-compat-accounts.json`
- CCursor 账号是否使用稳定的 Chat Completions 路径：`preferResponsesApi=false`
- 默认 Cursor 和隔离 CCursor profile 是否已安装 `local-ai.ccursor`
- CCursor bridge 是否在 `https://localhost:2026` 正常运行
- Cursor 代理 `http://127.0.0.1:18080` 是否可达

## 配置来源

安装脚本会读取 Codex 配置：

```toml
model = "gpt-5.5"
model_provider = "touka"

[model_providers.touka]
base_url = "https://example.com/api/v1"
experimental_bearer_token = "..."
```

也兼容这些 key 字段：

- `api_key`
- `apiKey`
- `experimental_bearer_token`
- `env_key`
- `api_key_env`

脚本不会打印完整 key。

## 常见处理

- 如果 macOS 阻止打开 `.command`，右键点击文件，选择打开。
- 如果检查显示 bridge 未启动，重新运行 `Open Cursor with CCursor`；启动器会先尝试拉起 bridge。
- 如果 Cursor 里仍然连接失败，完整退出 CCursor profile 窗口后重新用 `Open Cursor with CCursor` 打开。
- 如果需要 Cursor 官方模型，用 `Open Cursor Official`，不要从 CCursor 窗口里切回官方模型。
