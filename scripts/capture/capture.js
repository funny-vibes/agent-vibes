#!/usr/bin/env node
/**
 * Antigravity Traffic Capture
 *
 * Captures official Antigravity IDE -> Cloud Code API traffic by inserting
 * mitmdump into Clash Verge's proxy chain via the profile Script enhancement.
 *
 * Flow: Antigravity IDE -> TUN -> Clash -> capture-mitm(:10444) -> Clash(VMess) -> Cloud Code
 *
 * How it works:
 *   capture:start  - Writes a Clash Verge Script that adds capture-mitm proxy
 *                     and routing rules. Auto-reloads Clash config via API.
 *                     Then starts mitmdump.
 *   capture:stop   - Restores original Script, kills mitmdump.
 *                     Auto-reloads Clash config via API.
 */
const fs = require("node:fs")
const path = require("node:path")
const http = require("node:http")
const { spawn, spawnSync } = require("node:child_process")

const SCRIPT_DIR = __dirname
const MITM_PORT = 10444
const LOG_DIR = path.join(SCRIPT_DIR, "traffic_dumps")
const CAPTURE_SCRIPT = path.join(SCRIPT_DIR, "capture-traffic.py")
const platform = require("../lib/platform")

// Clash Verge profile paths — read dynamically from profiles.yaml
const CLASH_DIR = platform.clashConfigDir()
const PROFILES_DIR = path.join(CLASH_DIR, "profiles")
const PROFILES_YAML = path.join(CLASH_DIR, "profiles.yaml")
const SCRIPT_BACKUP = path.join(SCRIPT_DIR, ".clash-script-backup.js")
const CLASH_SOCKET_DEFAULT = "/tmp/verge/verge-mihomo.sock"

let mitmdumpBin = null

/**
 * Cross-platform shell command executor.
 * Uses bash on Unix, cmd on Windows.
 */
function runShell(cmd, ok = false) {
  const isWin = platform.PLATFORM === "win32"
  const shell = isWin ? "cmd" : "bash"
  const shellArgs = isWin ? ["/c", cmd] : ["-lc", cmd]
  const r = spawnSync(shell, shellArgs, { stdio: "inherit" })
  if (r.status !== 0 && !ok) process.exit(r.status ?? 1)
  return r
}

/**
 * Cross-platform shell command executor that captures output.
 */
function runShellCapture(cmd, ok = false) {
  const isWin = platform.PLATFORM === "win32"
  const shell = isWin ? "cmd" : "bash"
  const shellArgs = isWin ? ["/c", cmd] : ["-lc", cmd]
  const r = spawnSync(shell, shellArgs, { encoding: "utf-8", stdio: "pipe" })
  if (r.status !== 0 && !ok) process.exit(r.status ?? 1)
  return (r.stdout || "").trim()
}

function runCapture(command, args, ok = false) {
  const r = spawnSync(command, args, { encoding: "utf-8", stdio: "pipe" })
  if (r.error && !ok) {
    console.error(r.error.message)
    process.exit(1)
  }
  if ((r.status ?? 1) !== 0 && !ok) process.exit(r.status ?? 1)
  return {
    error: r.error,
    status: r.status ?? (r.error ? 1 : 0),
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  }
}

/**
 * Read the Clash external controller secret from config.yaml.
 */
function readClashSecret() {
  try {
    const configPath = path.join(CLASH_DIR, "config.yaml")
    const content = fs.readFileSync(configPath, "utf-8")
    for (const line of content.split("\n")) {
      const m = line.match(/^secret:\s*(.+)/)
      if (m) return m[1].trim()
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Resolve the Clash external controller Unix socket path from config.yaml.
 * Used on macOS/Linux. Falls back to CLASH_SOCKET_DEFAULT.
 */
function readClashSocket() {
  try {
    const configPath = path.join(CLASH_DIR, "config.yaml")
    const content = fs.readFileSync(configPath, "utf-8")
    for (const line of content.split("\n")) {
      const m = line.match(/^external-controller-unix:\s*(.+)/)
      if (m) return m[1].trim()
    }
  } catch {
    // ignore
  }
  return CLASH_SOCKET_DEFAULT
}

/**
 * Resolve the Clash external controller TCP address from config.yaml.
 * Used on Windows, or as fallback on other platforms.
 * Returns { host, port } or null.
 */
function readClashTcpController() {
  try {
    const configPath = path.join(CLASH_DIR, "config.yaml")
    const content = fs.readFileSync(configPath, "utf-8")
    for (const line of content.split("\n")) {
      const m = line.match(/^external-controller:\s*(.+)/)
      if (m) {
        const addr = m[1].trim().replace(/^['"]|['"]$/g, "")
        if (!addr) continue
        // Parse host:port (e.g., "127.0.0.1:9097" or ":9090")
        const colonIdx = addr.lastIndexOf(":")
        if (colonIdx === -1) continue
        const host = addr.slice(0, colonIdx) || "127.0.0.1"
        const port = parseInt(addr.slice(colonIdx + 1), 10)
        if (!isNaN(port)) return { host, port }
      }
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Make an HTTP request to the Clash API.
 * On macOS/Linux: prefers Unix socket, falls back to TCP.
 * On Windows: uses TCP only.
 */
function clashApiRequest(method, apiPath, body = null) {
  const secret = readClashSecret()
  const headers = { "Content-Type": "application/json" }
  if (secret) headers["Authorization"] = `Bearer ${secret}`

  return new Promise((resolve) => {
    function doRequest(opts) {
      const req = http.request(opts, (res) => {
        let data = ""
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => resolve({ statusCode: res.statusCode, data }))
      })
      req.on("error", (err) => resolve({ statusCode: 0, error: err.message }))
      if (body)
        req.write(typeof body === "string" ? body : JSON.stringify(body))
      req.end()
    }

    // Windows: TCP only
    if (platform.PLATFORM === "win32") {
      const tcp = readClashTcpController()
      if (!tcp) {
        resolve({
          statusCode: 0,
          error: "No TCP external-controller configured",
        })
        return
      }
      doRequest({
        hostname: tcp.host,
        port: tcp.port,
        path: apiPath,
        method,
        headers,
      })
      return
    }

    // macOS/Linux: try Unix socket first, fall back to TCP
    const socketPath = readClashSocket()
    const socketReq = http.request(
      { socketPath, path: apiPath, method, headers },
      (res) => {
        let data = ""
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => resolve({ statusCode: res.statusCode, data }))
      }
    )
    socketReq.on("error", () => {
      // Socket failed, try TCP fallback
      const tcp = readClashTcpController()
      if (!tcp) {
        resolve({
          statusCode: 0,
          error: "Cannot reach Clash API (no socket or TCP controller)",
        })
        return
      }
      doRequest({
        hostname: tcp.host,
        port: tcp.port,
        path: apiPath,
        method,
        headers,
      })
    })
    if (body)
      socketReq.write(typeof body === "string" ? body : JSON.stringify(body))
    socketReq.end()
  })
}

/**
 * Reload Clash config via external controller API.
 */
function reloadClash() {
  const configPath = path.join(CLASH_DIR, "config.yaml")
  return clashApiRequest("PUT", "/configs?force=true", {
    path: configPath,
  }).then((res) => {
    if (res.statusCode === 204 || res.statusCode === 200) {
      console.log("✓ Clash config reloaded via API")
    } else if (res.error) {
      console.log(`⚠ Cannot reach Clash API: ${res.error}`)
      console.log("  Please restart Clash Verge manually.")
    } else {
      console.log(
        `⚠ Clash API returned ${res.statusCode}: ${(res.data || "").trim() || "(empty)"}`
      )
      console.log("  Please restart Clash Verge manually.")
    }
  })
}

/**
 * Fetch Clash runtime rules via API.
 */
function fetchClashRules() {
  return clashApiRequest("GET", "/rules").then((res) => {
    try {
      return JSON.parse(res.data || "null")
    } catch {
      return null
    }
  })
}

function resolveMitmdump() {
  if (mitmdumpBin) return mitmdumpBin
  const r = spawnSync(
    platform.PLATFORM === "win32" ? "where" : "bash",
    platform.PLATFORM === "win32"
      ? ["mitmdump"]
      : ["-lc", "command -v mitmdump"],
    { encoding: "utf-8" }
  )
  const p = (r.stdout || "").trim().split("\n")[0]
  if (r.status === 0 && p) {
    mitmdumpBin = p
    return p
  }
  for (const b of platform.mitmdumpCandidates()) {
    if (fs.existsSync(b)) {
      mitmdumpBin = b
      return b
    }
  }
  console.error("mitmdump not found. Install mitmproxy for your platform.")
  process.exit(1)
}

function parseWindowsProcessList(raw) {
  return raw
    .split(/\r?\n\r?\n+/)
    .map((block) => {
      const fields = {}
      for (const line of block.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.includes("=")) continue
        const idx = trimmed.indexOf("=")
        fields[trimmed.slice(0, idx)] = trimmed.slice(idx + 1).trim()
      }
      const pid = parseInt(fields.ProcessId, 10)
      if (isNaN(pid)) return null
      return {
        Name: fields.Name || "unknown",
        ProcessId: pid,
      }
    })
    .filter(Boolean)
}

function queryWindowsProcesses(whereClause) {
  if (platform.PLATFORM !== "win32") return []
  const result = runCapture(
    "wmic",
    ["process", "where", whereClause, "get", "ProcessId,Name", "/format:list"],
    true
  )
  if (result.error || result.status !== 0) return []
  return parseWindowsProcessList(result.stdout)
}

function getManagedWindowsMitmdumpProcesses() {
  return queryWindowsProcesses("CommandLine like '%mitmdump%capture-traffic%'")
}

function printWindowsProcessStatus(label, processes) {
  if (processes.length === 0) {
    console.log(`  ${label}: not running`)
    return
  }

  console.log(`  ${label}:`)
  for (const proc of processes) {
    console.log(`    ${proc.Name} (pid ${proc.ProcessId})`)
  }
}

/**
 * Parse profiles.yaml to find the current profile's script file path.
 * Simple line-based parser (no YAML library needed).
 */
function findScriptFile() {
  const content = fs.readFileSync(PROFILES_YAML, "utf-8")
  const lines = content.split("\n")

  // Find current profile uid
  let currentUid = null
  for (const l of lines) {
    const m = l.match(/^current:\s*(.+)/)
    if (m) {
      currentUid = m[1].trim()
      break
    }
  }
  if (!currentUid)
    throw new Error("Cannot find current profile in profiles.yaml")

  // Find the profile's script uid
  let inCurrentProfile = false
  let scriptUid = null
  for (const l of lines) {
    if (l.match(new RegExp("uid:\\s*" + currentUid + "\\b")))
      inCurrentProfile = true
    if (inCurrentProfile) {
      const m = l.match(/script:\s*(.+)/)
      if (m) {
        scriptUid = m[1].trim()
        break
      }
    }
    // Stop if we hit another top-level item
    if (inCurrentProfile && l.startsWith("- uid:") && !l.includes(currentUid))
      break
  }
  if (!scriptUid) throw new Error("Current profile has no script enhancement")

  // Find the script file name
  let inScriptItem = false
  for (const l of lines) {
    if (l.match(new RegExp("uid:\\s*" + scriptUid + "\\b"))) inScriptItem = true
    if (inScriptItem) {
      const m = l.match(/file:\s*(.+)/)
      if (m) return path.join(PROFILES_DIR, m[1].trim())
    }
    if (inScriptItem && l.startsWith("- uid:") && !l.includes(scriptUid)) break
  }
  throw new Error("Cannot find script file for uid: " + scriptUid)
}

// The capture script to inject into Clash Verge's profile Script
const CAPTURE_MAIN = `// Antigravity Capture Script — managed by capture.js
// This script injects mitmdump into the proxy chain for traffic capture.

function main(config, profileName) {
  // Add mitmdump as HTTP proxy
  if (!config["proxies"]) config["proxies"] = [];
  config["proxies"].push({
    name: "capture-mitm",
    type: "http",
    server: "127.0.0.1",
    port: ${MITM_PORT},
  });

  // Route mitmdump's own traffic through PROXY (VMess) to avoid loop,
  // and route Cloud Code traffic through mitmdump for capture.
  if (!config["rules"]) config["rules"] = [];
  config["rules"].unshift(
    "PROCESS-NAME,mitmdump,PROXY",
    "DOMAIN-SUFFIX,googleapis.com,capture-mitm"
  );

  return config;
}
`

const CLEAN_MAIN = `// Define main function (script entry)

function main(config, profileName) {
  return config;
}
`

function isCapturActive(scriptPath) {
  try {
    return fs.readFileSync(scriptPath, "utf-8").includes("capture-mitm")
  } catch {
    return false
  }
}

/**
 * Wait for a TCP port to accept connections.
 */
function waitForPort(port, timeoutMs = 8000) {
  const net = require("node:net")
  const start = Date.now()
  return new Promise((resolve, reject) => {
    function attempt() {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`))
      }
      const sock = net.createConnection({ port, host: "127.0.0.1" }, () => {
        sock.destroy()
        resolve()
      })
      sock.on("error", () => {
        setTimeout(attempt, 200)
      })
    }
    attempt()
  })
}

/**
 * Restore Clash config (remove capture rules). Safe to call multiple times.
 */
async function restoreClash() {
  let scriptPath
  try {
    scriptPath = findScriptFile()
  } catch {
    return // Cannot find script, nothing to restore
  }
  if (fs.existsSync(SCRIPT_BACKUP)) {
    fs.copyFileSync(SCRIPT_BACKUP, scriptPath)
    fs.unlinkSync(SCRIPT_BACKUP)
    console.log("\n✓ Restored original Clash Verge script.")
  } else if (isCapturActive(scriptPath)) {
    fs.writeFileSync(scriptPath, CLEAN_MAIN)
    console.log("\n✓ Wrote clean Clash script (no backup found).")
  }
  console.log("Reloading Clash config...")
  await reloadClash()
}

async function cmdStart() {
  if (!fs.existsSync(CAPTURE_SCRIPT)) {
    console.error("No capture-traffic.py found")
    process.exit(1)
  }
  const mitmdump = resolveMitmdump()
  fs.mkdirSync(LOG_DIR, { recursive: true })

  const scriptPath = findScriptFile()
  console.log("Script file: " + scriptPath)

  // ── Step 1: Start mitmdump FIRST (before touching Clash) ──
  console.log("")
  console.log("Starting mitmdump on port " + MITM_PORT + "...")

  const mitmProc = spawn(
    mitmdump,
    [
      "--listen-port",
      String(MITM_PORT),
      "--ssl-insecure",
      "-s",
      CAPTURE_SCRIPT,
      "--set",
      "console_eventlog_verbosity=warn",
    ],
    { stdio: "inherit" }
  )

  // ── Step 2: Wait for mitmdump port to be ready ──
  try {
    await waitForPort(MITM_PORT)
    console.log("✓ mitmdump listening on port " + MITM_PORT)
  } catch (e) {
    console.error("✗ mitmdump failed to start: " + e.message)
    mitmProc.kill()
    process.exit(1)
  }

  // ── Step 3: NOW inject Clash rules (mitmdump is confirmed ready) ──
  if (isCapturActive(scriptPath)) {
    console.log("Capture script already injected.")
  } else {
    fs.copyFileSync(scriptPath, SCRIPT_BACKUP)
    console.log("Backed up original script to " + SCRIPT_BACKUP)
    fs.writeFileSync(scriptPath, CAPTURE_MAIN)
    console.log("Injected capture script into Clash Verge profile.")
  }

  console.log("Reloading Clash config...")
  await reloadClash()
  await new Promise((r) => setTimeout(r, 1000))

  console.log("")
  console.log(
    "  Flow: Antigravity IDE -> TUN -> Clash -> mitmdump(:" +
      MITM_PORT +
      ") -> Clash(VMess) -> Cloud Code"
  )
  console.log("  Logs:  " + path.join(SCRIPT_DIR, "antigravity_traffic.log"))
  console.log("  Dumps: " + LOG_DIR)
  console.log("  Press Ctrl+C to stop capture and restore Clash config.")
  console.log("")

  // ── Step 4: Auto-restore on exit (Ctrl+C, crash, kill) ──
  let cleaned = false
  async function cleanup(code) {
    if (cleaned) return
    cleaned = true
    console.log("\nStopping capture...")
    try {
      mitmProc.kill()
    } catch {}
    await restoreClash()
    process.exit(code ?? 0)
  }

  process.on("SIGINT", () => cleanup(0))
  process.on("SIGTERM", () => cleanup(0))
  mitmProc.on("exit", (code) => {
    if (!cleaned) {
      console.log("\nmitmdump exited (code " + code + "), restoring Clash...")
      cleanup(code ?? 1)
    }
  })
}

async function cmdStop() {
  // Kill mitmdump (cross-platform)
  if (platform.PLATFORM === "win32") {
    const processes = getManagedWindowsMitmdumpProcesses()
    for (const proc of processes) {
      runShell(`taskkill /F /PID ${proc.ProcessId} >nul 2>&1`, true)
    }
  } else {
    runShell('pkill -f "mitmdump.*capture-traffic" 2>/dev/null', true)
  }

  // Restore original script
  const scriptPath = findScriptFile()
  if (fs.existsSync(SCRIPT_BACKUP)) {
    fs.copyFileSync(SCRIPT_BACKUP, scriptPath)
    fs.unlinkSync(SCRIPT_BACKUP)
    console.log("Restored original Clash Verge script.")
  } else {
    // Fallback: write clean script
    if (isCapturActive(scriptPath)) {
      fs.writeFileSync(scriptPath, CLEAN_MAIN)
      console.log("Wrote clean script (no backup found).")
    } else {
      console.log("Script already clean, nothing to restore.")
    }
  }

  // Auto-reload Clash config via API
  console.log("")
  console.log("Reloading Clash config...")
  await reloadClash()
}

async function cmdStatus() {
  let scriptPath
  try {
    scriptPath = findScriptFile()
  } catch (e) {
    console.log("Error: " + e.message)
    return
  }

  const active = isCapturActive(scriptPath)
  console.log("Clash Verge script: " + (active ? "CAPTURE MODE" : "normal"))
  console.log("  File: " + scriptPath)

  // Check runtime rules via Clash API
  const rulesData = await fetchClashRules()
  if (rulesData && rulesData.rules) {
    const captureRule = rulesData.rules.find(
      (r) => r.payload && r.payload.includes("capture-mitm")
    )
    console.log(
      "Clash runtime:    " +
        (captureRule ? "CAPTURE MODE (live)" : "normal (live)")
    )
  } else {
    console.log("Clash runtime:    (cannot reach API)")
  }

  console.log("\nProcesses:")
  if (platform.PLATFORM === "win32") {
    printWindowsProcessStatus("mitmdump", getManagedWindowsMitmdumpProcesses())
    printWindowsProcessStatus(
      "clash",
      queryWindowsProcesses("Name like '%mihomo%'")
    )
  } else {
    runShell(
      "echo -n '  mitmdump: '; pgrep -fl 'mitmdump.*capture-traffic' || echo 'not running'",
      true
    )
    runShell(
      "echo -n '  clash:    '; pgrep -fl 'verge-mihomo|mihomo' | head -1 || echo 'not running'",
      true
    )
  }

  console.log("\nPorts:")
  if (platform.PLATFORM === "win32") {
    runShell(
      "echo   " +
        MITM_PORT +
        ' (mitm):  & (netstat -an | findstr ":' +
        MITM_PORT +
        '.*LISTENING" || echo -)',
      true
    )
  } else {
    runShell(
      "echo -n '  " +
        MITM_PORT +
        " (mitm):  '; lsof -nP -iTCP:" +
        MITM_PORT +
        " -sTCP:LISTEN 2>/dev/null | tail -1 || echo '-'",
      true
    )
  }
}

switch (process.argv[2]) {
  case "start":
  case "run":
    cmdStart().catch((e) => {
      console.error(e.message)
      process.exit(1)
    })
    break
  case "stop":
  case "restore":
    cmdStop().catch((e) => {
      console.error(e.message)
      process.exit(1)
    })
    break
  case "status":
  case "info":
    cmdStatus().catch((e) => {
      console.error(e.message)
      process.exit(1)
    })
    break
  default:
    console.log("Usage: sudo node capture.js [start|stop|status]")
    process.exit(1)
}
