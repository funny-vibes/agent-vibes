import * as os from "os"
import * as path from "path"
import * as fs from "fs"

/**
 * Cross-platform utility functions.
 * Replaces the per-platform branching with unified logic.
 */

/** Returns the hosts file path for the current OS */
export function getHostsPath(): string {
  return process.platform === "win32"
    ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
    : "/etc/hosts"
}

/** Returns the command to add/remove a loopback alias — the ONLY platform-specific line */
export function getLoopbackCommand(
  ip: string,
  action: "add" | "remove"
): string {
  switch (process.platform) {
    case "darwin":
      return action === "add"
        ? `ifconfig lo0 alias ${ip}`
        : `ifconfig lo0 -alias ${ip}`
    case "linux":
      return action === "add"
        ? `ip addr add ${ip}/32 dev lo`
        : `ip addr del ${ip}/32 dev lo`
    case "win32":
      return action === "add"
        ? `netsh interface ip add address "Loopback" ${ip} 255.255.255.255`
        : `netsh interface ip delete address "Loopback" ${ip}`
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}

/** Returns the default data directory (~/.agent-vibes/) */
export function getDefaultDataDir(): string {
  return path.join(os.homedir(), ".agent-vibes")
}

/** Ensures a directory exists, creating it recursively if needed */
export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

/** Returns the Antigravity IDE data directory (for credential sync) */
export function getAntigravityIDEDataDir(): string {
  switch (process.platform) {
    case "darwin":
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Antigravity",
        "User",
        "globalStorage"
      )
    case "linux":
      return path.join(
        os.homedir(),
        ".config",
        "Antigravity",
        "User",
        "globalStorage"
      )
    case "win32": {
      const appData =
        process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      return path.join(appData, "Antigravity", "User", "globalStorage")
    }
    default:
      return path.join(
        os.homedir(),
        ".config",
        "Antigravity",
        "User",
        "globalStorage"
      )
  }
}

/** Returns candidate paths for Cursor IDE workbench file */
export function getCursorWorkbenchPath(): string | null {
  const suffix = path.join(
    "Resources",
    "app",
    "out",
    "vs",
    "workbench",
    "workbench.desktop.main.js"
  )

  const candidates: string[] = []

  if (process.platform === "darwin") {
    candidates.push(
      path.join("/Applications/Cursor.app/Contents", suffix),
      path.join(os.homedir(), "Applications", "Cursor.app", "Contents", suffix)
    )
  } else if (process.platform === "linux") {
    candidates.push(
      path.join("/usr/share/cursor", suffix),
      path.join("/opt/cursor", suffix),
      path.join(os.homedir(), ".local", "share", "cursor", suffix)
    )
  } else if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    candidates.push(
      path.join(localAppData, "Programs", "cursor", suffix),
      path.join(localAppData, "cursor", suffix)
    )
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  return candidates[0] || null
}

/**
 * Returns the current platform + arch identifier for selecting the correct
 * SEA binary, e.g. "darwin-arm64", "linux-x64", "win32-x64".
 */
export function getPlatformTarget(): string {
  return `${process.platform}-${process.arch}`
}

/** Returns the correct executable extension for the current platform */
export function getExeExtension(): string {
  return process.platform === "win32" ? ".exe" : ""
}
