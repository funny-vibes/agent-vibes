#!/usr/bin/env node
/**
 * Cross-platform utility module for Agent Vibes.
 *
 * Provides OS-aware path resolution for Cursor, Antigravity IDE,
 * Clash Verge, and system forwarding backends.
 */

const os = require("os")
const path = require("path")
const fs = require("fs")

const PLATFORM = process.platform // 'darwin' | 'linux' | 'win32'

function expandHomeDir(inputPath) {
  if (!inputPath || typeof inputPath !== "string") return inputPath
  if (inputPath === "~") return os.homedir()
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2))
  }
  return inputPath
}

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

// ---------------------------------------------------------------------------
// Cursor IDE paths
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to Cursor's workbench.desktop.main.js.
 * Tries multiple known locations per OS.
 */
function cursorWorkbenchPath() {
  const override = expandHomeDir(process.env.CURSOR_WORKBENCH_PATH)
  if (override) return override

  const suffix = path.join(
    "Resources",
    "app",
    "out",
    "vs",
    "workbench",
    "workbench.desktop.main.js"
  )

  const candidates = []

  if (PLATFORM === "darwin") {
    candidates.push(
      path.join("/Applications/Cursor.app/Contents", suffix),
      path.join(os.homedir(), "Applications", "Cursor.app", "Contents", suffix)
    )
  } else if (PLATFORM === "linux") {
    candidates.push(
      path.join("/usr/share/cursor", suffix),
      path.join("/opt/cursor", suffix),
      path.join(os.homedir(), ".local", "share", "cursor", suffix),
      // Snap / Flatpak / AppImage extracted
      path.join("/snap/cursor/current", suffix)
    )
  } else if (PLATFORM === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    candidates.push(
      path.join(localAppData, "Programs", "cursor", suffix),
      path.join(localAppData, "cursor", suffix)
    )
  }

  const resolved = firstExistingPath(candidates)
  if (resolved) return resolved

  // Return the first candidate as default (will error at call site if missing)
  return candidates[0] || null
}

/**
 * Returns the Cursor executable path (for launching with debug logging).
 */
function cursorBinaryPath() {
  const override = expandHomeDir(process.env.CURSOR_BINARY_PATH)
  if (override) return override

  if (PLATFORM === "darwin") {
    const candidates = [
      "/Applications/Cursor.app/Contents/MacOS/Cursor",
      path.join(
        os.homedir(),
        "Applications",
        "Cursor.app",
        "Contents",
        "MacOS",
        "Cursor"
      ),
    ]
    return firstExistingPath(candidates) || candidates[0]
  }
  if (PLATFORM === "linux") {
    // Usually in PATH as 'cursor'
    return "cursor"
  }
  if (PLATFORM === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    const candidates = [
      path.join(localAppData, "Programs", "cursor", "Cursor.exe"),
      path.join(localAppData, "cursor", "Cursor.exe"),
    ]
    return firstExistingPath(candidates) || candidates[0]
  }
  return "cursor"
}

// ---------------------------------------------------------------------------
// Antigravity IDE data directory
// ---------------------------------------------------------------------------

/**
 * Returns candidate state.vscdb paths for Antigravity IDE.
 */
function antigravityIdeStateDbCandidates() {
  const explicitStateDbPath = expandHomeDir(
    process.env.AGENT_VIBES_ANTIGRAVITY_IDE_STATE_DB_PATH
  )
  if (explicitStateDbPath) return [explicitStateDbPath]

  const explicitDataDir = expandHomeDir(
    process.env.AGENT_VIBES_ANTIGRAVITY_IDE_DATA_DIR
  )
  if (explicitDataDir) {
    return [path.join(explicitDataDir, "state.vscdb")]
  }

  const candidates = []

  if (PLATFORM === "darwin") {
    candidates.push(
      path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Antigravity",
        "User",
        "globalStorage",
        "state.vscdb"
      )
    )
  } else if (PLATFORM === "linux") {
    const xdgConfigHome = expandHomeDir(process.env.XDG_CONFIG_HOME)
    if (xdgConfigHome) {
      candidates.push(
        path.join(
          xdgConfigHome,
          "Antigravity",
          "User",
          "globalStorage",
          "state.vscdb"
        )
      )
    }
    candidates.push(
      path.join(
        os.homedir(),
        ".config",
        "Antigravity",
        "User",
        "globalStorage",
        "state.vscdb"
      )
    )
  } else if (PLATFORM === "win32") {
    const appData =
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    candidates.push(
      path.join(appData, "Antigravity", "User", "globalStorage", "state.vscdb")
    )
  } else {
    candidates.push(
      path.join(
        os.homedir(),
        ".config",
        "Antigravity",
        "User",
        "globalStorage",
        "state.vscdb"
      )
    )
  }

  return [...new Set(candidates)]
}

/**
 * Returns the base user data directory for Antigravity IDE (contains state.vscdb).
 */
function ideDataDir() {
  const stateDbPath = firstExistingPath(antigravityIdeStateDbCandidates())
  if (stateDbPath) {
    return path.dirname(stateDbPath)
  }
  return path.dirname(antigravityIdeStateDbCandidates()[0])
}

// ---------------------------------------------------------------------------
// Clash Verge config directory
// ---------------------------------------------------------------------------

/**
 * Returns the Clash Verge Rev config directory.
 */
function clashConfigDir() {
  const dirName = "io.github.clash-verge-rev.clash-verge-rev"

  if (PLATFORM === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", dirName)
  }
  if (PLATFORM === "linux") {
    return path.join(os.homedir(), ".config", dirName)
  }
  if (PLATFORM === "win32") {
    const appData =
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    return path.join(appData, dirName)
  }
  return path.join(os.homedir(), ".config", dirName)
}

// ---------------------------------------------------------------------------
// Port forwarding backend
// ---------------------------------------------------------------------------

/**
 * Returns the system firewall backend name for port forwarding.
 */
function forwardingBackend() {
  if (PLATFORM === "darwin") return "pf"
  if (PLATFORM === "linux") return "iptables"
  if (PLATFORM === "win32") return "netsh"
  return "unknown"
}

// ---------------------------------------------------------------------------
// Privilege escalation
// ---------------------------------------------------------------------------

/**
 * Returns the command prefix for privilege escalation.
 * On Windows, returns empty array (scripts must self-elevate or prompt UAC).
 */
function sudoPrefix() {
  if (PLATFORM === "win32") return []
  return ["sudo"]
}

/**
 * Returns whether the current process has admin/root privileges.
 */
function isElevated() {
  if (PLATFORM === "win32") {
    // Check for admin on Windows
    try {
      const { execSync } = require("child_process")
      execSync("net session", { stdio: "ignore" })
      return true
    } catch {
      return false
    }
  }
  return process.getuid?.() === 0
}

// ---------------------------------------------------------------------------
// Mitmdump path resolution
// ---------------------------------------------------------------------------

/**
 * Returns candidate paths for mitmdump binary.
 */
function mitmdumpCandidates() {
  if (PLATFORM === "darwin") {
    return ["/opt/homebrew/bin/mitmdump", "/usr/local/bin/mitmdump"]
  }
  if (PLATFORM === "linux") {
    return ["/usr/bin/mitmdump", "/usr/local/bin/mitmdump"]
  }
  if (PLATFORM === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    return [
      path.join(localAppData, "Programs", "Python", "Scripts", "mitmdump.exe"),
      "C:\\Python312\\Scripts\\mitmdump.exe",
      "C:\\Python311\\Scripts\\mitmdump.exe",
    ]
  }
  return []
}

module.exports = {
  PLATFORM,
  cursorWorkbenchPath,
  cursorBinaryPath,
  antigravityIdeStateDbCandidates,
  ideDataDir,
  clashConfigDir,
  forwardingBackend,
  sudoPrefix,
  isElevated,
  mitmdumpCandidates,
  expandHomeDir,
}
