# Cursor Self-managed Skylink 网关安装说明

这个包用于在不依赖 ccursor/LinuxDo 登录的情况下，让 Cursor Agent 通过自己的
Skylink/OpenAI-Compatible API Key 调用 `gpt-5.5`。默认启用 Responses API 和
fast/priority 服务档位。

## 能力

- Cursor Agent 可选择 `gpt-5.5` 系列模型。
- 默认走 `https://skylink-gateway.com/api/v1/responses`。
- 默认开启 fast：请求体带 `service_tier=priority`。
- 支持 macOS、Linux、Windows。

## 安装前准备

1. 安装 Node.js 24+ 和 npm 11+。
2. 准备 Skylink API Key，格式类似 `sk-...`。
3. 关闭 Cursor，安装完成后再重新打开。
4. macOS/Linux 需要允许脚本修改本机 Cursor Agent 路由；Windows 需要管理员
   PowerShell。

## macOS / Linux 一键安装

在解压后的目录执行：

```bash
SKYLINK_API_KEY="sk-..." ./scripts/self-managed/install-self-managed.sh
```

如果不想开启 fast：

```bash
SKYLINK_API_KEY="sk-..." ./scripts/self-managed/install-self-managed.sh --no-fast
```

查看状态：

```bash
node ./bin/agent-vibes self-managed status
```

正常状态应看到：

- `Bridge: healthy`
- `responses=prefer`
- `tier=priority`

## Windows 一键安装

用管理员 PowerShell 进入解压后的目录：

```powershell
$env:SKYLINK_API_KEY = "sk-..."
powershell -ExecutionPolicy Bypass -File .\scripts\self-managed\install-self-managed.ps1
```

如果不想开启 fast：

```powershell
$env:SKYLINK_API_KEY = "sk-..."
powershell -ExecutionPolicy Bypass -File .\scripts\self-managed\install-self-managed.ps1 -NoFast
```

查看状态：

```powershell
node .\bin\agent-vibes self-managed status
```

## 自定义配置

使用其他 OpenAI-Compatible 地址：

```bash
SKYLINK_API_KEY="sk-..." \
OPENAI_COMPAT_BASE_URL="https://your-gateway.example.com/api/v1" \
./scripts/self-managed/install-self-managed.sh
```

手动安装等价命令：

```bash
npm install
node ./bin/agent-vibes self-managed install \
  --base-url https://skylink-gateway.com/api/v1 \
  --api-key "$SKYLINK_API_KEY" \
  --responses-mode always \
  --prefer-responses \
  --service-tier priority \
  --max-context-tokens 200000
```

## 验证 Cursor

1. 完全退出 Cursor。
2. 重新打开 Cursor。
3. 打开 Agent 面板，选择 `gpt-5.5` 或 `gpt-5.5 xHigh`。
4. 发送一条简单消息。
5. 如果消息能返回，说明 Cursor Agent 已经通过本地网关请求到 Skylink。

## 常见问题

### Cursor 发消息不回复

先检查本地服务：

```bash
node ./bin/agent-vibes self-managed status
```

如果 `Bridge` 不是 healthy，重新安装：

```bash
SKYLINK_API_KEY="sk-..." ./scripts/self-managed/install-self-managed.sh
```

### fast 是否开启

执行：

```bash
node ./bin/agent-vibes self-managed status
```

看到 `tier=priority` 就是 fast 已开启。

### 是否需要 LinuxDo 登录

不需要。这个 self-managed 方案使用你自己的 Skylink/OpenAI-Compatible API Key，
不依赖 ccursor，也不依赖 LinuxDo 登录态。

### 卸载

```bash
node ./bin/agent-vibes self-managed uninstall
```
