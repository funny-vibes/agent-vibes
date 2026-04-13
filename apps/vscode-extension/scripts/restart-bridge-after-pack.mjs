import fs from "fs"
import os from "os"
import path from "path"
import https from "https"
import { execFileSync, spawn } from "child_process"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const extensionRoot = path.resolve(__dirname, "..")
const packageJson = JSON.parse(
  fs.readFileSync(path.join(extensionRoot, "package.json"), "utf-8")
)

const publisher = packageJson.publisher || "funny-vibes"
const extensionName = packageJson.name || "agent-vibes"
const version = packageJson.version || "0.1.0"

const target = `${process.platform}-${process.arch}`
const exeExtension = process.platform === "win32" ? ".exe" : ""
const installedExtensionDir = path.join(
  os.homedir(),
  ".cursor",
  "extensions",
  `${publisher}.${extensionName}-${version}`
)
const binaryPath = path.join(
  installedExtensionDir,
  "bridge",
  target,
  `agent-vibes-bridge${exeExtension}`
)

const PID_FILE = path.join(os.tmpdir(), "agent-vibes-bridge.pid")
const LOG_FILE = path.join(os.tmpdir(), "agent-vibes-bridge.log")
const PREVIOUS_LOG_FILE = path.join(
  os.tmpdir(),
  "agent-vibes-bridge.previous.log"
)
const STARTUP_HEALTH_TIMEOUT_MS = 45000

function stripJsonComments(input) {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1")
}

function loadCursorSettings() {
  const candidates = []

  if (process.platform === "darwin") {
    candidates.push(
      path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "settings.json"
      )
    )
  } else if (process.platform === "win32") {
    const appData =
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    candidates.push(path.join(appData, "Cursor", "User", "settings.json"))
  } else {
    candidates.push(
      path.join(os.homedir(), ".config", "Cursor", "User", "settings.json")
    )
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    const raw = fs.readFileSync(candidate, "utf-8")
    try {
      return JSON.parse(raw)
    } catch {
      try {
        return JSON.parse(stripJsonComments(raw))
      } catch {
        console.warn(`[restart:bridge] Failed to parse settings: ${candidate}`)
      }
    }
  }

  return {}
}

function resolveConfig() {
  const settings = loadCursorSettings()
  const defaultDataDir = path.join(os.homedir(), ".agent-vibes")
  const dataDir =
    typeof settings["agentVibes.dataDir"] === "string" &&
    settings["agentVibes.dataDir"].trim()
      ? path.resolve(settings["agentVibes.dataDir"].trim())
      : defaultDataDir
  const port =
    typeof settings["agentVibes.port"] === "number" &&
    Number.isFinite(settings["agentVibes.port"])
      ? settings["agentVibes.port"]
      : 2026

  const env = {
    PORT: String(port),
    AGENT_VIBES_DATA_DIR: dataDir,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  }

  const accountOverrides = [
    [
      "agentVibes.antigravityAccountsPath",
      "AGENT_VIBES_ANTIGRAVITY_ACCOUNTS_PATH",
    ],
    [
      "agentVibes.claudeApiAccountsPath",
      "AGENT_VIBES_CLAUDE_API_ACCOUNTS_PATH",
    ],
    ["agentVibes.codexAccountsPath", "AGENT_VIBES_CODEX_ACCOUNTS_PATH"],
    [
      "agentVibes.openaiCompatAccountsPath",
      "AGENT_VIBES_OPENAI_COMPAT_ACCOUNTS_PATH",
    ],
  ]

  for (const [settingKey, envKey] of accountOverrides) {
    const value = settings[settingKey]
    if (typeof value === "string" && value.trim()) {
      env[envKey] = path.resolve(value.trim())
    }
  }

  if (settings["agentVibes.debugMode"] === true) {
    env.LOG_DEBUG = "true"
  }

  const caCertPath = path.join(dataDir, "certs", "ca.pem")
  if (fs.existsSync(caCertPath)) {
    env.NODE_EXTRA_CA_CERTS = caCertPath
  }

  return {
    env,
    port,
    dataDir,
    caCertPath,
  }
}

function readPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

function listBridgePids() {
  const binaryRealPath = fs.existsSync(binaryPath)
    ? fs.realpathSync(binaryPath)
    : binaryPath

  const pids = new Set()

  try {
    let lines
    if (process.platform === "win32") {
      // Windows: use wmic or PowerShell to list processes
      const psOutput = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          'Get-Process | Where-Object { $_.ProcessName -like "*agent-vibes-bridge*" } | Select-Object -ExpandProperty Id',
        ],
        { encoding: "utf-8" }
      )
      lines = psOutput
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
      for (const line of lines) {
        const pid = Number.parseInt(line, 10)
        if (Number.isFinite(pid)) pids.add(pid)
      }
    } else {
      const psOutput = execFileSync("ps", ["-axo", "pid=,command="], {
        encoding: "utf-8",
      })
      lines = psOutput
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
      for (const line of lines) {
        const match = line.match(/^(\d+)\s+(.*)$/)
        if (!match) continue
        const pid = Number.parseInt(match[1], 10)
        const command = match[2] || ""
        if (!Number.isFinite(pid)) continue
        if (
          command.includes("agent-vibes-bridge") &&
          (command.includes(binaryRealPath) ||
            command.includes(installedExtensionDir))
        ) {
          pids.add(pid)
        }
      }
    }
  } catch {
    // ps/powershell not available — fall back to PID file only
  }

  const pidFilePid = readPid()
  if (pidFilePid) pids.add(pidFilePid)
  return [...pids]
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function stopExistingBridge() {
  const pids = listBridgePids().filter((pid) => pid !== process.pid)
  if (pids.length === 0) return

  console.log(
    `[restart:bridge] Stopping existing bridge PID(s): ${pids.join(", ")}`
  )
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }

  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const alive = pids.filter(isAlive)
    if (alive.length === 0) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  for (const pid of pids) {
    if (!isAlive(pid)) continue
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }

  try {
    fs.unlinkSync(PID_FILE)
  } catch {}
}

function rotateLogFile() {
  if (!fs.existsSync(LOG_FILE)) return

  try {
    fs.rmSync(PREVIOUS_LOG_FILE, { force: true })
  } catch {}

  try {
    fs.renameSync(LOG_FILE, PREVIOUS_LOG_FILE)
    console.log(`[restart:bridge] Rotated log to ${PREVIOUS_LOG_FILE}`)
    return
  } catch {}

  try {
    fs.truncateSync(LOG_FILE, 0)
    console.log(`[restart:bridge] Truncated existing log at ${LOG_FILE}`)
  } catch {}
}

function waitForHealth(
  port,
  caCertPath,
  timeoutMs = STARTUP_HEALTH_TIMEOUT_MS
) {
  const ca = fs.existsSync(caCertPath) ? fs.readFileSync(caCertPath) : undefined
  const startedAt = Date.now()

  return new Promise((resolve) => {
    const attempt = () => {
      const req = https.get(
        {
          hostname: "localhost",
          port,
          path: "/health",
          method: "GET",
          ca,
          rejectUnauthorized: !!ca,
        },
        (res) => {
          res.resume()
          resolve(res.statusCode === 200)
        }
      )

      req.on("error", () => {
        if (Date.now() - startedAt >= timeoutMs) {
          resolve(false)
          return
        }
        setTimeout(attempt, 500)
      })

      req.setTimeout(3000, () => {
        req.destroy()
      })
    }

    attempt()
  })
}

async function main() {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Installed bridge not found: ${binaryPath}`)
  }

  const { env, port, dataDir, caCertPath } = resolveConfig()
  await stopExistingBridge()
  rotateLogFile()

  const logFd = fs.openSync(LOG_FILE, "a")
  const child = spawn(binaryPath, [], {
    env: {
      ...process.env,
      ...env,
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  })
  child.unref()
  fs.closeSync(logFd)

  if (child.pid) {
    fs.writeFileSync(PID_FILE, String(child.pid))
  }

  const healthy = await waitForHealth(port, caCertPath)
  if (healthy) {
    console.log(
      `[restart:bridge] Bridge restarted successfully on https://localhost:${port} (dataDir=${dataDir})`
    )
    return
  }

  throw new Error(
    `Bridge restart did not pass health check on port ${port}. ` +
      `Timed out after ${STARTUP_HEALTH_TIMEOUT_MS}ms. ` +
      `Check ${LOG_FILE} or run "Agent Vibes: Restart Server" in Cursor.`
  )
}

main().catch((error) => {
  console.error(
    `[restart:bridge] Restart failed: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exit(1)
})
