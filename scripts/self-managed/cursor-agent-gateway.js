#!/usr/bin/env node
/**
 * Self-managed Cursor Agent gateway installer.
 *
 * This script intentionally does not depend on @cometix/ccursor, Cursor++ Hub,
 * or any third-party login. It wires the readable agent-vibes protocol bridge
 * to Cursor's native agent domains and stores BYOK credentials locally.
 */

const { execFileSync, spawnSync } = require("child_process")
const fs = require("fs")
const http2 = require("http2")
const os = require("os")
const path = require("path")

const ROOT = path.resolve(__dirname, "..", "..")
const HOME = os.homedir()
const DATA_DIR =
  process.env.AGENT_VIBES_DATA_DIR || path.join(HOME, ".agent-vibes")
const ACCOUNTS_PATH =
  process.env.AGENT_VIBES_OPENAI_COMPAT_ACCOUNTS_PATH ||
  path.join(DATA_DIR, "data", "openai-compat-accounts.json")
const SELF_CONFIG_PATH = path.join(DATA_DIR, "self-managed.json")
const LOG_DIR = path.join(DATA_DIR, "logs")
const BIN_DIR = path.join(DATA_DIR, "bin")
const BRIDGE_PORT = Number(process.env.PORT || "2026")
const HOSTS_BEGIN = "# BEGIN Agent Vibes self-managed Cursor agent route"
const HOSTS_END = "# END Agent Vibes self-managed Cursor agent route"
const PID_FILE =
  process.platform === "win32"
    ? path.join(os.tmpdir(), "agent-vibes-cursor-agent-relay.pid")
    : "/tmp/agent-vibes-cursor-agent-relay.pid"

const AGENT_DOMAINS = [
  "agent-gcpp-uswest.api5.cursor.sh",
  "agent-gcpp-eucentral.api5.cursor.sh",
  "agent-gcpp-apsoutheast.api5.cursor.sh",
  "agentn-gcpp-uswest.api5.cursor.sh",
  "agentn-gcpp-eucentral.api5.cursor.sh",
  "agentn-gcpp-apsoutheast.api5.cursor.sh",
  "agent.us.api5.cursor.sh",
  "agent.eu.api5.cursor.sh",
  "agent.ap.api5.cursor.sh",
  "agentn.us.api5.cursor.sh",
  "agentn.eu.api5.cursor.sh",
  "agentn.ap.api5.cursor.sh",
  "agent.api5.cursor.sh",
  "agentn.api5.cursor.sh",
  "agent.api2.cursor.sh",
  "agentn.api2.cursor.sh",
  "a.cursor.sh",
]

const GREEN = "\x1b[0;32m"
const RED = "\x1b[0;31m"
const YELLOW = "\x1b[1;33m"
const CYAN = "\x1b[0;36m"
const DIM = "\x1b[2m"
const NC = "\x1b[0m"

const args = process.argv.slice(2)
const command = args[0] || "status"

function usage() {
  console.log(`
agent-vibes self-managed — BYOK Cursor Agent gateway without ccursor/LinuxDo

Usage:
  agent-vibes self-managed configure --api-key KEY [--base-url URL]
  agent-vibes self-managed install [--api-key KEY] [--base-url URL]
  agent-vibes self-managed status [--json]
  agent-vibes self-managed uninstall

Options:
  --label NAME                 Account label (default: skylink-ai)
  --base-url URL               OpenAI-compatible base URL
                               (default: https://skylink-gateway.com/api/v1)
  --api-key KEY                OpenAI-compatible API key
                               (or set SKYLINK_API_KEY / OPENAI_COMPAT_API_KEY)
  --responses-mode MODE        auto | always | never (default: auto)
  --prefer-responses           Prefer /responses for this account
  --fast                       Request priority/fast service tier (default)
  --no-fast                    Do not request priority service tier
  --service-tier TIER          Explicit service tier (fast maps to priority)
  --max-context-tokens N       Optional account context limit
  --skip-build                 Do not run npm run build during install
  --skip-cert                  Do not run agent-vibes cert during install
  --skip-route                 Do not modify hosts/relay route during install
  --json                       Print machine-readable status
`)
}

function option(name, fallback) {
  const prefix = `${name}=`
  const hit = args.find((arg) => arg.startsWith(prefix))
  if (hit) return hit.slice(prefix.length)
  const idx = args.indexOf(name)
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) {
    return args[idx + 1]
  }
  return fallback
}

function hasFlag(name) {
  return args.includes(name)
}

function normalizeServiceTier(rawValue) {
  const normalized = String(rawValue || "")
    .trim()
    .toLowerCase()
  if (!normalized) return undefined
  switch (normalized.replace(/[^a-z0-9]+/g, "_")) {
    case "priority":
    case "fast":
    case "true":
    case "on":
    case "enabled":
    case "1":
      return "priority"
    case "none":
    case "off":
    case "false":
    case "disabled":
    case "0":
      return undefined
    default:
      return normalized
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function run(commandName, commandArgs, opts = {}) {
  const result = spawnSync(commandName, commandArgs, {
    cwd: ROOT,
    stdio: "inherit",
    ...opts,
  })
  if (result.error) throw result.error
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${commandName} ${commandArgs.join(" ")} failed`)
  }
}

function capture(commandName, commandArgs, opts = {}) {
  try {
    return execFileSync(commandName, commandArgs, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    }).trim()
  } catch {
    return ""
  }
}

function getHostsPath() {
  return process.platform === "win32"
    ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
    : "/etc/hosts"
}

function getRouteBlock() {
  return [
    HOSTS_BEGIN,
    ...AGENT_DOMAINS.map((domain) => `127.0.0.1 ${domain}`),
    HOSTS_END,
    "",
  ].join("\n")
}

function stripRouteBlock(content) {
  const escapedBegin = HOSTS_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const escapedEnd = HOSTS_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return content.replace(
    new RegExp(`\\n?${escapedBegin}[\\s\\S]*?${escapedEnd}\\n?`, "g"),
    "\n"
  )
}

function installHostsRoute() {
  const hostsPath = getHostsPath()
  const current = fs.existsSync(hostsPath)
    ? fs.readFileSync(hostsPath, "utf8")
    : ""
  const cleaned = stripRouteBlock(current).trimEnd()
  fs.writeFileSync(hostsPath, `${cleaned}\n\n${getRouteBlock()}`)
  console.log(`${GREEN}✓${NC} Installed hosts route in ${hostsPath}`)
}

function runRouteWithElevation(routeCommand) {
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    process.getuid() !== 0
  ) {
    run("sudo", [process.execPath, __filename, `${routeCommand}-direct`])
    return
  }
  if (routeCommand === "install-route") installHostsRoute()
  else uninstallHostsRoute()
}

function uninstallHostsRoute() {
  const hostsPath = getHostsPath()
  if (!fs.existsSync(hostsPath)) return
  const current = fs.readFileSync(hostsPath, "utf8")
  const cleaned = stripRouteBlock(current)
  fs.writeFileSync(hostsPath, cleaned.trimEnd() + "\n")
  console.log(`${GREEN}✓${NC} Removed hosts route from ${hostsPath}`)
}

function hasHostsRoute() {
  const hostsPath = getHostsPath()
  return (
    fs.existsSync(hostsPath) &&
    fs.readFileSync(hostsPath, "utf8").includes(HOSTS_BEGIN)
  )
}

function readSelfConfig() {
  try {
    return JSON.parse(fs.readFileSync(SELF_CONFIG_PATH, "utf8"))
  } catch {
    return {}
  }
}

function writeSelfConfig(next) {
  ensureDir(DATA_DIR)
  const current = readSelfConfig()
  fs.writeFileSync(
    SELF_CONFIG_PATH,
    JSON.stringify({ ...current, ...next }, null, 2) + "\n"
  )
}

function configureAccount() {
  ensureDir(path.dirname(ACCOUNTS_PATH))
  const label = option(
    "--label",
    process.env.OPENAI_COMPAT_LABEL || "skylink-ai"
  )
  const baseUrl = option(
    "--base-url",
    process.env.OPENAI_COMPAT_BASE_URL || "https://skylink-gateway.com/api/v1"
  )
  const apiKey =
    option("--api-key") ||
    process.env.SKYLINK_API_KEY ||
    process.env.OPENAI_COMPAT_API_KEY
  const responsesMode = option(
    "--responses-mode",
    process.env.OPENAI_COMPAT_USE_RESPONSES_API || "auto"
  )
  const preferResponses =
    hasFlag("--prefer-responses") || responsesMode === "always"
  const serviceTier = hasFlag("--no-fast")
    ? undefined
    : normalizeServiceTier(
        option(
          "--service-tier",
          process.env.OPENAI_COMPAT_SERVICE_TIER ||
            process.env.CODEX_SERVICE_TIER ||
            "priority"
        )
      )
  const maxContextTokens = option("--max-context-tokens")

  if (!apiKey) {
    if (!fs.existsSync(ACCOUNTS_PATH)) {
      throw new Error(
        "Missing API key. Pass --api-key or set SKYLINK_API_KEY / OPENAI_COMPAT_API_KEY."
      )
    }
    writeSelfConfig({ responsesMode, serviceTier, port: BRIDGE_PORT })
    console.log(
      `${YELLOW}⊘${NC} No API key provided; kept existing accounts file`
    )
    return
  }

  let data = { accounts: [] }
  if (fs.existsSync(ACCOUNTS_PATH)) {
    data = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"))
    if (!Array.isArray(data.accounts)) data.accounts = []
  }

  const account = {
    label,
    baseUrl,
    apiKey,
    preferResponsesApi: preferResponses,
  }
  if (serviceTier) account.serviceTier = serviceTier
  if (maxContextTokens) account.maxContextTokens = Number(maxContextTokens)

  const idx = data.accounts.findIndex((item) => item.label === label)
  if (idx >= 0) data.accounts[idx] = { ...data.accounts[idx], ...account }
  else data.accounts.push(account)

  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  })
  writeSelfConfig({
    responsesMode,
    serviceTier,
    port: BRIDGE_PORT,
    accountsPath: ACCOUNTS_PATH,
  })
  console.log(
    `${GREEN}✓${NC} Wrote OpenAI-compatible account: ${ACCOUNTS_PATH}`
  )
  console.log(
    `${GREEN}✓${NC} Responses mode: ${responsesMode}${preferResponses ? " (account prefers /responses)" : ""}`
  )
  console.log(
    `${GREEN}✓${NC} Service tier: ${serviceTier || "default"}${serviceTier === "priority" ? " (fast)" : ""}`
  )
}

function certExists() {
  const dataCert = path.join(DATA_DIR, "certs", "server.pem")
  const dataKey = path.join(DATA_DIR, "certs", "server-key.pem")
  const appCert = path.join(
    ROOT,
    "apps",
    "protocol-bridge",
    "certs",
    "localhost.crt"
  )
  const appKey = path.join(
    ROOT,
    "apps",
    "protocol-bridge",
    "certs",
    "localhost.key"
  )
  return (
    (fs.existsSync(dataCert) && fs.existsSync(dataKey)) ||
    (fs.existsSync(appCert) && fs.existsSync(appKey))
  )
}

function ensureCerts() {
  if (certExists()) {
    console.log(`${YELLOW}⊘${NC} Certificates already exist`)
    return
  }
  run(process.execPath, [path.join(ROOT, "bin", "agent-vibes"), "cert"])
}

function mainBuilt() {
  return fs.existsSync(
    path.join(ROOT, "apps", "protocol-bridge", "dist", "main.js")
  )
}

function buildBridge() {
  if (!fs.existsSync(path.join(ROOT, "node_modules"))) {
    run("npm", ["install"])
  }
  run("npm", ["run", "build"])
}

function writeLaunchdPlist(
  label,
  programArguments,
  env,
  stdoutPath,
  stderrPath
) {
  const plistPath = path.join(HOME, "Library", "LaunchAgents", `${label}.plist`)
  ensureDir(path.dirname(plistPath))
  const envXml = Object.entries(env || {})
    .map(
      ([key, value]) =>
        `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(String(value))}</string>`
    )
    .join("\n")
  const argsXml = programArguments
    .map((value) => `    <string>${escapeXml(String(value))}</string>`)
    .join("\n")
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
${envXml ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envXml}\n  </dict>\n` : ""}</dict>
</plist>
`
  fs.writeFileSync(plistPath, plist)
  capture("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath])
  run("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath])
  run("launchctl", ["enable", `gui/${process.getuid()}/${label}`])
  console.log(`${GREEN}✓${NC} Installed launchd service ${label}`)
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function installMacServices() {
  ensureDir(LOG_DIR)
  const cfg = readSelfConfig()
  const node = process.execPath
  const main = path.join(ROOT, "apps", "protocol-bridge", "dist", "main.js")
  const relay = path.join(ROOT, "scripts", "proxy", "tcp-relay.js")
  const env = {
    PATH: process.env.PATH || "",
    AGENT_VIBES_DATA_DIR: DATA_DIR,
    AGENT_VIBES_OPENAI_COMPAT_ACCOUNTS_PATH: ACCOUNTS_PATH,
    OPENAI_COMPAT_USE_RESPONSES_API: cfg.responsesMode || "auto",
    OPENAI_COMPAT_SERVICE_TIER: cfg.serviceTier || "",
    PORT: String(BRIDGE_PORT),
  }
  writeLaunchdPlist(
    "com.agent-vibes.protocol-bridge",
    [node, main],
    env,
    path.join(LOG_DIR, "protocol-bridge.out.log"),
    path.join(LOG_DIR, "protocol-bridge.err.log")
  )
  writeLaunchdPlist(
    "com.agent-vibes.cursor-agent-relay",
    [node, relay, "0.0.0.0", "443", "127.0.0.1", String(BRIDGE_PORT), PID_FILE],
    { PATH: process.env.PATH || "" },
    path.join(LOG_DIR, "cursor-agent-relay.out.log"),
    path.join(LOG_DIR, "cursor-agent-relay.err.log")
  )
}

function writeWindowsLaunchers() {
  ensureDir(BIN_DIR)
  ensureDir(LOG_DIR)
  const cfg = readSelfConfig()
  const bridgeCmd = path.join(BIN_DIR, "start-protocol-bridge.cmd")
  const relayCmd = path.join(BIN_DIR, "start-cursor-agent-relay.cmd")
  const node = process.execPath
  const main = path.join(ROOT, "apps", "protocol-bridge", "dist", "main.js")
  const relay = path.join(ROOT, "scripts", "proxy", "tcp-relay.js")
  fs.writeFileSync(
    bridgeCmd,
    [
      "@echo off",
      `set "AGENT_VIBES_DATA_DIR=${DATA_DIR}"`,
      `set "AGENT_VIBES_OPENAI_COMPAT_ACCOUNTS_PATH=${ACCOUNTS_PATH}"`,
      `set "OPENAI_COMPAT_USE_RESPONSES_API=${cfg.responsesMode || "auto"}"`,
      `set "OPENAI_COMPAT_SERVICE_TIER=${cfg.serviceTier || ""}"`,
      `set "PORT=${BRIDGE_PORT}"`,
      `"${node}" "${main}" >> "${path.join(LOG_DIR, "protocol-bridge.out.log")}" 2>> "${path.join(LOG_DIR, "protocol-bridge.err.log")}"`,
      "",
    ].join("\r\n")
  )
  fs.writeFileSync(
    relayCmd,
    [
      "@echo off",
      `"${node}" "${relay}" 0.0.0.0 443 127.0.0.1 ${BRIDGE_PORT} "${PID_FILE}" >> "${path.join(LOG_DIR, "cursor-agent-relay.out.log")}" 2>> "${path.join(LOG_DIR, "cursor-agent-relay.err.log")}"`,
      "",
    ].join("\r\n")
  )
  return { bridgeCmd, relayCmd }
}

function installWindowsServices() {
  const { bridgeCmd, relayCmd } = writeWindowsLaunchers()
  run("schtasks", [
    "/Create",
    "/TN",
    "AgentVibesProtocolBridge",
    "/SC",
    "ONLOGON",
    "/TR",
    bridgeCmd,
    "/RL",
    "HIGHEST",
    "/F",
  ])
  run("schtasks", [
    "/Create",
    "/TN",
    "AgentVibesCursorAgentRelay",
    "/SC",
    "ONLOGON",
    "/TR",
    relayCmd,
    "/RL",
    "HIGHEST",
    "/F",
  ])
  capture("schtasks", ["/Run", "/TN", "AgentVibesProtocolBridge"])
  capture("schtasks", ["/Run", "/TN", "AgentVibesCursorAgentRelay"])
  console.log(`${GREEN}✓${NC} Installed Windows scheduled tasks`)
}

function installLinuxServices() {
  ensureDir(LOG_DIR)
  const cfg = readSelfConfig()
  const systemdDir = path.join(HOME, ".config", "systemd", "user")
  ensureDir(systemdDir)
  const node = process.execPath
  const main = path.join(ROOT, "apps", "protocol-bridge", "dist", "main.js")
  const relay = path.join(ROOT, "scripts", "proxy", "tcp-relay.js")
  fs.writeFileSync(
    path.join(systemdDir, "agent-vibes-protocol-bridge.service"),
    `[Unit]
Description=Agent Vibes protocol bridge

[Service]
Environment=AGENT_VIBES_DATA_DIR=${DATA_DIR}
Environment=AGENT_VIBES_OPENAI_COMPAT_ACCOUNTS_PATH=${ACCOUNTS_PATH}
Environment=OPENAI_COMPAT_USE_RESPONSES_API=${cfg.responsesMode || "auto"}
Environment=OPENAI_COMPAT_SERVICE_TIER=${cfg.serviceTier || ""}
Environment=PORT=${BRIDGE_PORT}
ExecStart=${node} ${main}
Restart=always

[Install]
WantedBy=default.target
`
  )
  fs.writeFileSync(
    path.join(systemdDir, "agent-vibes-cursor-agent-relay.service"),
    `[Unit]
Description=Agent Vibes Cursor agent TLS relay

[Service]
ExecStart=${node} ${relay} 0.0.0.0 443 127.0.0.1 ${BRIDGE_PORT} ${PID_FILE}
Restart=always

[Install]
WantedBy=default.target
`
  )
  run("systemctl", ["--user", "daemon-reload"])
  run("systemctl", [
    "--user",
    "enable",
    "--now",
    "agent-vibes-protocol-bridge.service",
  ])
  run("systemctl", [
    "--user",
    "enable",
    "--now",
    "agent-vibes-cursor-agent-relay.service",
  ])
  console.log(`${GREEN}✓${NC} Installed systemd user services`)
  console.log(
    `${YELLOW}Note:${NC} Linux may require permission to bind port 443.`
  )
}

function installServices() {
  if (process.platform === "darwin") return installMacServices()
  if (process.platform === "win32") return installWindowsServices()
  return installLinuxServices()
}

function uninstallServices() {
  if (process.platform === "darwin") {
    for (const label of [
      "com.agent-vibes.protocol-bridge",
      "com.agent-vibes.cursor-agent-relay",
    ]) {
      const plistPath = path.join(
        HOME,
        "Library",
        "LaunchAgents",
        `${label}.plist`
      )
      capture("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath])
      if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath)
      console.log(`${GREEN}✓${NC} Removed launchd service ${label}`)
    }
    return
  }
  if (process.platform === "win32") {
    capture("schtasks", ["/End", "/TN", "AgentVibesProtocolBridge"])
    capture("schtasks", ["/End", "/TN", "AgentVibesCursorAgentRelay"])
    capture("schtasks", ["/Delete", "/TN", "AgentVibesProtocolBridge", "/F"])
    capture("schtasks", ["/Delete", "/TN", "AgentVibesCursorAgentRelay", "/F"])
    console.log(`${GREEN}✓${NC} Removed Windows scheduled tasks`)
    return
  }
  capture("systemctl", [
    "--user",
    "disable",
    "--now",
    "agent-vibes-protocol-bridge.service",
  ])
  capture("systemctl", [
    "--user",
    "disable",
    "--now",
    "agent-vibes-cursor-agent-relay.service",
  ])
  console.log(`${GREEN}✓${NC} Removed systemd user services`)
}

function bridgeHealth() {
  return new Promise((resolve) => {
    let session
    const timer = setTimeout(() => {
      try {
        session?.destroy()
      } catch {}
      resolve(false)
    }, 2000)
    try {
      session = http2.connect(`https://localhost:${BRIDGE_PORT}`, {
        rejectUnauthorized: false,
      })
      session.on("error", () => {
        clearTimeout(timer)
        resolve(false)
      })
      const req = session.request({ ":path": "/health" })
      req.on("response", (headers) => {
        clearTimeout(timer)
        resolve(Number(headers[":status"] || 0) < 500)
        try {
          req.close()
          session.close()
        } catch {}
      })
      req.on("error", () => {
        clearTimeout(timer)
        resolve(false)
      })
      req.end()
    } catch {
      clearTimeout(timer)
      resolve(false)
    }
  })
}

function summarizeAccounts() {
  if (!fs.existsSync(ACCOUNTS_PATH)) return []
  try {
    const data = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"))
    const cfg = readSelfConfig()
    return (data.accounts || []).map((account) => ({
      label: account.label,
      baseUrl: account.baseUrl,
      preferResponsesApi: account.preferResponsesApi === true,
      serviceTier: account.serviceTier || cfg.serviceTier,
      hasApiKey: Boolean(account.apiKey),
    }))
  } catch {
    return []
  }
}

async function status() {
  const health = await bridgeHealth()
  const payload = {
    platform: process.platform,
    dataDir: DATA_DIR,
    accountsPath: ACCOUNTS_PATH,
    selfConfigPath: SELF_CONFIG_PATH,
    built: mainBuilt(),
    certs: certExists(),
    hostsRoute: hasHostsRoute(),
    bridgeHealth: health,
    accounts: summarizeAccounts(),
    config: readSelfConfig(),
  }
  if (hasFlag("--json")) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  console.log(`${CYAN}═══ Agent Vibes Self-managed Cursor Gateway ═══${NC}`)
  console.log(`  Built:        ${payload.built ? GREEN + "✓" : RED + "✗"}${NC}`)
  console.log(`  Certificates: ${payload.certs ? GREEN + "✓" : RED + "✗"}${NC}`)
  console.log(
    `  Hosts route:  ${payload.hostsRoute ? GREEN + "✓" : RED + "✗"}${NC}`
  )
  console.log(
    `  Bridge:       ${payload.bridgeHealth ? GREEN + "✓ healthy" : RED + "✗ unreachable"}${NC}`
  )
  console.log(`  Data dir:     ${payload.dataDir}`)
  console.log(`  Accounts:     ${payload.accounts.length}`)
  for (const account of payload.accounts) {
    console.log(
      `    - ${account.label || "(unnamed)"} ${DIM}${account.baseUrl || ""}${NC} responses=${account.preferResponsesApi ? "prefer" : "default"} tier=${account.serviceTier || "default"} key=${account.hasApiKey ? "yes" : "no"}`
    )
  }
}

async function install() {
  ensureDir(DATA_DIR)
  ensureDir(LOG_DIR)
  configureAccount()
  if (!hasFlag("--skip-build")) buildBridge()
  if (!hasFlag("--skip-cert")) ensureCerts()
  if (!hasFlag("--skip-route")) runRouteWithElevation("install-route")
  installServices()
  await status()
  console.log("")
  console.log(
    `${YELLOW}Important:${NC} fully quit and restart Cursor after install.`
  )
}

async function main() {
  try {
    if (command === "help" || command === "--help" || command === "-h")
      return usage()
    if (command === "configure") return configureAccount()
    if (command === "install") return install()
    if (command === "install-route")
      return runRouteWithElevation("install-route")
    if (command === "uninstall-route")
      return runRouteWithElevation("uninstall-route")
    if (command === "install-route-direct") return installHostsRoute()
    if (command === "uninstall-route-direct") return uninstallHostsRoute()
    if (command === "install-service" || command === "install-services")
      return installServices()
    if (command === "uninstall-service" || command === "uninstall-services")
      return uninstallServices()
    if (command === "uninstall") {
      uninstallServices()
      runRouteWithElevation("uninstall-route")
      return
    }
    if (command === "status") return status()
    usage()
    process.exitCode = 1
  } catch (error) {
    console.error(`${RED}Error:${NC} ${error.message}`)
    process.exitCode = 1
  }
}

main()
