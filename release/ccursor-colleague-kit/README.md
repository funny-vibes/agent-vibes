# CCursor 同事安装包

用途：让 Cursor 原生 Agent 通过公司 AI 中台调用模型。同事只需要本机已经有 Codex，并且 `~/.codex/config.toml` 里配置好了 `model_provider`、`base_url` 和 key。

## macOS 安装

1. 双击 `Install CCursor.command`
2. 双击 `Open Cursor with CCursor.command`
3. Cursor 打开后等待 10-20 秒
4. 在 Cursor Agent 里选择 `gpt-5.5`，发起一次真实任务测试

## Windows 安装

1. 右键 `Install CCursor.ps1`，选择 `Run with PowerShell`
2. 右键 `Open Cursor with CCursor.ps1`，选择 `Run with PowerShell`
3. Cursor 打开后等待 10-20 秒
4. 在 Cursor Agent 里选择 `gpt-5.5`，发起一次真实任务测试

## 检查

macOS 双击 `Check CCursor.command`。

Windows 右键 `Check CCursor.ps1`，选择 `Run with PowerShell`。

检查项包括：

- 是否能读取 `~/.codex/config.toml`
- 是否已写入 `~/.ccursor/data/openai-compat-accounts.json`
- Cursor 是否已安装 `local-ai.ccursor`
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
- 如果检查显示 bridge 未启动，先用 `Open Cursor with CCursor.command` 打开 Cursor，再等 10-20 秒。
- 如果 Cursor 里仍然连接失败，完整退出 Cursor 后重新用 `Open Cursor with CCursor.command` 打开。
