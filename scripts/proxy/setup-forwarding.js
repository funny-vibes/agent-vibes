#!/usr/bin/env node
/**
 * Cursor API5 Agent → localhost:2026 forwarding (cross-platform)
 *
 * How it works:
 *   1. /etc/hosts (or equivalent) resolves agent domains to 127.0.0.2
 *   2. A platform-specific local forwarding backend redirects
 *      127.0.0.2:443 → 127.0.0.1:2026
 *
 * Backends:
 *   macOS  — lo0 alias + local TCP relay
 *   Linux  — iptables + ip addr
 *   Windows — netsh interface portproxy + netsh interface ip
 *
 * Usage:
 *   node setup-forwarding.js on       Enable forwarding (requires root/admin)
 *   node setup-forwarding.js off      Disable forwarding (requires root/admin)
 *   node setup-forwarding.js status   Show status
 *   node setup-forwarding.js hosts    Print /etc/hosts entries
 *
 * Options:
 *   --port=XXXX   Bridge port to forward to (default: 2026)
 *   --json        Print structured JSON for `status`
 */

const { execSync, spawnSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const platform = require("../lib/platform")

const CLI_ARGS = process.argv.slice(2)
const SUBCOMMANDS = new Set([
  "on",
  "enable",
  "off",
  "disable",
  "status",
  "hosts",
])
const LOOPBACK_IP = "127.0.0.2"
const FROM_PORT = 443
const subCmd = CLI_ARGS.find((arg) => SUBCOMMANDS.has(arg)) || "status"
const OUTPUT_JSON = CLI_ARGS.includes("--json")
// Accept --port=XXXX from CLI; fall back to 2026
const TO_PORT = (() => {
  for (const arg of CLI_ARGS) {
    const match = /^--port=(\d+)$/.exec(arg)
    if (match) return parseInt(match[1])
  }
  return 2026
})()

// Cursor agent domains to redirect
const HOST_DOMAINS = [
  // Pro/Business member endpoints
  "api5.cursor.sh",
  "api5geo.cursor.sh",
  "api5lat.cursor.sh",
  // Non-member (free/hobby) endpoints
  "api2.cursor.sh",
  "api2geo.cursor.sh",
  "api2direct.cursor.sh",
]

// ANSI colors
const RED = "\x1b[0;31m"
const GREEN = "\x1b[0;32m"
const YELLOW = "\x1b[1;33m"
const CYAN = "\x1b[0;36m"
const NC = "\x1b[0m"

// Entries to add to macOS proxy bypass list so Cursor domains bypass
// system proxy (Clash/V2Ray) and honor /etc/hosts → 127.0.0.2 instead.
// We add each HOST_DOMAIN + its *.subdomain wildcard + the loopback alias.
const PROXY_BYPASS_ENTRIES = [
  LOOPBACK_IP,
  ...HOST_DOMAINS.flatMap((d) => [d, `*.${d}`]),
]

const HOSTS_BEGIN = "# BEGIN Cursor proxy forwarding"
const HOSTS_END = "# END Cursor proxy forwarding"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, ignoreError = false) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim()
  } catch (e) {
    if (!ignoreError) throw e
    return ""
  }
}

function shellEscape(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function readHostsContent() {
  try {
    return fs.readFileSync(getHostsPath(), "utf-8")
  } catch {
    return ""
  }
}

function hasHostEntries() {
  return readHostsContent().includes(HOSTS_BEGIN)
}

function parseMacProxyConfig() {
  if (platform.PLATFORM !== "darwin") return null

  const raw = run("scutil --proxy", true)
  if (!raw) return null

  const enabled =
    /\bHTTPEnable\s*:\s*1\b/.test(raw) ||
    /\bHTTPSEnable\s*:\s*1\b/.test(raw) ||
    /\bSOCKSEnable\s*:\s*1\b/.test(raw)

  const exceptions = Array.from(
    raw.matchAll(/^\s+\d+\s+:\s+(.+)$/gm),
    (match) => match[1].trim()
  )

  const socksEnabled = /\bSOCKSEnable\s*:\s*1\b/.test(raw)

  return {
    socksEnabled,
    enabled,
    exceptions,
    raw,
  }
}

function getHostsPath() {
  return platform.PLATFORM === "win32"
    ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
    : "/etc/hosts"
}

function getHostEntries() {
  const lines = []
  for (const domain of HOST_DOMAINS) {
    lines.push(`${LOOPBACK_IP}   ${domain}`)
    lines.push(`${LOOPBACK_IP}   agent.${domain}`)
    lines.push(`${LOOPBACK_IP}   agentn.${domain}`)
  }
  return lines
}

function addHostsEntries() {
  const hostsPath = getHostsPath()
  let content = fs.readFileSync(hostsPath, "utf-8")

  if (content.includes(HOSTS_BEGIN)) {
    removeHostsEntries()
    content = fs.readFileSync(hostsPath, "utf-8")
  }

  const entries = getHostEntries()
  const block = `\n${HOSTS_BEGIN}\n${entries.join("\n")}\n${HOSTS_END}\n`
  fs.writeFileSync(hostsPath, content.trimEnd() + block)
  console.log(
    `${GREEN}\u2713${NC} Updated ${hostsPath} (${entries.length} entries)`
  )
}

function removeHostsEntries() {
  const hostsPath = getHostsPath()
  const content = fs.readFileSync(hostsPath, "utf-8")

  if (!content.includes(HOSTS_BEGIN)) {
    console.log(`${YELLOW}\u2298${NC} No managed entries found in ${hostsPath}`)
    return
  }

  const cleaned = content.replace(
    new RegExp(
      `\\n?${HOSTS_BEGIN.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}[\\s\\S]*?${HOSTS_END.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\n?`
    ),
    "\n"
  )
  fs.writeFileSync(hostsPath, cleaned)
  console.log(`${GREEN}\u2713${NC} Removed managed entries from ${hostsPath}`)
}

// ---------------------------------------------------------------------------
// Cross-platform proxy bypass management
// ---------------------------------------------------------------------------

// ── macOS: networksetup ──

function getActiveNetworkServices() {
  const output = run("networksetup -listallnetworkservices", true)
  if (!output) return []
  return output
    .split("\n")
    .filter(
      (line) =>
        line.trim() && !line.startsWith("An asterisk") && !line.startsWith("*")
    )
}

function parseMacBypassDomains(raw) {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (line) =>
        line &&
        !/^There (?:aren't|are not) any bypass domains set on .+\.$/.test(line)
    )
}

function macAddBypass() {
  const services = getActiveNetworkServices()
  for (const svc of services) {
    const current = run(`networksetup -getproxybypassdomains "${svc}"`, true)
    const existing = parseMacBypassDomains(current)
    const toAdd = PROXY_BYPASS_ENTRIES.filter((e) => !existing.includes(e))
    if (toAdd.length === 0) {
      console.log(
        `${YELLOW}\u2298${NC} Proxy bypass already configured for ${svc}`
      )
      continue
    }
    const merged = [...existing, ...toAdd]
    run(
      `networksetup -setproxybypassdomains "${svc}" ${merged.map((e) => `"${e}"`).join(" ")}`
    )
    console.log(
      `${GREEN}\u2713${NC} Added ${toAdd.length} bypass entries to ${svc}`
    )
  }
}

function macRemoveBypass() {
  const services = getActiveNetworkServices()
  for (const svc of services) {
    const current = run(`networksetup -getproxybypassdomains "${svc}"`, true)
    const existing = parseMacBypassDomains(current)
    const bypassSet = new Set(PROXY_BYPASS_ENTRIES)
    const cleaned = existing.filter((e) => !bypassSet.has(e))
    if (cleaned.length === existing.length) {
      console.log(
        `${YELLOW}\u2298${NC} No managed bypass entries found in ${svc}`
      )
      continue
    }
    if (cleaned.length === 0) {
      run(`networksetup -setproxybypassdomains "${svc}" "Empty"`)
    } else {
      run(
        `networksetup -setproxybypassdomains "${svc}" ${cleaned.map((e) => `"${e}"`).join(" ")}`
      )
    }
    console.log(
      `${GREEN}\u2713${NC} Removed ${existing.length - cleaned.length} bypass entries from ${svc}`
    )
  }
}

function macGetBypassExceptions() {
  const svc = getActiveNetworkServices()[0]
  if (!svc) return []
  return parseMacBypassDomains(
    run(`networksetup -getproxybypassdomains "${svc}"`, true)
  )
}

// ── Windows: registry ProxyOverride ──

const WIN_REG_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"

function winGetBypassList() {
  const raw = run(`reg query "${WIN_REG_KEY}" /v ProxyOverride`, true)
  const match = raw.match(/ProxyOverride\s+REG_SZ\s+(.+)/)
  if (!match) return []
  return match[1]
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean)
}

function winAddBypass() {
  const existing = winGetBypassList()
  const toAdd = PROXY_BYPASS_ENTRIES.filter((e) => !existing.includes(e))
  if (toAdd.length === 0) {
    console.log(
      `${YELLOW}\u2298${NC} Proxy bypass already configured in registry`
    )
    return
  }
  const merged = [...existing, ...toAdd].join(";")
  run(`reg add "${WIN_REG_KEY}" /v ProxyOverride /t REG_SZ /d "${merged}" /f`)
  console.log(
    `${GREEN}\u2713${NC} Added ${toAdd.length} bypass entries to registry`
  )
}

function winRemoveBypass() {
  const existing = winGetBypassList()
  const bypassSet = new Set(PROXY_BYPASS_ENTRIES)
  const cleaned = existing.filter((e) => !bypassSet.has(e))
  if (cleaned.length === existing.length) {
    console.log(
      `${YELLOW}\u2298${NC} No managed bypass entries found in registry`
    )
    return
  }
  if (cleaned.length === 0) {
    run(`reg delete "${WIN_REG_KEY}" /v ProxyOverride /f`, true)
  } else {
    run(
      `reg add "${WIN_REG_KEY}" /v ProxyOverride /t REG_SZ /d "${cleaned.join(";")}" /f`
    )
  }
  console.log(
    `${GREEN}\u2713${NC} Removed ${existing.length - cleaned.length} bypass entries from registry`
  )
}

// ── Linux: GNOME gsettings (best-effort) ──

function linuxHasGsettings() {
  return !!run("which gsettings", true)
}

function linuxResolveSessionUser() {
  const candidates = [
    process.env.SUDO_USER,
    process.env.SUDO_UID
      ? run(`id -nu ${shellEscape(process.env.SUDO_UID)}`, true)
      : "",
    run("logname", true),
  ]
  const seen = new Set()

  for (const rawCandidate of candidates) {
    const candidate = (rawCandidate || "").trim()
    if (!candidate || candidate === "root" || seen.has(candidate)) continue
    seen.add(candidate)

    const uid = run(`id -u ${shellEscape(candidate)}`, true)
    if (!uid) continue

    return {
      user: candidate,
      uid,
      runtimeDir: `/run/user/${uid}`,
      dbusAddress: `unix:path=/run/user/${uid}/bus`,
    }
  }

  return null
}

function linuxRunGsettings(args, ignoreError = false) {
  if (!linuxHasGsettings()) return ""
  if (!platform.isElevated()) return run(`gsettings ${args}`, ignoreError)

  // Elevated forwarding runs under sudo/root, but GNOME proxy settings live in
  // the desktop user's dconf session.
  const sessionUser = linuxResolveSessionUser()
  if (!sessionUser) return run(`gsettings ${args}`, ignoreError)

  return run(
    [
      "sudo",
      "-H",
      "-u",
      shellEscape(sessionUser.user),
      "env",
      `XDG_RUNTIME_DIR=${shellEscape(sessionUser.runtimeDir)}`,
      `DBUS_SESSION_BUS_ADDRESS=${shellEscape(sessionUser.dbusAddress)}`,
      `gsettings ${args}`,
    ].join(" "),
    ignoreError
  )
}

function linuxGetBypassList() {
  if (!linuxHasGsettings()) return null
  const raw = linuxRunGsettings("get org.gnome.system.proxy ignore-hosts", true)
  if (!raw || raw === "@as []") return []
  // Format: ['host1', 'host2']
  const match = raw.match(/\[([^\]]*)\]/)
  if (!match) return []
  return match[1]
    .split(",")
    .map((e) => e.trim().replace(/^'|'$/g, ""))
    .filter(Boolean)
}

function linuxAddBypass() {
  if (!linuxHasGsettings()) {
    console.log(
      `${YELLOW}\u2298${NC} gsettings not found, set NO_PROXY manually for non-GNOME desktops`
    )
    return
  }
  const existing = linuxGetBypassList() || []
  const toAdd = PROXY_BYPASS_ENTRIES.filter((e) => !existing.includes(e))
  if (toAdd.length === 0) {
    console.log(
      `${YELLOW}\u2298${NC} Proxy bypass already configured in gsettings`
    )
    return
  }
  const merged = [...existing, ...toAdd]
  const value = "[" + merged.map((e) => `'${e}'`).join(", ") + "]"
  linuxRunGsettings(`set org.gnome.system.proxy ignore-hosts "${value}"`)
  console.log(
    `${GREEN}\u2713${NC} Added ${toAdd.length} bypass entries to gsettings`
  )
}

function linuxRemoveBypass() {
  if (!linuxHasGsettings()) return
  const existing = linuxGetBypassList() || []
  const bypassSet = new Set(PROXY_BYPASS_ENTRIES)
  const cleaned = existing.filter((e) => !bypassSet.has(e))
  if (cleaned.length === existing.length) {
    console.log(
      `${YELLOW}\u2298${NC} No managed bypass entries found in gsettings`
    )
    return
  }
  const value =
    cleaned.length === 0
      ? "@as []"
      : "[" + cleaned.map((e) => `'${e}'`).join(", ") + "]"
  linuxRunGsettings(`set org.gnome.system.proxy ignore-hosts "${value}"`)
  console.log(
    `${GREEN}\u2713${NC} Removed ${existing.length - cleaned.length} bypass entries from gsettings`
  )
}

// ── Cross-platform dispatchers ──

function addProxyBypass() {
  if (platform.PLATFORM === "darwin") macAddBypass()
  else if (platform.PLATFORM === "win32") winAddBypass()
  else if (platform.PLATFORM === "linux") linuxAddBypass()
}

function removeProxyBypass() {
  if (platform.PLATFORM === "darwin") macRemoveBypass()
  else if (platform.PLATFORM === "win32") winRemoveBypass()
  else if (platform.PLATFORM === "linux") linuxRemoveBypass()
}

function checkElevated() {
  if (!platform.isElevated()) {
    console.error(
      `${RED}Error: ${platform.PLATFORM === "win32" ? "Administrator" : "sudo/root"} required${NC}`
    )
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Print /etc/hosts entries (all platforms)
// ---------------------------------------------------------------------------

function printHosts() {
  const hostsFile =
    platform.PLATFORM === "win32"
      ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
      : "/etc/hosts"

  console.log(`${CYAN}# ── Add the following to ${hostsFile} ──${NC}`)
  console.log("")
  for (const domain of HOST_DOMAINS) {
    console.log(`${LOOPBACK_IP}   ${domain}`)
    console.log(`${LOOPBACK_IP}   agent.${domain}`)
    console.log(`${LOOPBACK_IP}   agentn.${domain}`)
  }
  console.log("")

  if (platform.PLATFORM === "win32") {
    console.log(
      `${YELLOW}Tip: Run Notepad as Administrator to edit ${hostsFile}${NC}`
    )
  } else {
    console.log(
      `${YELLOW}Tip: Run 'sudo vi ${hostsFile}' to add these entries${NC}`
    )
  }
}

// ---------------------------------------------------------------------------
// macOS backend (TCP relay — replaces pf rdr to avoid lo0 interference)
// ---------------------------------------------------------------------------

const path = require("path")
const { spawn } = require("child_process")

const RELAY_SCRIPT = path.join(__dirname, "tcp-relay.js")
// /tmp is stable across sudo/non-sudo on Unix; Windows uses per-user temp
const PID_FILE =
  platform.PLATFORM === "win32"
    ? path.join(os.tmpdir(), "cursor-proxy-relay.pid")
    : "/tmp/cursor-proxy-relay.pid"

function getRelayPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim())
    if (isNaN(pid)) return null
    try {
      process.kill(pid, 0)
      return pid
    } catch (e) {
      // EPERM = process exists but owned by another user (root)
      if (e.code === "EPERM") return pid
      return null // ESRCH = no such process
    }
  } catch {
    return null
  }
}

function pfEnable() {
  checkElevated()

  // 1. Add loopback alias
  const lo0Info = run("ifconfig lo0", true)
  if (!lo0Info.includes(LOOPBACK_IP)) {
    run(`ifconfig lo0 alias ${LOOPBACK_IP}`)
    console.log(`${GREEN}✓${NC} Added lo0 alias: ${LOOPBACK_IP}`)
  } else {
    console.log(`${YELLOW}⊘${NC} lo0 alias already exists: ${LOOPBACK_IP}`)
  }

  // 2. Start TCP relay (replaces pf rdr — avoids macOS 26 lo0 TCP breakage)
  const existingPid = getRelayPid()
  if (existingPid) {
    try {
      process.kill(existingPid)
    } catch {}
  }

  const child = spawn(
    process.execPath,
    [
      RELAY_SCRIPT,
      LOOPBACK_IP,
      String(FROM_PORT),
      "127.0.0.1",
      String(TO_PORT),
      PID_FILE,
    ],
    {
      detached: true,
      stdio: "ignore",
    }
  )
  child.unref()

  // Wait briefly for relay to start and write PID
  const startTime = Date.now()
  while (Date.now() - startTime < 1000) {
    if (getRelayPid()) break
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},100)"], {
      stdio: "ignore",
    })
  }

  if (getRelayPid()) {
    console.log(
      `${GREEN}✓${NC} TCP relay started: ${LOOPBACK_IP}:${FROM_PORT} → 127.0.0.1:${TO_PORT}`
    )
  } else {
    console.log(
      `${RED}✗${NC} TCP relay failed to start (check port ${FROM_PORT} availability)`
    )
  }

  // 3. Update /etc/hosts
  addHostsEntries()

  // 4. Add proxy bypass entries (so system proxy doesn't intercept cursor domains)
  addProxyBypass()

  console.log("")
  console.log(`${GREEN}Forwarding enabled!${NC}`)
}

function pfDisable() {
  checkElevated()

  // 1. Stop TCP relay
  const pid = getRelayPid()
  if (pid) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(PID_FILE)
    } catch {
      // ignore
    }
    console.log(`${GREEN}✓${NC} Stopped TCP relay (pid ${pid})`)
  } else {
    console.log(`${YELLOW}⊘${NC} TCP relay not running`)
  }

  // 2. Clean up any leftover pf config from previous versions
  const pfConf = fs.readFileSync("/etc/pf.conf", "utf-8")
  if (pfConf.includes("cursor.proxy")) {
    const cleaned = pfConf
      .split("\n")
      .filter((line) => !line.includes("cursor.proxy"))
      .join("\n")
    fs.writeFileSync("/etc/pf.conf", cleaned)
    run("pfctl -f /etc/pf.conf", true)
    console.log(`${GREEN}✓${NC} Cleaned up legacy pf config`)
  }

  // 3. Remove loopback alias
  const lo0Info = run("ifconfig lo0", true)
  if (lo0Info.includes(LOOPBACK_IP)) {
    run(`ifconfig lo0 -alias ${LOOPBACK_IP}`)
    console.log(`${GREEN}✓${NC} Removed lo0 alias: ${LOOPBACK_IP}`)
  }

  // 4. Clean /etc/hosts
  removeHostsEntries()

  // 5. Remove proxy bypass entries
  removeProxyBypass()

  console.log("")
  console.log(`${GREEN}Forwarding disabled!${NC}`)
}

function pfStatus() {
  console.log(`${CYAN}═══ Cursor API5 Forwarding Status ═══${NC}`)
  console.log("")

  // loopback alias
  process.stdout.write(`  lo0 alias (${LOOPBACK_IP}): `)
  const lo0Info = run("ifconfig lo0", true)
  if (lo0Info.includes(LOOPBACK_IP)) {
    console.log(`${GREEN}✓ configured${NC}`)
  } else {
    console.log(`${RED}✗ not configured${NC}`)
  }

  // TCP relay status
  process.stdout.write("  TCP relay: ")
  const pid = getRelayPid()
  if (pid) {
    console.log(`${GREEN}✓ running (pid ${pid})${NC}`)
  } else {
    console.log(`${RED}✗ not running${NC}`)
  }

  macBypassStatus()
  proxyConnectivityCheck()
}

// ---------------------------------------------------------------------------
// Linux backend (iptables)
// ---------------------------------------------------------------------------

function iptablesEnable() {
  checkElevated()

  // 1. Add loopback alias
  const addrInfo = run("ip addr show lo", true)
  if (!addrInfo.includes(`${LOOPBACK_IP}/`)) {
    run(`ip addr add ${LOOPBACK_IP}/32 dev lo`)
    console.log(`${GREEN}✓${NC} Added loopback alias: ${LOOPBACK_IP}`)
  } else {
    console.log(`${YELLOW}⊘${NC} Loopback alias already exists: ${LOOPBACK_IP}`)
  }

  // 2. Add iptables NAT rule
  const existing = run(
    `iptables -t nat -L OUTPUT -n 2>/dev/null | grep "${LOOPBACK_IP}"`,
    true
  )
  if (!existing) {
    run(
      `iptables -t nat -A OUTPUT -p tcp -d ${LOOPBACK_IP} --dport ${FROM_PORT} -j DNAT --to-destination 127.0.0.1:${TO_PORT}`
    )
    console.log(
      `${GREEN}✓${NC} iptables rule added: ${LOOPBACK_IP}:${FROM_PORT} → 127.0.0.1:${TO_PORT}`
    )
  } else {
    console.log(`${YELLOW}⊘${NC} iptables rule already exists`)
  }

  // 3. Update /etc/hosts
  addHostsEntries()

  // 4. Add proxy bypass entries
  addProxyBypass()

  console.log("")
  console.log(`${GREEN}Forwarding enabled!${NC}`)
}

function iptablesDisable() {
  checkElevated()

  // 1. Remove iptables NAT rule
  run(
    `iptables -t nat -D OUTPUT -p tcp -d ${LOOPBACK_IP} --dport ${FROM_PORT} -j DNAT --to-destination 127.0.0.1:${TO_PORT}`,
    true
  )
  console.log(`${GREEN}✓${NC} Removed iptables NAT rule`)

  // 2. Remove loopback alias
  run(`ip addr del ${LOOPBACK_IP}/32 dev lo`, true)
  console.log(`${GREEN}✓${NC} Removed loopback alias: ${LOOPBACK_IP}`)

  // 3. Clean /etc/hosts
  removeHostsEntries()

  // 4. Remove proxy bypass entries
  removeProxyBypass()

  console.log("")
  console.log(`${GREEN}Forwarding disabled!${NC}`)
}

function iptablesStatus() {
  console.log(`${CYAN}═══ Cursor API5 Forwarding Status ═══${NC}`)
  console.log("")

  // loopback alias
  process.stdout.write(`  Loopback alias (${LOOPBACK_IP}): `)
  const addrInfo = run("ip addr show lo", true)
  if (addrInfo.includes(`${LOOPBACK_IP}/`)) {
    console.log(`${GREEN}✓ configured${NC}`)
  } else {
    console.log(`${RED}✗ not configured${NC}`)
  }

  // iptables rule
  process.stdout.write("  iptables NAT rule: ")
  const natRules = run("iptables -t nat -L OUTPUT -n 2>/dev/null", true)
  if (natRules.includes(LOOPBACK_IP)) {
    console.log(`${GREEN}✓ loaded${NC}`)
  } else {
    console.log(`${RED}✗ not loaded${NC}`)
  }

  linuxBypassStatus()
  proxyConnectivityCheck()
}

// ---------------------------------------------------------------------------
// Windows backend (netsh)
// ---------------------------------------------------------------------------

function netshEnable() {
  checkElevated()

  // 1. Add loopback address (Windows uses netsh)
  const ifaceInfo = run("netsh interface ip show address loopback", true)
  if (!ifaceInfo.includes(LOOPBACK_IP)) {
    run(
      `netsh interface ip add address "Loopback" ${LOOPBACK_IP} 255.255.255.255`,
      true
    )
    console.log(`${GREEN}✓${NC} Added loopback alias: ${LOOPBACK_IP}`)
  } else {
    console.log(`${YELLOW}⊘${NC} Loopback alias already exists: ${LOOPBACK_IP}`)
  }

  // 2. Add port proxy rule
  run(
    `netsh interface portproxy add v4tov4 listenaddress=${LOOPBACK_IP} listenport=${FROM_PORT} connectaddress=127.0.0.1 connectport=${TO_PORT}`
  )
  console.log(
    `${GREEN}✓${NC} Port proxy rule added: ${LOOPBACK_IP}:${FROM_PORT} → 127.0.0.1:${TO_PORT}`
  )

  // 3. Update hosts file
  addHostsEntries()

  // 4. Add proxy bypass entries
  addProxyBypass()

  console.log("")
  console.log(`${GREEN}Forwarding enabled!${NC}`)
}

function netshDisable() {
  checkElevated()

  // 1. Remove port proxy rule
  run(
    `netsh interface portproxy delete v4tov4 listenaddress=${LOOPBACK_IP} listenport=${FROM_PORT}`,
    true
  )
  console.log(`${GREEN}✓${NC} Removed port proxy rule`)

  // 2. Remove loopback address
  run(`netsh interface ip delete address "Loopback" ${LOOPBACK_IP}`, true)
  console.log(`${GREEN}✓${NC} Removed loopback alias: ${LOOPBACK_IP}`)

  // 3. Clean hosts file
  removeHostsEntries()

  // 4. Remove proxy bypass entries
  removeProxyBypass()

  console.log("")
  console.log(`${GREEN}Forwarding disabled!${NC}`)
}

function netshStatus() {
  console.log(`${CYAN}═══ Cursor API5 Forwarding Status ═══${NC}`)
  console.log("")

  // port proxy rules
  process.stdout.write("  Port proxy rule: ")
  const proxyRules = run("netsh interface portproxy show v4tov4", true)
  if (proxyRules.includes(LOOPBACK_IP)) {
    console.log(`${GREEN}✓ configured${NC}`)
  } else {
    console.log(`${RED}✗ not configured${NC}`)
  }

  winBypassStatus()
  proxyConnectivityCheck()
}

// ---------------------------------------------------------------------------
// Shared connectivity check
// ---------------------------------------------------------------------------

function h2HealthCheck(host, port) {
  const http2 = require("http2")

  return new Promise((resolve) => {
    let session
    const timer = setTimeout(() => {
      try {
        session.destroy()
      } catch {
        /* cleanup */
      }
      resolve(false)
    }, 2000)

    try {
      session = http2.connect(`https://${host}:${port}`, {
        rejectUnauthorized: false,
      })

      session.on("error", () => {
        clearTimeout(timer)
        try {
          session.destroy()
        } catch {
          /* cleanup */
        }
        resolve(false)
      })

      const req = session.request({ ":path": "/health" })
      req.on("response", (headers) => {
        clearTimeout(timer)
        const status = headers[":status"]
        try {
          req.close()
          session.close()
        } catch {
          /* cleanup */
        }
        resolve(status >= 200 && status < 500)
      })
      req.on("error", () => {
        clearTimeout(timer)
        try {
          session.destroy()
        } catch {
          /* cleanup */
        }
        resolve(false)
      })
      req.end()
    } catch {
      /* connect error */
    }
  })
}

async function proxyConnectivityCheck() {
  // Local proxy
  process.stdout.write(`  Local proxy (localhost:${TO_PORT}): `)
  const localOk = await h2HealthCheck("localhost", TO_PORT)
  if (localOk) {
    console.log(`${GREEN}✓ reachable${NC}`)
  } else {
    console.log(`${RED}✗ unreachable${NC}`)
  }

  // End-to-end
  process.stdout.write(
    `  End-to-end (${LOOPBACK_IP}:${FROM_PORT} → :${TO_PORT}): `
  )
  const e2eOk = await h2HealthCheck(LOOPBACK_IP, FROM_PORT)
  if (e2eOk) {
    console.log(`${GREEN}✓ forwarding OK${NC}`)
  } else {
    console.log(`${RED}✗ forwarding failed${NC}`)
  }

  console.log("")
}

// ---------------------------------------------------------------------------
// Per-platform bypass status checks (called from *Status functions)
// ---------------------------------------------------------------------------

function macBypassStatus() {
  const macProxy = parseMacProxyConfig()
  if (!macProxy?.enabled) return

  const exceptions = macGetBypassExceptions()
  const missing = PROXY_BYPASS_ENTRIES.filter((e) => !exceptions.includes(e))

  process.stdout.write("  macOS proxy bypass: ")
  if (missing.length === 0) {
    console.log(
      `${GREEN}✓ all ${PROXY_BYPASS_ENTRIES.length} entries present${NC}`
    )
  } else {
    console.log(`${YELLOW}⚠ ${missing.length} bypass entries missing${NC}`)
    console.log(
      `    Run 'agent-vibes forward on' to fix, or Cursor traffic will go through the system proxy and fail TLS.`
    )
  }
}

function winBypassStatus() {
  const existing = winGetBypassList()
  if (
    existing.length === 0 &&
    !run(`reg query "${WIN_REG_KEY}" /v ProxyEnable`, true).includes("0x1")
  ) {
    return // No system proxy enabled
  }

  const missing = PROXY_BYPASS_ENTRIES.filter((e) => !existing.includes(e))

  process.stdout.write("  Windows proxy bypass: ")
  if (missing.length === 0) {
    console.log(
      `${GREEN}✓ all ${PROXY_BYPASS_ENTRIES.length} entries present${NC}`
    )
  } else {
    console.log(`${YELLOW}⚠ ${missing.length} bypass entries missing${NC}`)
    console.log(
      `    Run 'agent-vibes forward on' to fix, or Cursor traffic will go through the system proxy and fail TLS.`
    )
  }
}

function linuxBypassStatus() {
  if (!linuxHasGsettings()) return

  const mode = linuxRunGsettings("get org.gnome.system.proxy mode", true)
  if (mode !== "'manual'") return // No manual proxy configured

  const existing = linuxGetBypassList() || []
  const missing = PROXY_BYPASS_ENTRIES.filter((e) => !existing.includes(e))

  process.stdout.write("  GNOME proxy bypass: ")
  if (missing.length === 0) {
    console.log(
      `${GREEN}✓ all ${PROXY_BYPASS_ENTRIES.length} entries present${NC}`
    )
  } else {
    console.log(`${YELLOW}⚠ ${missing.length} bypass entries missing${NC}`)
    console.log(
      `    Run 'agent-vibes forward on' to fix, or Cursor traffic will go through the system proxy and fail TLS.`
    )
  }
}

function getPlatformStatusPayload() {
  const backend = platform.forwardingBackend()
  const payload = {
    ok: false,
    platform: platform.PLATFORM,
    backend,
    backendStatusLabel: "",
    port: TO_PORT,
    loopbackIp: LOOPBACK_IP,
    listenPort: FROM_PORT,
    checks: {
      hosts: hasHostEntries(),
      loopbackAlias: null,
      backendConfigured: false,
      proxyBypass: null,
      localProxyReachable: false,
      endToEndReachable: false,
    },
  }

  if (backend === "pf") {
    const lo0Info = run("ifconfig lo0", true)
    const relayPid = getRelayPid()
    const bypass = parseMacProxyConfig()
    const missingBypass = bypass?.enabled
      ? PROXY_BYPASS_ENTRIES.filter(
          (entry) => !bypass.exceptions.includes(entry)
        )
      : []

    payload.backendStatusLabel = "TCP relay process"
    payload.checks.loopbackAlias = lo0Info.includes(LOOPBACK_IP)
    payload.checks.backendConfigured = Boolean(relayPid)
    payload.checks.proxyBypass = bypass?.enabled
      ? missingBypass.length === 0
      : null
    payload.relayPid = relayPid
    payload.ok =
      payload.checks.hosts &&
      payload.checks.loopbackAlias &&
      payload.checks.backendConfigured
    return payload
  }

  if (backend === "iptables") {
    const addrInfo = run("ip addr show lo", true)
    const natRules = run("iptables -t nat -L OUTPUT -n 2>/dev/null", true)
    const bypassList = linuxGetBypassList()
    const proxyMode = linuxHasGsettings()
      ? linuxRunGsettings("get org.gnome.system.proxy mode", true)
      : ""
    const bypassActive = linuxHasGsettings() && proxyMode === "'manual'"
    const missingBypass = bypassActive
      ? PROXY_BYPASS_ENTRIES.filter(
          (entry) => !(bypassList || []).includes(entry)
        )
      : []

    payload.backendStatusLabel = "iptables NAT rule"
    payload.checks.loopbackAlias = addrInfo.includes(`${LOOPBACK_IP}/`)
    payload.checks.backendConfigured = natRules.includes(LOOPBACK_IP)
    payload.checks.proxyBypass = bypassActive
      ? missingBypass.length === 0
      : null
    payload.ok =
      payload.checks.hosts &&
      payload.checks.loopbackAlias &&
      payload.checks.backendConfigured
    return payload
  }

  const proxyRules = run("netsh interface portproxy show v4tov4", true)
  const bypassList = winGetBypassList()
  const proxyEnabled = run(
    `reg query "${WIN_REG_KEY}" /v ProxyEnable`,
    true
  ).includes("0x1")
  const missingBypass = proxyEnabled
    ? PROXY_BYPASS_ENTRIES.filter((entry) => !bypassList.includes(entry))
    : []

  payload.backendStatusLabel = "Port proxy rule"
  payload.checks.backendConfigured = proxyRules.includes(LOOPBACK_IP)
  payload.checks.proxyBypass = proxyEnabled ? missingBypass.length === 0 : null
  payload.ok = payload.checks.hosts && payload.checks.backendConfigured
  return payload
}

async function getStatusPayload() {
  const payload = getPlatformStatusPayload()
  payload.checks.localProxyReachable = await h2HealthCheck("localhost", TO_PORT)
  payload.checks.endToEndReachable = await h2HealthCheck(LOOPBACK_IP, FROM_PORT)
  return payload
}

async function printStatusJson() {
  const payload = await getStatusPayload()
  console.log(JSON.stringify(payload, null, 2))
}

// ---------------------------------------------------------------------------
// Router — dispatch to the correct backend
// ---------------------------------------------------------------------------

const backend = platform.forwardingBackend()

switch (subCmd) {
  case "on":
  case "enable":
    if (backend === "pf") pfEnable()
    else if (backend === "iptables") iptablesEnable()
    else if (backend === "netsh") netshEnable()
    else {
      console.error(`Unsupported platform: ${platform.PLATFORM}`)
      process.exit(1)
    }
    break

  case "off":
  case "disable":
    if (backend === "pf") pfDisable()
    else if (backend === "iptables") iptablesDisable()
    else if (backend === "netsh") netshDisable()
    else {
      console.error(`Unsupported platform: ${platform.PLATFORM}`)
      process.exit(1)
    }
    break

  case "status":
    if (OUTPUT_JSON) {
      printStatusJson().catch((error) => {
        console.error(
          JSON.stringify(
            {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              platform: platform.PLATFORM,
              backend,
            },
            null,
            2
          )
        )
        process.exit(1)
      })
      break
    }
    if (backend === "pf") pfStatus()
    else if (backend === "iptables") iptablesStatus()
    else if (backend === "netsh") netshStatus()
    else {
      console.error(`Unsupported platform: ${platform.PLATFORM}`)
      process.exit(1)
    }
    break

  case "hosts":
    printHosts()
    break

  default:
    console.log("Usage: node setup-forwarding.js {on|off|status|hosts}")
    console.log("")
    console.log("  on      Enable port forwarding (requires sudo/admin)")
    console.log("  off     Disable port forwarding (requires sudo/admin)")
    console.log("  status  Show current status")
    console.log("  hosts   Print hosts file entries")
    process.exit(1)
}
