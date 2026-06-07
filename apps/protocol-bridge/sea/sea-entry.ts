// CRITICAL: reflect-metadata MUST be imported FIRST for NestJS DI to work in esbuild bundle.
import "reflect-metadata"

const childProcess = require("child_process")
const fs = require("fs")
const http2 = require("http2")
const net = require("net")
const os = require("os")
const path = require("path")

const sea = (() => {
  try {
    return require("node:sea")
  } catch {
    return null
  }
})()

const SKYLINK_BASE_URL = "https://skylink-gateway.com/api/v1"
const HOME = os.homedir()
const DATA_DIR =
  process.env.SKYLINK_CURSOR_GATEWAY_DATA_DIR ||
  path.join(HOME, ".skylink-cursor-gateway")
const ACCOUNTS_PATH = path.join(DATA_DIR, "data", "skylink-account.json")
const SELF_CONFIG_PATH = path.join(DATA_DIR, "config.json")
const LOG_DIR = path.join(DATA_DIR, "logs")
const CERT_DIR = path.join(DATA_DIR, "certs")
const DISABLED_CONFIG_DIR = path.join(DATA_DIR, "disabled-config")
const BRIDGE_PORT = Number(process.env.PORT || "2026")
const PID_FILE =
  process.platform === "win32"
    ? path.join(os.tmpdir(), "skylink-cursor-gateway-relay.pid")
    : "/tmp/skylink-cursor-gateway-relay.pid"
const HOSTS_BEGIN = "# BEGIN Skylink Cursor Gateway route"
const HOSTS_END = "# END Skylink Cursor Gateway route"
const BRIDGE_LABEL = "com.skylink.cursor-gateway.bridge"
const RELAY_LABEL = "com.skylink.cursor-gateway.relay"
const GREEN = "\x1b[0;32m"
const RED = "\x1b[0;31m"
const YELLOW = "\x1b[1;33m"
const CYAN = "\x1b[0;36m"
const NC = "\x1b[0m"

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

const CERT_DNS_NAMES = [
  "localhost",
  "*.api5.cursor.sh",
  "*.cursor.sh",
  "api2.cursor.sh",
  "api2geo.cursor.sh",
  "api2direct.cursor.sh",
  "agent.api2.cursor.sh",
  "agentn.api2.cursor.sh",
  "agent.api2geo.cursor.sh",
  "agentn.api2geo.cursor.sh",
  "agent.api2direct.cursor.sh",
  "agentn.api2direct.cursor.sh",
  "agent.api5.cursor.sh",
  "agentn.api5.cursor.sh",
  "agent.api5geo.cursor.sh",
  "agent.api5lat.cursor.sh",
  "agentn.api5geo.cursor.sh",
  "agentn.api5lat.cursor.sh",
  ...AGENT_DOMAINS,
]

function disabledConfigPath(filename: string): string {
  return path.join(DISABLED_CONFIG_DIR, filename)
}

function skylinkOnlyEnv(): Record<string, string> {
  return {
    AGENT_VIBES_DATA_DIR: DATA_DIR,
    AGENT_VIBES_OPENAI_COMPAT_ACCOUNTS_PATH: ACCOUNTS_PATH,
    AGENT_VIBES_SKYLINK_ONLY: "true",
    OPENAI_COMPAT_BASE_URL: SKYLINK_BASE_URL,
    OPENAI_COMPAT_USE_RESPONSES_API: "always",
    OPENAI_COMPAT_SERVICE_TIER: "priority",
    PORT: String(BRIDGE_PORT),
    AGENT_VIBES_CODEX_ACCOUNTS_PATH: disabledConfigPath("codex-accounts.json"),
    AGENT_VIBES_CLAUDE_API_ACCOUNTS_PATH: disabledConfigPath(
      "claude-api-accounts.json"
    ),
    AGENT_VIBES_KIRO_ACCOUNTS_PATH: disabledConfigPath("kiro-accounts.json"),
    AGENT_VIBES_ANTIGRAVITY_ACCOUNTS_PATH: disabledConfigPath(
      "antigravity-accounts.json"
    ),
    CODEX_API_KEY: "",
    CODEX_ACCESS_TOKEN: "",
    CODEX_ID_TOKEN: "",
    CODEX_REFRESH_TOKEN: "",
    CODEX_HOME: disabledConfigPath("codex-home"),
    CLAUDE_API_KEY: "",
    CLAUDE_BASE_URL: "",
  }
}

function usage(): void {
  const name = path.basename(process.execPath)
  console.log(`Skylink Cursor Gateway

Usage:
  ${name} install --api-key sk-...
  ${name} status
  ${name} uninstall

Options:
  --api-key KEY     Skylink API Key.

After install, fully quit and restart Cursor.`)
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function run(
  command: string,
  args: string[],
  opts: Record<string, unknown> = {}
) {
  const result = childProcess.spawnSync(command, args, {
    stdio: "inherit",
    ...opts,
  })
  if (result.error) {
    throw result.error
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`)
  }
}

function capture(command: string, args: string[]): string {
  try {
    return childProcess
      .execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      .trim()
  } catch {
    return ""
  }
}

function getOption(name: string): string | undefined {
  const args = process.argv.slice(2)
  const prefix = `${name}=`
  const hit = args.find((arg) => arg.startsWith(prefix))
  if (hit) return hit.slice(prefix.length)
  const index = args.indexOf(name)
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) {
    return args[index + 1]
  }
  return undefined
}

function getApiKey(): string {
  const apiKey = getOption("--api-key") || process.env.SKYLINK_API_KEY || ""
  if (!apiKey.trim()) {
    throw new Error("Missing Skylink API Key. Use --api-key sk-...")
  }
  if (!apiKey.trim().startsWith("sk-")) {
    throw new Error("Invalid Skylink API Key. It should start with sk-")
  }
  return apiKey.trim()
}

function writeConfig(apiKey: string): void {
  ensureDir(path.dirname(ACCOUNTS_PATH))
  ensureDir(DISABLED_CONFIG_DIR)
  const account = {
    label: "skylink",
    baseUrl: SKYLINK_BASE_URL,
    apiKey,
    preferResponsesApi: true,
    serviceTier: "priority",
    maxContextTokens: 200000,
  }
  fs.writeFileSync(
    ACCOUNTS_PATH,
    JSON.stringify({ accounts: [account] }, null, 2) + "\n",
    { mode: 0o600 }
  )
  fs.writeFileSync(
    SELF_CONFIG_PATH,
    JSON.stringify(
      {
        baseUrl: SKYLINK_BASE_URL,
        responsesMode: "always",
        serviceTier: "priority",
        port: BRIDGE_PORT,
        accountsPath: ACCOUNTS_PATH,
      },
      null,
      2
    ) + "\n"
  )
}

function getHostsPath(): string {
  return process.platform === "win32"
    ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
    : "/etc/hosts"
}

function getRouteBlock(): string {
  return [
    HOSTS_BEGIN,
    ...AGENT_DOMAINS.map((domain) => `127.0.0.1 ${domain}`),
    HOSTS_END,
    "",
  ].join("\n")
}

function stripRouteBlock(content: string): string {
  const begin = HOSTS_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const end = HOSTS_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return content.replace(
    new RegExp(`\\n?${begin}[\\s\\S]*?${end}\\n?`, "g"),
    "\n"
  )
}

function installHostsRouteDirect(): void {
  const hostsPath = getHostsPath()
  const current = fs.existsSync(hostsPath)
    ? fs.readFileSync(hostsPath, "utf8")
    : ""
  fs.writeFileSync(
    hostsPath,
    `${stripRouteBlock(current).trimEnd()}\n\n${getRouteBlock()}`
  )
  console.log(`${GREEN}✓${NC} Cursor route installed`)
}

function uninstallHostsRouteDirect(): void {
  const hostsPath = getHostsPath()
  if (!fs.existsSync(hostsPath)) return
  const current = fs.readFileSync(hostsPath, "utf8")
  fs.writeFileSync(hostsPath, stripRouteBlock(current).trimEnd() + "\n")
  console.log(`${GREEN}✓${NC} Cursor route removed`)
}

function runRouteWithElevation(
  command: "install-route-direct" | "uninstall-route-direct"
): void {
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    process.getuid() !== 0
  ) {
    run("sudo", [process.execPath, command])
    return
  }
  if (command === "install-route-direct") installHostsRouteDirect()
  else uninstallHostsRouteDirect()
}

function hasHostsRoute(): boolean {
  const hostsPath = getHostsPath()
  return (
    fs.existsSync(hostsPath) &&
    fs.readFileSync(hostsPath, "utf8").includes(HOSTS_BEGIN)
  )
}

function opensslConfigPath(): string {
  return path.join(CERT_DIR, "server-openssl.cnf")
}

function writeOpenSslConfig(): void {
  const dnsNames = Array.from(new Set(CERT_DNS_NAMES))
  const altNames = [
    ...dnsNames.map((name, index) => `DNS.${index + 1} = ${name}`),
    "IP.1 = 127.0.0.1",
    "IP.2 = 127.0.0.2",
    "IP.3 = 127.0.0.3",
    "IP.4 = ::1",
  ].join("\n")
  fs.writeFileSync(
    opensslConfigPath(),
    `[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = req_ext

[dn]
CN = agent.api5.cursor.sh

[req_ext]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
${altNames}
`
  )
}

function certExists(): boolean {
  return (
    fs.existsSync(path.join(CERT_DIR, "ca.pem")) &&
    fs.existsSync(path.join(CERT_DIR, "server.pem")) &&
    fs.existsSync(path.join(CERT_DIR, "server-key.pem"))
  )
}

function ensureCertificates(): void {
  ensureDir(CERT_DIR)
  const caPem = path.join(CERT_DIR, "ca.pem")
  const caKey = path.join(CERT_DIR, "ca-key.pem")
  const serverPem = path.join(CERT_DIR, "server.pem")
  const serverKey = path.join(CERT_DIR, "server-key.pem")
  const serverCsr = path.join(CERT_DIR, "server.csr")

  if (!certExists()) {
    console.log(`${CYAN}▸ Generating local TLS certificate...${NC}`)
    writeOpenSslConfig()
    run("openssl", ["genrsa", "-out", caKey, "2048"])
    run("openssl", [
      "req",
      "-x509",
      "-new",
      "-nodes",
      "-key",
      caKey,
      "-sha256",
      "-days",
      "3650",
      "-out",
      caPem,
      "-subj",
      "/CN=Skylink Cursor Gateway Local CA",
    ])
    run("openssl", ["genrsa", "-out", serverKey, "2048"])
    run("openssl", [
      "req",
      "-new",
      "-key",
      serverKey,
      "-out",
      serverCsr,
      "-config",
      opensslConfigPath(),
    ])
    run("openssl", [
      "x509",
      "-req",
      "-in",
      serverCsr,
      "-CA",
      caPem,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      serverPem,
      "-days",
      "825",
      "-sha256",
      "-extfile",
      opensslConfigPath(),
      "-extensions",
      "req_ext",
    ])
    fs.chmodSync(serverKey, 0o600)
    fs.chmodSync(caKey, 0o600)
  }

  if (process.platform === "darwin") {
    console.log(`${CYAN}▸ Trusting local certificate authority...${NC}`)
    run("sudo", [
      "security",
      "add-trusted-cert",
      "-d",
      "-r",
      "trustRoot",
      "-k",
      "/Library/Keychains/System.keychain",
      caPem,
    ])
  } else if (process.platform === "win32") {
    run("certutil", ["-addstore", "-f", "Root", caPem])
  } else {
    console.log(
      `${YELLOW}Note:${NC} trust ${caPem} in your system certificate store if Cursor reports TLS errors.`
    )
  }
}

function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function writeLaunchdPlist(
  label: string,
  programArguments: string[],
  env: Record<string, string>
): void {
  const plistPath = path.join(HOME, "Library", "LaunchAgents", `${label}.plist`)
  ensureDir(path.dirname(plistPath))
  const argsXml = programArguments
    .map((value) => `    <string>${escapeXml(value)}</string>`)
    .join("\n")
  const envXml = Object.entries(env)
    .map(
      ([key, value]) =>
        `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`
    )
    .join("\n")
  fs.writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
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
  <string>${escapeXml(path.join(LOG_DIR, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(LOG_DIR, `${label}.err.log`))}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`
  )
  capture("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath])
  run("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath])
  run("launchctl", ["enable", `gui/${process.getuid()}/${label}`])
}

function installServices(): void {
  ensureDir(LOG_DIR)
  if (process.platform === "darwin") {
    const env = {
      PATH: process.env.PATH || "",
      ...skylinkOnlyEnv(),
    }
    writeLaunchdPlist(BRIDGE_LABEL, [process.execPath, "server"], env)
    writeLaunchdPlist(
      RELAY_LABEL,
      [
        process.execPath,
        "relay",
        "0.0.0.0",
        "443",
        "127.0.0.1",
        String(BRIDGE_PORT),
        PID_FILE,
      ],
      { PATH: process.env.PATH || "" }
    )
    console.log(`${GREEN}✓${NC} Background services installed`)
    return
  }
  throw new Error("This binary package currently supports macOS installation.")
}

function uninstallServices(): void {
  if (process.platform === "darwin") {
    for (const label of [BRIDGE_LABEL, RELAY_LABEL]) {
      const plistPath = path.join(
        HOME,
        "Library",
        "LaunchAgents",
        `${label}.plist`
      )
      capture("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath])
      if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath)
    }
    console.log(`${GREEN}✓${NC} Background services removed`)
    return
  }
}

function bridgeHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    let session: any
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
      req.on("response", (headers: Record<string, string>) => {
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

function summarizeAccount(): {
  hasApiKey: boolean
  serviceTier?: string
} {
  try {
    const data = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"))
    const account = data.accounts?.[0] || {}
    return {
      hasApiKey: Boolean(account.apiKey),
      serviceTier: account.serviceTier,
    }
  } catch {
    return { hasApiKey: false }
  }
}

async function status(json = false): Promise<void> {
  const health = await bridgeHealth()
  const account = summarizeAccount()
  const payload = {
    dataDir: DATA_DIR,
    route: hasHostsRoute(),
    bridge: health,
    baseUrl: SKYLINK_BASE_URL,
    fast: account.serviceTier === "priority",
    hasApiKey: account.hasApiKey,
  }
  if (json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  console.log(`${CYAN}Skylink Cursor Gateway${NC}`)
  console.log(
    `  Route:   ${payload.route ? GREEN + "OK" : RED + "Missing"}${NC}`
  )
  console.log(
    `  Bridge:  ${payload.bridge ? GREEN + "OK" : RED + "Stopped"}${NC}`
  )
  console.log(
    `  API Key: ${payload.hasApiKey ? GREEN + "OK" : RED + "Missing"}${NC}`
  )
  console.log(
    `  Fast:    ${payload.fast ? GREEN + "priority" : YELLOW + "default"}${NC}`
  )
}

async function install(): Promise<void> {
  ensureDir(DATA_DIR)
  ensureDir(LOG_DIR)
  writeConfig(getApiKey())
  ensureCertificates()
  runRouteWithElevation("install-route-direct")
  installServices()
  await status()
  console.log("")
  console.log(`${YELLOW}Important:${NC} fully quit and restart Cursor.`)
}

async function uninstall(): Promise<void> {
  uninstallServices()
  runRouteWithElevation("uninstall-route-direct")
  await status()
}

function relay(): void {
  const listenIp = process.argv[3] || "127.0.0.1"
  const listenPort = Number(process.argv[4] || "443")
  const targetIp = process.argv[5] || "127.0.0.1"
  const targetPort = Number(process.argv[6] || String(BRIDGE_PORT))
  const pidFile = process.argv[7] || PID_FILE
  fs.writeFileSync(pidFile, String(process.pid))
  const server = net.createServer((client: any) => {
    const upstream = net.createConnection(targetPort, targetIp)
    client.pipe(upstream)
    upstream.pipe(client)
    client.on("error", () => upstream.destroy())
    upstream.on("error", () => client.destroy())
  })
  const cleanup = () => {
    try {
      fs.unlinkSync(pidFile)
    } catch {}
  }
  server.on("error", (error: Error) => {
    console.error(`Relay error: ${error.message}`)
    cleanup()
    process.exit(1)
  })
  server.listen(listenPort, listenIp, () => {
    console.log(
      `Relay started: ${listenIp}:${listenPort} -> ${targetIp}:${targetPort}`
    )
  })
  process.on("SIGTERM", () => {
    server.close()
    cleanup()
    process.exit(0)
  })
  process.on("SIGINT", () => {
    server.close()
    cleanup()
    process.exit(0)
  })
}

function prepareServerEnv(): void {
  ensureDir(DISABLED_CONFIG_DIR)
  Object.assign(process.env, skylinkOnlyEnv())
}

function extractSeaAssets(): void {
  if (!sea || !sea.isSea()) return

  // Extract migration SQL files to ~/.agent-vibes/pgdata/migrations/
  const migrationsDir = path.join(DATA_DIR, "pgdata", "migrations")
  fs.mkdirSync(migrationsDir, { recursive: true })

  for (const key of sea.getAssetKeys()) {
    if (key.endsWith(".sql")) {
      const targetPath = path.join(migrationsDir, key)
      if (!fs.existsSync(targetPath)) {
        const content = sea.getAsset(key, "utf-8")
        fs.writeFileSync(targetPath, content)
        console.log(`[SEA] Extracted migration: ${key}`)
      }
    }
  }

  // Set __dirname to the migrations parent so PersistenceService finds them
  // PersistenceService uses path.join(__dirname, "migrations") from persistence.service.js
  // In SEA mode, __dirname is wrong, so we patch it via env var
  process.env.SEA_MIGRATIONS_DIR = migrationsDir
}

async function main(): Promise<void> {
  const command = process.argv[2] || "server"
  try {
    if (command === "help" || command === "--help" || command === "-h") {
      usage()
      return
    }
    if (command === "install") return await install()
    if (command === "status")
      return await status(process.argv.includes("--json"))
    if (command === "uninstall") return await uninstall()
    if (command === "install-route-direct") return installHostsRouteDirect()
    if (command === "uninstall-route-direct") return uninstallHostsRouteDirect()
    if (command === "relay") return relay()
    if (command !== "server") {
      usage()
      process.exitCode = 1
      return
    }
    prepareServerEnv()
    extractSeaAssets()
    require("../src/main")
  } catch (error) {
    console.error(
      `${RED}Error:${NC} ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}

void main()
