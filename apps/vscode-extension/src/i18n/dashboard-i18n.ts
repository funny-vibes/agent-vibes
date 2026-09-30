import * as vscode from "vscode"

export type DashboardLocale = "en" | "zh"

export function readDashboardLocale(): DashboardLocale {
  const raw =
    vscode.workspace.getConfiguration("agentVibes").get<string>("language") ??
    "en"
  return raw === "zh" ? "zh" : "en"
}

export function getDashboardPanelTitle(locale: DashboardLocale): string {
  return locale === "zh" ? "Agent Vibes 控制台" : "Agent Vibes Dashboard"
}

/** Flat strings for the dashboard webview (`L(key)`). */
const UI_EN: Record<string, string> = {
  "page.lang": "en",
  "page.title": "Agent Vibes Dashboard",
  "page.tagline": "Unified AI Agent Gateway - Happy vibing!",
  "tab.overview": "Overview",
  "tab.endpoints": "API",
  "endpoints.title": "API",
  "endpoints.subtitle":
    "HTTP endpoints exposed by this bridge. Copy a URL, run a connectivity test, or wire it into the matching client.",
  "endpoints.action.copy": "Copy",
  "endpoints.action.test": "Test",
  "endpoints.action.applyClaude": "Apply to Claude CLI",
  "endpoints.action.applyCursor": "Patch Cursor",
  "endpoints.toast.copied": "Copied",
  "endpoints.toast.testing": "Testing…",
  "endpoints.status.ready": "Ready",
  "endpoints.status.online": "Online",
  "endpoints.status.offline": "Offline",
  "endpoints.status.checking": "Checking…",
  "endpoints.status.connecting": "Connecting…",
  "endpoints.status.disconnecting": "Disconnecting…",
  "endpoints.anthropic.name": "Anthropic API",
  "endpoints.anthropic.desc":
    "Drop-in replacement for api.anthropic.com. Used by Claude Code CLI and any Anthropic-compatible SDK.",
  "endpoints.cursor.name": "Cursor IDE Protocol",
  "endpoints.cursor.desc":
    "Patch Cursor to connect to this bridge directly. Hosts and local port forwarding are not required.",
  "endpoints.health.name": "Health Check",
  "endpoints.health.desc":
    "Liveness probe — returns bridge runtime status as JSON.",
  "endpoints.openai.name": "OpenAI API",
  "endpoints.openai.desc":
    "Drop-in replacement for api.openai.com. Used by the OpenAI SDK and any OpenAI-compatible client (chat/completions, completions, models).",
  "endpoints.google.name": "Google API",
  "endpoints.gemini.desc":
    "Drop-in for generativelanguage.googleapis.com. Used by Gemini CLI / google-genai SDK.",
  "tab.clients": "Clients",
  "clients.title": "Client integrations",
  "clients.subtitle": "Wire your local AI clients to this bridge.",
  "clients.status.wired": "Wired",
  "clients.status.notWired": "Not wired",
  "clients.status.patched": "Patched",
  "clients.status.patch": "Patch Cursor",
  "clients.status.updatePatch": "Update Patch",
  "clients.status.forwarding": "Forwarding",
  "clients.status.offline": "Offline",
  "clients.status.builtin": "Built-in",
  "clients.status.comingSoon": "Coming soon",
  "clients.action.wire": "Wire to Bridge",
  "clients.action.unwire": "Unwire",
  "clients.action.copy": "Copy",
  "clients.action.refresh": "Refresh",
  "clients.client.claudeCode": "Claude Code CLI",
  "clients.client.cursorIde": "Cursor IDE",
  "clients.client.codexCli": "Codex CLI",
  "clients.client.geminiCli": "Gemini CLI",
  "clients.client.cursorCli": "Cursor CLI",
  "clients.claudeCode.desc":
    "Rewrites ~/.claude/settings.json env so the CLI calls this bridge instead of api.anthropic.com.",
  "clients.cursorIde.desc":
    "Patch Cursor to connect to this bridge directly. Hosts and local port forwarding are not required.",
  "clients.cursorIde.endpoint": "Bridge endpoint",
  "clients.comingSoon.desc": "Integration is planned but not yet implemented.",
  "tab.accounts": "Accounts",
  "tab.analytics": "Analytics",
  "tab.settings": "Settings",
  "tab.tests": "Diagnostics",
  "tab.logs": "Logs",
  "section.status": "Status",
  "section.actions": "Actions",
  "section.backends": "Backends",
  "section.clients": "Clients",
  "clients.manage": "Manage →",
  "section.accounts": "Accounts",
  "section.tokenUsage": "Token Usage",
  "section.sessionRuntime": "Session Runtime",
  "section.byBackend": "By Backend",
  "section.byRoute": "By Route",
  "section.topModels": "Top Models",
  "section.topAccounts": "Top Accounts",
  "section.recentActivity": "Recent Activity",
  "section.diagnostics": "Diagnostics",
  "section.bridgeLog": "Bridge Log",
  "meta.extension": "Extension",
  "meta.cursor": "Cursor",
  "meta.compat": "Compat",
  checkUpdates: "Check updates",
  checkingUpdates: "Checking…",
  refresh: "Refresh",
  refreshing: "Refreshing…",
  runAll: "Run All",
  run: "Run",
  "dlg.cancel": "Cancel",
  "dlg.add": "Add",
  "dlg.save": "Save",
  "toggle.on": "On",
  "toggle.off": "Off",
  "action.start": "Start",
  "action.stop": "Stop",
  "action.restart": "Restart",
  "action.enableForwarding": "Enable forwarding",
  "action.disableForwarding": "Disable forwarding",
  "action.clearCache": "Clear session data",
  "status.health": "Health",
  "status.ssl": "SSL",
  "status.cursor": "Cursor",
  "status.forwarding": "Forwarding",
  "status.port": "Port",
  "status.accounts": "Accounts",
  "status.online": "Online",
  "status.offline": "Offline",
  "status.valid": "Valid",
  "status.missing": "Missing",
  "status.active": "Active",
  "status.idle": "Idle",
  "backend.notConfigured": "Not configured",
  "backend.accountCount": "{n} account(s)",
  "backend.addAccountTitle": "Add account",
  "accounts.selectDetail": "Select an account to view details",
  "accounts.selectChannel": "Select a channel",
  "accounts.noAccounts": "No accounts configured",
  "accounts.edit": "Edit",
  "accounts.remove": "Remove",
  "accounts.cli": "CLI",
  "accounts.kiroForceLogin": "Login IDE",
  "accounts.kiroForceCliLogin": "Login CLI",
  "accounts.add": "+ Add",
  "accounts.pagination": "{start}–{end} of {total}",
  "accounts.prev": "← Prev",
  "accounts.next": "Next →",
  "accounts.refreshTitle": "Refresh Status",
  "group.google": "Google",
  "group.openai": "OpenAI",
  "group.anthropic": "Anthropic",
  "group.amazon": "Amazon",
  "ch.antigravity": "Antigravity IDE",
  "ch.codex": "Codex CLI",
  "ch.openaiCompat": "OpenAI-Compatible",
  "ch.claudeApi": "Claude Code CLI",
  "ch.kiro": "Kiro",
  "ch.sync.antigravityIde": "Sync Antigravity IDE",
  "ch.sync.antigravityTool": "Sync Antigravity Tool",
  "ch.sync.codexCli": "Sync Codex CLI",
  "ch.sync.cpa": "Sync CPA",
  "ch.sync.claude": "Sync Claude",
  "field.label": "Label",
  "field.baseUrl": "Base URL",
  "field.apiKey": "API Key",
  "field.maxContextTokens": "Max Context Tokens",
  "field.proxyUrl": "Proxy URL (optional)",
  "field.refreshToken": "Refresh Token",
  "field.tokenHint":
    "Format: 1//xxx (Google) or rt_xxx (OpenAI). Batch supported.",
  "field.tokenHintGoogle": "Format: 1//xxx (Google). Batch supported.",
  "field.tokenPlaceholder":
    "Paste token(s)...\nSupports: single, JSON array, or multi-line",
  "field.kiroApiKey": "Kiro API Key",
  "field.kiroApiKeyPlaceholder": "Paste your Kiro API key (e.g. aws-...)",
  "field.kiroApiKeyHint":
    "Personal API key issued by Kiro. Stored locally as authMethod=api_key.",
  "acct.synced": "Synced account",
  "acct.noToken": "No token",
  "acct.unknown": "Unknown",
  "acct.unnamed": "Unnamed",
  "oauth.googleTab": "Google OAuth",
  "oauth.tokenTab": "Refresh Token",
  "oauth.openaiTab": "OpenAI OAuth",
  "oauth.manualTab": "Manual Sync",
  "oauth.kiroBuilderIdTab": "Builder ID",
  "oauth.kiroApiKeyTab": "API Key",
  "oauth.kiroLoginBtn": "Login Kiro IDE",
  "oauth.kiroBuilderIdTitle": "Sign in with AWS Builder ID (opens browser)",
  "oauth.kiroApiKeyHelp":
    "Paste a Kiro API key. The bridge stores it locally with authMethod=api_key and uses it directly without OAuth refresh.",
  "oauth.googleHelp":
    "Click the button below to open Google authorization in your browser. After you sign in, the account will be saved automatically.",
  "oauth.openaiHelp":
    "Click the button below to open OpenAI authorization in your browser.",
  "oauth.codexManualHelp":
    "Sync from your local Codex CLI configuration at ~/.codex/auth.json.",
  "oauth.startAuth": "Start Authorization",
  "oauth.openingBrowser": "Opening browser...",
  "oauth.waiting": "Waiting...",
  "oauth.retry": "Retry",
  "oauth.syncFromCli": "Sync from CLI",
  "log.loading": "Loading...",
  "log.clickRefresh": "Click Refresh to load logs...",
  "log.noLogs": "No logs available",
  "log.heartbeatCollapsed": "Heartbeat ×{n} (collapsed)",
  "log.copyPath": "Copy log file path",
  "log.copied": "Copied",
  "log.noPath": "No log file path available",
  "log.unknownPath": "Unknown",
  "log.notFoundSuffix": " (not found yet)",
  "log.toggle.debug": "Enable verbose debug logging (requires bridge restart)",
  "log.toggle.heartbeat": "Show/hide heartbeat lines",
  "log.toggle.auto": "Auto-refresh logs every 3 seconds",
  "log.label.debug": "Debug",
  "log.label.heartbeat": "Heartbeat",
  "log.label.auto": "Auto",
  "pool.bridgeOffline": "Bridge not running — click Refresh Status when online",
  "pool.ready": "Ready",
  "pool.cooldown": "Cooldown",
  "pool.modelCooldown": "Model Cooldown",
  "pool.disabled": "Disabled",
  "pool.total": "Total",
  "pool.modelHold": "Model Hold",
  "state.ready": "Ready",
  "state.cooldown": "Cooldown",
  "state.degraded": "Degraded",
  "state.modelHold": "Model Hold",
  "state.disabled": "Disabled",
  "state.unavailable": "Unavailable",
  "state.modelBusy": "Model Busy",
  "state.quotaCooldown": "Quota Cooldown",
  "state.rateLimit": "Rate Limit",
  "state.tempHold": "Temporary Hold",
  "quota.refreshing": "Refreshing quota",
  "quota.loading": "Loading quota",
  "quota.updated": "Quota updated {time}",
  "quota.cached": "Using cached quota",
  "quota.unavailable": "Quota unavailable",
  "quota.notLoaded": "Quota not loaded yet",
  "quota.weeklyLimit": "Weekly limit",
  "quota.imageGenLimit": "Image generation",
  "quota.titlePrefix": "Quota · ",
  "quota.refreshingWithPrev": "Refreshing quota · showing previous values",
  "quota.showingPrevious": "showing previous values",
  "usage.sourceLive": "live request",
  "usage.sourceProbe": "probe",
  "codex.summaryTitle": "Codex Availability",
  "codex.noEmail": "No email",
  "codex.proxySuffix": "proxy",
  "codex.modelHolds": "{n} model hold(s)",
  "codex.requests": "{n} req",
  "analytics.bridgeOfflineTitle": "Bridge offline",
  "analytics.bridgeOfflineDesc":
    "Start the bridge to collect runtime token usage.",
  "analytics.noData": "No analytics data available",
  "analytics.noRuntime": "No runtime session data available",
  "analytics.noSessionsYet": "No active or persisted session runtime yet",
  "analytics.active": "Active",
  "analytics.idle": "Idle",
  "analytics.loaded": "Loaded",
  "analytics.persisted": "Persisted",
  "analytics.usageActive": "Usage analytics are active",
  "analytics.noTrackedYet": "No tracked usage yet",
  "analytics.windowLine": "Window started {w} · Last update {u}",
  "analytics.runRequests":
    "Run requests through a tracked backend to populate token analytics.",
  "analytics.trackingBackends": " · Tracking {n} backend(s)",
  "heatmap.less": "Less",
  "heatmap.more": "More",
  "heatmap.peak": "{n} peak",
  "heatmap.tooltip": "{date}: {tokens} tokens, {reqs} reqs",
  "heatmap.tooltipErrors": ", 429:{e429} 503:{e503}",
  "month.jan": "Jan",
  "month.feb": "Feb",
  "month.mar": "Mar",
  "month.apr": "Apr",
  "month.may": "May",
  "month.jun": "Jun",
  "month.jul": "Jul",
  "month.aug": "Aug",
  "month.sep": "Sep",
  "month.oct": "Oct",
  "month.nov": "Nov",
  "month.dec": "Dec",
  "usage.ctx": "Ctx",
  "usage.in": "In",
  "usage.read": "Read",
  "usage.write": "Write",
  "usage.out": "Out",
  "usage.search": "Search",
  "usage.reuse": "Reuse",
  "usage.avg": "Avg",
  "usage.last": "Last",
  "usage.routes": "Routes",
  "usage.totalDuration": "Total duration",
  "usage.cacheHit": "Cache hit",
  "usage.cacheReuse": "Cache reuse",
  "usage.requests": "Requests",
  "usage.context": "Context",
  "usage.input": "Input",
  "usage.cacheRead": "Cache Read",
  "usage.cacheWrite": "Cache Write",
  "usage.output": "Output",
  "usage.webSearch": "Web Search",
  "usage.avgDuration": "Avg Duration",
  "usage.sessions": "Sessions",
  "usage.pendingTools": "Pending Tools",
  "usage.completedTools": "Completed Tools",
  "usage.toolAvg": "Tool Avg",
  "usage.toolTotal": "Tool Total",
  "usage.editedFiles": "Edited Files",
  "usage.lineDelta": "Line Delta",
  "usage.loadedLine":
    "Loaded {l} · Persisted-only {p} · Read files {r} · Last {t}",
  "usage.maxOut": "Max out",
  "usage.tools": "Tools",
  "usage.pending": "Pending",
  "usage.edit": "Edit",
  "usage.shell": "Shell",
  "usage.files": "Files",
  "usage.subAgent": "Sub-agent {t} turns / {c} tools",
  "route.ws": "WebSocket",
  "route.http": "HTTP",
  "route.nativeWorker": "Native Worker",
  "route.chatCompletions": "Chat Completions",
  "route.responsesApi": "Responses API",
  "route.messagesApi": "Messages API",
  "analytics.noRouteUsage": "No route-level usage yet",
  "analytics.noModelUsage": "No model usage recorded yet",
  "analytics.noAccountUsage": "No account usage recorded yet",
  "analytics.noRecent": "No recent usage records yet",
  "analytics.recent.ctx": "Ctx",
  "analytics.recent.in": "In",
  "analytics.recent.read": "Read",
  "analytics.recent.write": "Write",
  "analytics.recent.out": "Out",
  "analytics.recent.search": "Search",
  "analytics.noBackendUsage": "No backend usage recorded yet",
  "test.patchEndpoint.name": "Cursor Direct Connection",
  "test.patchEndpoint.desc":
    "Verify the Cursor direct connection patch status and endpoint coverage",
  "test.ssl.name": "SSL Certificates",
  "test.ssl.desc":
    "Validate local certificate files and SAN coverage for the local bridge",
  "test.bridge.name": "Bridge Health",
  "test.bridge.desc": "HTTPS health check against the local bridge",
  "test.idleKiller.name": "Idle Extension Host Killer",
  "test.idleKiller.desc":
    "Verify Cursor's idle extension-host killer patch status",
  "test.accounts.name": "Backend Accounts",
  "test.accounts.desc": "Check at least one account is configured",
  "model.gemini": "Gemini Pro 3.1 High",
  "model.claudeOpus": "Claude Opus 4.6",
  "model.claudeSonnet": "Claude Sonnet 4.6",
  "model.custom": "Custom Models",
  "model.gpt": "GPT-5.5",
  "model.codex": "Codex",
  "privacy.toggleTitle": "Toggle email privacy",
  "dlg.addAccount": "Add {channel} Account",
  "dlg.editAccount": "Edit {channel} Account",
  "dlg.addToken": "Add {channel} Token",
  "dlg.editToken": "Edit {channel} Token",
  "dlg.addAccountDefault": "Add Account",
  "field.placeholder.label": "e.g. claude-proxy",
  "field.placeholder.proxy": "http://127.0.0.1:7897",
  "accounts.cliTitle": "Switch Codex CLI to this account",
  "accounts.kiroForceLoginTitle": "Sign the local Kiro IDE in as this account",
  "accounts.kiroForceCliLoginTitle":
    "Sign the local Kiro CLI in as this account",
  "log.copyTitle": "Click to copy log file path",
  "time.justNow": "just now",
  "time.secAgo": "{n}s ago",
  "time.minAgo": "{n}m ago",
  "time.hourAgo": "{n}h ago",
  "time.dayAgo": "{n}d ago",
  "time.now": "now",
  "time.in": "in {parts}",
  "time.unit.day": "{n}d",
  "time.unit.hour": "{n}h",
  "time.unit.min": "{n}m",
  "time.unit.sec": "{n}s",
  "quota.percentLeft": "{pct}% left",
  "quota.tinyLeft": "<0.1% left",
  "quota.resetsAt": " (resets {time} on {day} {month})",
  "cooldown.busy": "{n} busy",
  "cooldown.quota": "{n} quota",
  "cooldown.rateLimited": "{n} rate-limited",
  "cooldown.transient": "{n} transient",
  "cooldown.other": "{n} other",
  "analytics.reqsSuffix": "{n} reqs",
  "codex.accountFallback": "Codex account",
  "heatmap.day.mon": "M",
  "heatmap.day.wed": "W",
  "heatmap.day.fri": "F",
  "log.heartbeatPrefix": "💓",
}

const UI_ZH: Record<string, string> = {
  "page.lang": "zh",
  "page.title": "Agent Vibes 控制台",
  "page.tagline": "统一 AI 代理网关 — 祝你编码愉快！",
  "tab.overview": "概览",
  "tab.endpoints": "API",
  "endpoints.title": "API",
  "endpoints.subtitle":
    "本 Bridge 对外暴露的 HTTP 端点，可以复制 URL、测试连通性，或一键写入对应客户端的配置。",
  "endpoints.action.copy": "复制",
  "endpoints.action.test": "测试",
  "endpoints.action.applyClaude": "写入 Claude CLI",
  "endpoints.action.applyCursor": "修补 Cursor",
  "endpoints.toast.copied": "已复制",
  "endpoints.toast.testing": "测试中…",
  "endpoints.status.ready": "就绪",
  "endpoints.status.online": "在线",
  "endpoints.status.offline": "离线",
  "endpoints.status.checking": "检查中…",
  "endpoints.status.connecting": "接入中…",
  "endpoints.status.disconnecting": "断开中…",
  "endpoints.anthropic.name": "Anthropic API",
  "endpoints.anthropic.desc":
    "兼容 api.anthropic.com，可被 Claude Code CLI 及任意 Anthropic SDK 直接使用。",
  "endpoints.cursor.name": "Cursor IDE 协议",
  "endpoints.cursor.desc":
    "让 Cursor 直接连接本 Bridge，不再依赖 hosts 或本机端口转发。",
  "endpoints.health.name": "健康检查",
  "endpoints.health.desc": "返回桥接运行状态的 JSON 探针。",
  "endpoints.openai.name": "OpenAI API",
  "endpoints.openai.desc":
    "兼容 api.openai.com，可被 OpenAI SDK 及任意 OpenAI 兼容客户端直接使用（chat/completions、completions、models）。",
  "endpoints.google.name": "Google API",
  "endpoints.gemini.desc":
    "兼容 generativelanguage.googleapis.com，可被 Gemini CLI / google-genai SDK 使用。",
  "tab.clients": "客户端",
  "clients.title": "客户端接入",
  "clients.subtitle": "将本机 AI 客户端接入到本 Bridge。",
  "clients.status.wired": "已接入",
  "clients.status.notWired": "未接入",
  "clients.status.patched": "已直连",
  "clients.status.patch": "修补 Cursor",
  "clients.status.updatePatch": "更新补丁",
  "clients.status.forwarding": "转发中",
  "clients.status.offline": "离线",
  "clients.status.builtin": "原生支持",
  "clients.status.comingSoon": "即将支持",
  "clients.action.wire": "接入 Bridge",
  "clients.action.unwire": "断开",
  "clients.action.copy": "复制",
  "clients.action.refresh": "刷新",
  "clients.client.claudeCode": "Claude Code CLI",
  "clients.client.cursorIde": "Cursor IDE",
  "clients.client.codexCli": "Codex CLI",
  "clients.client.geminiCli": "Gemini CLI",
  "clients.client.cursorCli": "Cursor CLI",
  "clients.claudeCode.desc":
    "改写 ~/.claude/settings.json 的 env，让 CLI 把请求发到本 Bridge，而不是 api.anthropic.com。",
  "clients.cursorIde.desc":
    "让 Cursor 直接连接本 Bridge，不再依赖 hosts 或本机端口转发。",
  "clients.cursorIde.endpoint": "Bridge 接入地址",
  "clients.comingSoon.desc": "已规划但尚未实现该客户端的接入。",
  "tab.accounts": "账号",
  "tab.analytics": "用量分析",
  "tab.settings": "设置",
  "tab.tests": "诊断",
  "tab.logs": "日志",
  "section.status": "状态",
  "section.actions": "操作",
  "section.backends": "后端",
  "section.clients": "客户端",
  "clients.manage": "管理 →",
  "section.accounts": "账号",
  "section.tokenUsage": "Token 用量",
  "section.sessionRuntime": "会话运行",
  "section.byBackend": "按后端",
  "section.byRoute": "按路由",
  "section.topModels": "常用模型",
  "section.topAccounts": "常用账号",
  "section.recentActivity": "最近活动",
  "section.diagnostics": "诊断",
  "section.bridgeLog": "桥接日志",
  "meta.extension": "扩展",
  "meta.cursor": "Cursor",
  "meta.compat": "兼容",
  checkUpdates: "检查更新",
  checkingUpdates: "检查中…",
  refresh: "刷新",
  refreshing: "刷新中…",
  runAll: "全部运行",
  run: "运行",
  "dlg.cancel": "取消",
  "dlg.add": "添加",
  "dlg.save": "保存",
  "toggle.on": "开",
  "toggle.off": "关",
  "action.start": "启动",
  "action.stop": "停止",
  "action.restart": "重启",
  "action.enableForwarding": "启用转发",
  "action.disableForwarding": "关闭转发",
  "action.clearCache": "清理会话数据",
  "status.health": "健康",
  "status.ssl": "SSL",
  "status.cursor": "Cursor",
  "status.forwarding": "转发",
  "status.port": "端口",
  "status.accounts": "账号",
  "status.online": "在线",
  "status.offline": "离线",
  "status.valid": "有效",
  "status.missing": "缺失",
  "status.active": "活动",
  "status.idle": "空闲",
  "backend.notConfigured": "未配置",
  "backend.accountCount": "{n} 个账号",
  "backend.addAccountTitle": "添加账号",
  "accounts.selectDetail": "选择账号以查看详情",
  "accounts.selectChannel": "选择通道",
  "accounts.noAccounts": "尚未配置账号",
  "accounts.edit": "编辑",
  "accounts.remove": "移除",
  "accounts.cli": "CLI",
  "accounts.kiroForceLogin": "登录 IDE",
  "accounts.kiroForceCliLogin": "登录 CLI",
  "accounts.add": "+ 添加",
  "accounts.pagination": "{start}–{end} / 共 {total}",
  "accounts.prev": "← 上一页",
  "accounts.next": "下一页 →",
  "accounts.refreshTitle": "刷新状态",
  "group.google": "Google",
  "group.openai": "OpenAI",
  "group.anthropic": "Anthropic",
  "group.amazon": "Amazon",
  "ch.antigravity": "Antigravity IDE",
  "ch.codex": "Codex CLI",
  "ch.openaiCompat": "OpenAI 兼容",
  "ch.claudeApi": "Claude Code CLI",
  "ch.kiro": "Kiro",
  "ch.sync.antigravityIde": "同步 Antigravity IDE",
  "ch.sync.antigravityTool": "同步 Antigravity 工具",
  "ch.sync.codexCli": "同步 Codex CLI",
  "ch.sync.cpa": "同步 CPA",
  "ch.sync.claude": "同步 Claude",
  "field.label": "名称",
  "field.baseUrl": "Base URL",
  "field.apiKey": "API Key",
  "field.maxContextTokens": "最大上下文 Token",
  "field.proxyUrl": "代理 URL（可选）",
  "field.refreshToken": "Refresh Token",
  "field.tokenHint": "格式：1//xxx（Google）或 rt_xxx（OpenAI）。支持批量。",
  "field.tokenHintGoogle": "格式：1//xxx（Google）。支持批量。",
  "field.tokenPlaceholder": "粘贴 Token…\n支持：单个、JSON 数组或多行",
  "field.kiroApiKey": "Kiro API Key",
  "field.kiroApiKeyPlaceholder": "粘贴 Kiro API Key（如 aws-...）",
  "field.kiroApiKeyHint":
    "Kiro 颁发的个人 API Key，将以 authMethod=api_key 形式保存到本地。",
  "acct.synced": "已同步账号",
  "acct.noToken": "无 Token",
  "acct.unknown": "未知",
  "acct.unnamed": "未命名",
  "oauth.googleTab": "Google OAuth",
  "oauth.tokenTab": "Refresh Token",
  "oauth.openaiTab": "OpenAI OAuth",
  "oauth.manualTab": "手动同步",
  "oauth.kiroBuilderIdTab": "Builder ID",
  "oauth.kiroApiKeyTab": "API Key",
  "oauth.kiroLoginBtn": "登录 Kiro IDE",
  "oauth.kiroBuilderIdTitle": "使用 AWS Builder ID 登录（将打开浏览器）",
  "oauth.kiroApiKeyHelp":
    "粘贴 Kiro API Key。桥接会以 authMethod=api_key 形式保存到本地，直接使用，无需 OAuth 续签。",
  "oauth.googleHelp":
    "点击下方按钮在浏览器中打开 Google 授权。登录后账号会自动保存。",
  "oauth.openaiHelp": "点击下方按钮在浏览器中打开 OpenAI 授权。",
  "oauth.codexManualHelp": "从本机 Codex CLI 配置 ~/.codex/auth.json 同步。",
  "oauth.startAuth": "开始授权",
  "oauth.openingBrowser": "正在打开浏览器…",
  "oauth.waiting": "请稍候…",
  "oauth.retry": "重试",
  "oauth.syncFromCli": "从 CLI 同步",
  "log.loading": "加载中…",
  "log.clickRefresh": "点击「刷新」加载日志…",
  "log.noLogs": "暂无日志",
  "log.heartbeatCollapsed": "心跳 ×{n}（已折叠）",
  "log.copyPath": "点击复制日志路径",
  "log.copied": "已复制",
  "log.noPath": "暂无日志路径",
  "log.unknownPath": "未知",
  "log.notFoundSuffix": "（文件尚未生成）",
  "log.toggle.debug": "启用详细调试日志（需重启桥接）",
  "log.toggle.heartbeat": "显示/隐藏心跳行",
  "log.toggle.auto": "每 3 秒自动刷新日志",
  "log.label.debug": "调试",
  "log.label.heartbeat": "心跳",
  "log.label.auto": "自动",
  "pool.bridgeOffline": "桥接未运行 — 上线后请点击「刷新状态」",
  "pool.ready": "就绪",
  "pool.cooldown": "冷却中",
  "pool.modelCooldown": "模型冷却",
  "pool.disabled": "已禁用",
  "pool.total": "合计",
  "pool.modelHold": "模型暂挂",
  "state.ready": "就绪",
  "state.cooldown": "冷却",
  "state.degraded": "降级",
  "state.modelHold": "模型暂挂",
  "state.disabled": "已禁用",
  "state.unavailable": "不可用",
  "state.modelBusy": "模型繁忙",
  "state.quotaCooldown": "配额冷却",
  "state.rateLimit": "速率限制",
  "state.tempHold": "临时挂起",
  "quota.refreshing": "正在刷新配额",
  "quota.loading": "正在加载配额",
  "quota.updated": "配额已更新 {time}",
  "quota.cached": "使用缓存配额",
  "quota.unavailable": "配额不可用",
  "quota.notLoaded": "配额尚未加载",
  "quota.weeklyLimit": "每周上限",
  "quota.imageGenLimit": "生图额度",
  "quota.titlePrefix": "配额 · ",
  "quota.refreshingWithPrev": "正在刷新配额 · 暂显示上一批数据",
  "quota.showingPrevious": "暂显示上一批数据",
  "usage.sourceLive": "实时请求",
  "usage.sourceProbe": "探测",
  "codex.summaryTitle": "Codex 可用性",
  "codex.noEmail": "无邮箱",
  "codex.proxySuffix": "代理",
  "codex.modelHolds": "{n} 个模型暂挂",
  "codex.requests": "{n} 次请求",
  "analytics.bridgeOfflineTitle": "桥接离线",
  "analytics.bridgeOfflineDesc": "启动桥接以收集运行时的 Token 用量。",
  "analytics.noData": "暂无分析数据",
  "analytics.noRuntime": "暂无运行时会话数据",
  "analytics.noSessionsYet": "暂无活动或持久化的会话运行时",
  "analytics.active": "活动",
  "analytics.idle": "空闲",
  "analytics.loaded": "已加载",
  "analytics.persisted": "已持久化",
  "analytics.usageActive": "用量分析已启用",
  "analytics.noTrackedYet": "尚无已统计的用量",
  "analytics.windowLine": "统计窗口始于 {w} · 上次更新 {u}",
  "analytics.runRequests": "通过已跟踪的后端发起请求以填充 Token 分析。",
  "analytics.trackingBackends": " · 正在跟踪 {n} 个后端",
  "heatmap.less": "少",
  "heatmap.more": "多",
  "heatmap.peak": "峰值 {n}",
  "heatmap.tooltip": "{date}：{tokens} tokens，{reqs} 次请求",
  "heatmap.tooltipErrors": "，429:{e429} 503:{e503}",
  "month.jan": "1月",
  "month.feb": "2月",
  "month.mar": "3月",
  "month.apr": "4月",
  "month.may": "5月",
  "month.jun": "6月",
  "month.jul": "7月",
  "month.aug": "8月",
  "month.sep": "9月",
  "month.oct": "10月",
  "month.nov": "11月",
  "month.dec": "12月",
  "usage.ctx": "上下文",
  "usage.in": "输入",
  "usage.read": "缓存读",
  "usage.write": "缓存写",
  "usage.out": "输出",
  "usage.search": "搜索",
  "usage.reuse": "复用",
  "usage.avg": "平均",
  "usage.last": "最近",
  "usage.routes": "路由",
  "usage.totalDuration": "总耗时",
  "usage.cacheHit": "缓存命中",
  "usage.cacheReuse": "缓存复用",
  "usage.requests": "请求数",
  "usage.context": "上下文",
  "usage.input": "输入",
  "usage.cacheRead": "缓存读取",
  "usage.cacheWrite": "缓存写入",
  "usage.output": "输出",
  "usage.webSearch": "联网搜索",
  "usage.avgDuration": "平均耗时",
  "usage.sessions": "会话",
  "usage.pendingTools": "待处理工具",
  "usage.completedTools": "已完成工具",
  "usage.toolAvg": "工具平均",
  "usage.toolTotal": "工具总计",
  "usage.editedFiles": "编辑文件",
  "usage.lineDelta": "行变更",
  "usage.loadedLine": "已加载 {l} · 仅持久化 {p} · 读取文件 {r} · 最近 {t}",
  "usage.maxOut": "最大输出",
  "usage.tools": "工具",
  "usage.pending": "待处理",
  "usage.edit": "编辑",
  "usage.shell": "终端",
  "usage.files": "文件",
  "usage.subAgent": "子代理 {t} 轮 / {c} 次工具",
  "route.ws": "WebSocket",
  "route.http": "HTTP",
  "route.nativeWorker": "原生 Worker",
  "route.chatCompletions": "Chat Completions",
  "route.responsesApi": "Responses API",
  "route.messagesApi": "Messages API",
  "analytics.noRouteUsage": "尚无路由级用量",
  "analytics.noModelUsage": "尚无模型用量记录",
  "analytics.noAccountUsage": "尚无账号用量记录",
  "analytics.noRecent": "尚无最近用量记录",
  "analytics.recent.ctx": "上下文",
  "analytics.recent.in": "输入",
  "analytics.recent.read": "缓存读",
  "analytics.recent.write": "缓存写",
  "analytics.recent.out": "输出",
  "analytics.recent.search": "搜索",
  "analytics.noBackendUsage": "尚无后端用量记录",
  "test.patchEndpoint.name": "Cursor 直连接入",
  "test.patchEndpoint.desc": "检查 Cursor 直连补丁状态与端点覆盖情况",
  "test.ssl.name": "SSL 证书",
  "test.ssl.desc": "校验本地证书文件与本机桥接端点的 SAN 覆盖",
  "test.bridge.name": "桥接健康",
  "test.bridge.desc": "对本地桥接执行 HTTPS 健康检查",
  "test.idleKiller.name": "空闲扩展宿主保护",
  "test.idleKiller.desc": "检查 Cursor 空闲扩展宿主保护补丁状态",
  "test.accounts.name": "后端账号",
  "test.accounts.desc": "检查是否至少配置了一个账号",
  "model.gemini": "Gemini Pro 3.1 High",
  "model.claudeOpus": "Claude Opus 4.6",
  "model.claudeSonnet": "Claude Sonnet 4.6",
  "model.custom": "自定义模型",
  "model.gpt": "GPT-5.5",
  "model.codex": "Codex",
  "privacy.toggleTitle": "切换邮箱隐私显示",
  "dlg.addAccount": "添加 {channel} 账号",
  "dlg.editAccount": "编辑 {channel} 账号",
  "dlg.addToken": "添加 {channel} Token",
  "dlg.editToken": "编辑 {channel} Token",
  "dlg.addAccountDefault": "添加账号",
  "field.placeholder.label": "例如 claude-proxy",
  "field.placeholder.proxy": "http://127.0.0.1:7897",
  "accounts.cliTitle": "将 Codex CLI 切换到此账号",
  "accounts.kiroForceLoginTitle": "让本地 Kiro IDE 登录为此账号",
  "accounts.kiroForceCliLoginTitle": "让本地 Kiro CLI 登录为此账号",
  "log.copyTitle": "点击复制日志文件路径",
  "time.justNow": "刚刚",
  "time.secAgo": "{n} 秒前",
  "time.minAgo": "{n} 分钟前",
  "time.hourAgo": "{n} 小时前",
  "time.dayAgo": "{n} 天前",
  "time.now": "现在",
  "time.in": "{parts}后",
  "time.unit.day": "{n} 天",
  "time.unit.hour": "{n} 小时",
  "time.unit.min": "{n} 分",
  "time.unit.sec": "{n} 秒",
  "quota.percentLeft": "剩余 {pct}%",
  "quota.tinyLeft": "剩余不足 0.1%",
  "quota.resetsAt": "（{day} {month} {time} 重置）",
  "cooldown.busy": "繁忙 {n}",
  "cooldown.quota": "配额耗尽 {n}",
  "cooldown.rateLimited": "限流 {n}",
  "cooldown.transient": "临时挂起 {n}",
  "cooldown.other": "其他 {n}",
  "analytics.reqsSuffix": "{n} 次请求",
  "codex.accountFallback": "Codex 账号",
  "heatmap.day.mon": "一",
  "heatmap.day.wed": "三",
  "heatmap.day.fri": "五",
  "log.heartbeatPrefix": "💓",
}

export function getUiPack(locale: DashboardLocale): Record<string, string> {
  return locale === "zh" ? { ...UI_EN, ...UI_ZH } : { ...UI_EN }
}

/** Interpolate `{name}` placeholders in UI strings. */
export function formatUi(
  template: string,
  vars: Record<string, string | number>
): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`
  )
}

type OverviewMsg = {
  certsLabel: string
  certsDone: string
  certsTodo: string
  certsAction: string
  accountsLabel: string
  accountsDone: string
  accountsTodo: string
  bridgeLabel: string
  bridgeRunning: string
  bridgeTodo: string
  bridgeAction: string
  setupHeadline: string
  setupSummary: string
  readyHeadline: string
  readySummary: string
  attentionHeadline: string
  attentionSummary: string
  restartAction: string
  reviewAction: string
  accountsCount: string
}

const OVERVIEW_EN: OverviewMsg = {
  certsLabel: "Generate local certificates",
  certsDone: "TLS certificates are available for the local bridge.",
  certsTodo:
    "Create the local CA and bridge certificates required for HTTPS traffic interception.",
  certsAction: "Generate certs",
  accountsLabel: "Connect at least one backend account",
  accountsDone: "{n} account(s) available across configured backends.",
  accountsTodo: "Add at least one available backend account.",
  bridgeLabel: "Start local bridge",
  bridgeRunning: "Bridge is running on port {port}.",
  bridgeTodo: "Launch the local bridge.",
  bridgeAction: "Start bridge",
  setupHeadline: "Setup required",
  setupSummary:
    "Finish the remaining setup steps to route Cursor traffic through Agent Vibes.",
  readyHeadline: "Ready",
  readySummary: "Everything is ready.",
  attentionHeadline: "Almost there",
  attentionSummary:
    "Core pieces are in place, but the flow is not fully complete yet. Finish the next actionable step below.",
  restartAction: "Restart bridge",
  reviewAction: "Review setup",
  accountsCount: "{n} account(s) available across configured backends.",
}

const OVERVIEW_ZH: OverviewMsg = {
  certsLabel: "生成本地证书",
  certsDone: "本地桥接已具备 TLS 证书。",
  certsTodo: "创建本地 CA 与桥接证书，用于 HTTPS 流量拦截。",
  certsAction: "生成证书",
  accountsLabel: "连接至少一个后端账号",
  accountsDone: "已在各后端配置 {n} 个账号。",
  accountsTodo: "请至少添加一个可用后端账号。",
  bridgeLabel: "启动本地桥接",
  bridgeRunning: "桥接正在端口 {port} 上运行。",
  bridgeTodo: "启动本地桥接服务。",
  bridgeAction: "启动桥接",
  setupHeadline: "需要完成设置",
  setupSummary: "完成以下步骤，以便通过 Agent Vibes 路由 Cursor 流量。",
  readyHeadline: "已就绪",
  readySummary: "一切就绪。",
  attentionHeadline: "即将完成",
  attentionSummary:
    "主要组件已就位，但流程尚未完全打通。请完成下一项可操作步骤。",
  restartAction: "重启桥接",
  reviewAction: "查看设置",
  accountsCount: "已在各后端配置 {n} 个账号。",
}

export function getOverviewMessages(locale: DashboardLocale): OverviewMsg {
  return locale === "zh" ? OVERVIEW_ZH : OVERVIEW_EN
}

export function translatePatchResetHint(
  locale: DashboardLocale,
  hint: string
): string {
  const mapEnToZh: Record<string, string> = {
    "No original baseline has been captured yet. Apply a Cursor repair through Agent Vibes first.":
      "尚未捕获原始基线。请先在 Agent Vibes 中执行一次 Cursor 修复。",
    "Some active checksum changes were applied before Agent Vibes captured the original baseline, so one-click reset is currently unsafe.":
      "在捕获原始基线之前已应用部分校验和修改，一键还原当前不安全。",
  }
  const restorePrefix =
    /^Restore (\d+) managed Cursor file\(s\) to the captured original baseline, then re-apply the repairs you still want\.$/
  const m = hint.match(restorePrefix)
  if (locale === "zh" && m) {
    return `将 ${m[1]} 个已管理的 Cursor 文件还原到捕获的原始基线，然后按需重新应用仍需要的修复。`
  }
  if (locale === "zh" && mapEnToZh[hint]) {
    return mapEnToZh[hint]
  }
  return hint
}

export function translateChecksumStatusDesc(
  locale: DashboardLocale,
  desc: string
): string {
  if (locale !== "zh") return desc
  const table: Record<string, string> = {
    "Cursor product.json was not found in a supported install location.":
      "未在受支持的安装位置找到 Cursor 的 product.json。",
    "Core file checksums were updated from the original product.json backup.":
      "核心文件校验和已从原始 product.json 备份更新。",
    "Core file checksums already match product.json.":
      "核心文件校验和已与 product.json 一致。",
  }
  if (table[desc]) return table[desc]
  const mismatchRe =
    /^(\d+) core file checksum\(s\) differ from product\.json\. This usually only needs manual repair after out-of-band core file changes\.$/
  const mm = desc.match(mismatchRe)
  if (mm) {
    return `${mm[1]} 个核心文件校验和与 product.json 不一致。通常在核心文件被外部修改后才需要手动修复。`
  }
  return desc
}

export function translateCursorBuildUnknown(
  locale: DashboardLocale,
  value: string
): string {
  if (value !== "Unknown") return value
  return locale === "zh" ? "未知" : value
}

export function translateOnOff(locale: DashboardLocale, value: string): string {
  if (value === "On") return locale === "zh" ? "开" : value
  if (value === "Off") return locale === "zh" ? "关" : value
  return value
}

export function translateNotFound(
  locale: DashboardLocale,
  value: string
): string {
  if (value === "Not found") return locale === "zh" ? "未找到" : value
  return value
}

type SettingsItemCopy = { label: string; desc: string }

type GeneralSettingsItems = {
  language: SettingsItemCopy
  responseLanguage: SettingsItemCopy
  autoCheckUpdates: SettingsItemCopy
  updateCheckIntervalHours: SettingsItemCopy
}

type BridgeSettingsItems = {
  autoStart: SettingsItemCopy
  port: SettingsItemCopy
  trafficMode: SettingsItemCopy
  healthCheckInterval: SettingsItemCopy
}

type AntigravitySettingsItems = {
  antigravitySystemPrompt: SettingsItemCopy
  thinkingBudgetAuto: SettingsItemCopy
  antigravityOfficialTools: SettingsItemCopy
}

type StorageSettingsItems = {
  dataDir: SettingsItemCopy
  antigravityAccountsPath: SettingsItemCopy
  codexAccountsPath: SettingsItemCopy
  openaiCompatAccountsPath: SettingsItemCopy
  claudeApiAccountsPath: SettingsItemCopy
  kiroAccountsPath: SettingsItemCopy
  sessionData: SettingsItemCopy
}

type PatchSettingsItems = {
  cursorAppRoot: SettingsItemCopy
  cursorBuild: SettingsItemCopy
  bridgeEndpoint: SettingsItemCopy
  idleKiller: SettingsItemCopy
  agentInputDock: SettingsItemCopy
  workspaceControl: SettingsItemCopy
  trafficCapture: SettingsItemCopy
  resetPatches: SettingsItemCopy
  fixChecksums: SettingsItemCopy
}

type SettingsCopy = {
  groups: {
    general: { label: string; desc: string; items: GeneralSettingsItems }
    bridge: { label: string; desc: string; items: BridgeSettingsItems }
    antigravity: {
      label: string
      desc: string
      items: AntigravitySettingsItems
    }
    storage: { label: string; desc: string; items: StorageSettingsItems }
    patch: { label: string; desc: string; items: PatchSettingsItems }
  }
  patch: {
    resetAll: string
    applyBridgeEndpoint: string
    updateBridgeEndpoint: string
    applyIdleKiller: string
    fixChecksumsLabel: string
    fixChecksumsDesc: string
  }
  general: {
    languageLabel: string
    languageDesc: string
    langEn: string
    langZh: string
    autoCheckUpdatesLabel: string
    autoCheckUpdatesDesc: string
    updateIntervalLabel: string
    updateIntervalDesc: string
  }
}

const SETTINGS_EN: SettingsCopy = {
  groups: {
    general: {
      label: "General",
      desc: "General extension preferences.",
      items: {
        language: {
          label: "Dashboard Language",
          desc: "Language used by the Agent Vibes dashboard webview",
        },
        responseLanguage: {
          label: "Response Language",
          desc: "Force the model to reply and think in this language (e.g. 中文, English, 日本語). Leave empty to auto-detect. Requires bridge restart.",
        },
        autoCheckUpdates: {
          label: "Auto Check Updates",
          desc: "Check GitHub Releases for new VSIX updates on startup",
        },
        updateCheckIntervalHours: {
          label: "Update Check Interval (hours)",
          desc: "Minimum hours between automatic update checks",
        },
      },
    },
    bridge: {
      label: "Bridge",
      desc: "Local proxy bridge that intercepts Cursor API traffic.",
      items: {
        autoStart: {
          label: "Auto Start",
          desc: "Start the bridge automatically when the IDE launches",
        },
        port: {
          label: "Port",
          desc: "HTTPS port the bridge listens on (requires restart)",
        },
        trafficMode: {
          label: "Cursor Connection",
          desc: "Default Cursor connection path for account, models, and agent requests. Direct patch does not require hosts or local port forwarding.",
        },
        healthCheckInterval: {
          label: "Health Check Interval",
          desc: "Seconds between health check polls, 0 to disable",
        },
      },
    },
    antigravity: {
      label: "Antigravity",
      desc: "Antigravity (Google Cloud Code) backend settings. Changing these defaults away from the upstream behavior may increase account suspension risk.",
      items: {
        antigravitySystemPrompt: {
          label: "System Prompt",
          desc: "Default Antigravity system prompt; off = Cursor+Claude Code hybrid (requires restart)",
        },
        thinkingBudgetAuto: {
          label: "Thinking Budget",
          desc: "Default Antigravity thinking budget; off = auto-estimation (requires restart)",
        },
        antigravityOfficialTools: {
          label: "Official Tools",
          desc: "Default Antigravity tool declarations; off = passthrough Cursor tools (requires restart)",
        },
      },
    },
    storage: {
      label: "Storage",
      desc: "Override default file paths. Leave empty to use defaults.",
      items: {
        dataDir: {
          label: "Data Directory",
          desc: "Root directory for all Agent Vibes data (default: ~/.agent-vibes)",
        },
        antigravityAccountsPath: {
          label: "Antigravity Accounts File",
          desc: "Custom path for antigravity-accounts.json",
        },
        codexAccountsPath: {
          label: "Codex Accounts File",
          desc: "Custom path for codex-accounts.json",
        },
        openaiCompatAccountsPath: {
          label: "OpenAI-Compat Accounts File",
          desc: "Custom path for openai-compat-accounts.json",
        },
        claudeApiAccountsPath: {
          label: "Claude API Accounts File",
          desc: "Custom path for claude-api-accounts.json",
        },
        kiroAccountsPath: {
          label: "Kiro Accounts File",
          desc: "Custom path for kiro-accounts.json",
        },
        sessionData: {
          label: "Clear Session Data",
          desc: "Delete saved bridge session state and cached conversations from the data directory.",
        },
      },
    },
    patch: {
      label: "Patch",
      desc: "Local Cursor repair, redirect, and checksum tools.",
      items: {
        cursorAppRoot: {
          label: "Cursor App Root",
          desc: "Detected Cursor installation used for local patch operations.",
        },
        cursorBuild: {
          label: "Cursor Build",
          desc: "Detected Cursor build identity used to scope patch baselines across upgrades.",
        },
        bridgeEndpoint: {
          label: "Cursor Direct Connection",
          desc: "Patch Cursor to connect to this Agent Vibes bridge without hosts or local port forwarding.",
        },
        idleKiller: {
          label: "Idle Extension Host Killer",
          desc: "Disable Cursor's idle extension-host killer to keep long agent sessions alive.",
        },
        agentInputDock: {
          label: "Agent Input Dock",
          desc: "Dock the active input only while the bottom Agent view is selected, then restore it to its original Chat or editor surface when another panel view is selected or the panel hides.",
        },
        workspaceControl: {
          label: "Workspace & Git Branch",
          desc: "Choose the workspace folder for each Agent chat and switch the project's Git branch from the input.",
        },
        trafficCapture: {
          label: "Cursor Traffic Capture",
          desc: "Capture Cursor transport requests and responses for protocol debugging. Disabled by default.",
        },
        resetPatches: {
          label: "Reset All Patches",
          desc: "One-click restore back to the captured original Cursor baseline.",
        },
        fixChecksums: {
          label: "Fix Checksums Next",
          desc: "Ported from the Fix VSCode Checksums Next extension for manual Cursor checksum repair.",
        },
      },
    },
  },
  patch: {
    resetAll: "Reset All",
    applyBridgeEndpoint: "Apply",
    updateBridgeEndpoint: "Update",
    applyIdleKiller: "Apply",
    fixChecksumsLabel: "Fix Checksums Next",
    fixChecksumsDesc:
      "Ported from the Fix VSCode Checksums Next extension for manual Cursor checksum repair.",
  },
  general: {
    languageLabel: "Dashboard Language",
    languageDesc: "Language used by the Agent Vibes dashboard webview",
    langEn: "English",
    langZh: "中文",
    autoCheckUpdatesLabel: "Auto Check Updates",
    autoCheckUpdatesDesc:
      "Check GitHub Releases for new VSIX updates on startup",
    updateIntervalLabel: "Update Check Interval (hours)",
    updateIntervalDesc: "Minimum hours between automatic update checks",
  },
}

const SETTINGS_ZH: SettingsCopy = {
  groups: {
    general: {
      label: "常规",
      desc: "扩展的通用偏好设置。",
      items: {
        language: {
          label: "控制台语言",
          desc: "Agent Vibes 控制台（Webview）显示语言",
        },
        responseLanguage: {
          label: "回复语言",
          desc: "强制模型用该语言回复和思考（如 中文、English、日本語）。留空则自动检测。需重启桥接生效。",
        },
        autoCheckUpdates: {
          label: "自动检查更新",
          desc: "启动时检查 GitHub Releases 是否有新 VSIX",
        },
        updateCheckIntervalHours: {
          label: "检查更新间隔（小时）",
          desc: "自动检查更新之间的最短时间间隔",
        },
      },
    },
    bridge: {
      label: "桥接",
      desc: "在本地拦截 Cursor API 流量的代理桥接。",
      items: {
        autoStart: {
          label: "自动启动",
          desc: "在 IDE 启动时自动启动桥接",
        },
        port: {
          label: "端口",
          desc: "桥接监听的 HTTPS 端口（修改后需重启）",
        },
        trafficMode: {
          label: "Cursor 接入方式",
          desc: "账号、模型和 Agent 请求的默认 Cursor 接入路径。直连补丁不需要 hosts 或本机端口转发。",
        },
        healthCheckInterval: {
          label: "健康检查间隔",
          desc: "健康检查轮询间隔（秒），0 表示关闭",
        },
      },
    },
    antigravity: {
      label: "Antigravity",
      desc: "Antigravity（Google Cloud Code）后端设置。偏离上游默认可能增加账号风控风险。",
      items: {
        antigravitySystemPrompt: {
          label: "系统提示词",
          desc: "Antigravity 默认系统提示；关闭 = Cursor + Claude Code 混合模式（需重启）",
        },
        thinkingBudgetAuto: {
          label: "思考预算",
          desc: "Antigravity 思考预算；关闭 = 自动估算（需重启）",
        },
        antigravityOfficialTools: {
          label: "官方工具",
          desc: "Antigravity 官方工具声明；关闭 = 透传 Cursor 工具（需重启）",
        },
      },
    },
    storage: {
      label: "存储",
      desc: "覆盖默认文件路径。留空则使用默认值。",
      items: {
        dataDir: {
          label: "数据目录",
          desc: "Agent Vibes 数据根目录（默认：~/.agent-vibes）",
        },
        antigravityAccountsPath: {
          label: "Antigravity 账号文件",
          desc: "antigravity-accounts.json 的自定义路径",
        },
        codexAccountsPath: {
          label: "Codex 账号文件",
          desc: "codex-accounts.json 的自定义路径",
        },
        openaiCompatAccountsPath: {
          label: "OpenAI 兼容账号文件",
          desc: "openai-compat-accounts.json 的自定义路径",
        },
        claudeApiAccountsPath: {
          label: "Claude API 账号文件",
          desc: "claude-api-accounts.json 的自定义路径",
        },
        kiroAccountsPath: {
          label: "Kiro 账号文件",
          desc: "kiro-accounts.json 的自定义路径",
        },
        sessionData: {
          label: "清理会话数据",
          desc: "删除数据目录中保存的桥接会话状态和缓存对话。",
        },
      },
    },
    patch: {
      label: "补丁",
      desc: "本地 Cursor 修复、重定向与校验和工具。",
      items: {
        cursorAppRoot: {
          label: "Cursor 安装根目录",
          desc: "检测到的 Cursor 安装路径，用于本地补丁操作",
        },
        cursorBuild: {
          label: "Cursor 构建信息",
          desc: "检测到的 Cursor 构建标识，用于跨版本补丁基线",
        },
        bridgeEndpoint: {
          label: "Cursor 直连接入",
          desc: "让 Cursor 直接连接本机 Agent Vibes 桥接，不再依赖 hosts 或本机端口转发。",
        },
        idleKiller: {
          label: "空闲扩展宿主保护",
          desc: "禁用 Cursor 空闲扩展宿主停止逻辑，保持长会话可用。",
        },
        agentInputDock: {
          label: "Agent 输入停靠",
          desc: "仅在选中底部 Agent 视图时临时停靠当前输入，切换到终端等其他视图或隐藏面板后原位恢复，不改动右侧 Chat 或编辑模式。",
        },
        workspaceControl: {
          label: "工作区与 Git 分支",
          desc: "在 Agent 输入区为每个对话选择工作区目录，并切换当前项目的 Git 分支。",
        },
        trafficCapture: {
          label: "Cursor 流量抓取",
          desc: "抓取 Cursor 传输层请求和响应，用于协议调试。默认关闭。",
        },
        resetPatches: {
          label: "重置所有补丁",
          desc: "一键还原到已捕获的原始 Cursor 基线",
        },
        fixChecksums: {
          label: "Fix Checksums Next",
          desc: "源自 Fix VSCode Checksums Next，用于手动修复 Cursor 校验和",
        },
      },
    },
  },
  patch: {
    resetAll: "全部重置",
    applyBridgeEndpoint: "应用",
    updateBridgeEndpoint: "更新",
    applyIdleKiller: "应用",
    fixChecksumsLabel: "Fix Checksums Next",
    fixChecksumsDesc:
      "源自 Fix VSCode Checksums Next，用于手动修复 Cursor 校验和",
  },
  general: {
    languageLabel: "控制台语言",
    languageDesc: "Agent Vibes 控制台（Webview）显示语言",
    langEn: "English",
    langZh: "中文",
    autoCheckUpdatesLabel: "自动检查更新",
    autoCheckUpdatesDesc: "启动时检查 GitHub Releases 是否有新 VSIX",
    updateIntervalLabel: "检查更新间隔（小时）",
    updateIntervalDesc: "自动检查更新之间的最短时间间隔",
  },
}

export function getSettingsCopy(locale: DashboardLocale): SettingsCopy {
  return locale === "zh" ? SETTINGS_ZH : SETTINGS_EN
}
