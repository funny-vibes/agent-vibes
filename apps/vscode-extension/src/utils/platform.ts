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

/** Returns the default data directory (~/.ccursor/) */
export function getDefaultDataDir(): string {
  return path.join(os.homedir(), ".ccursor")
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
  const modernSuffix = path.join(
    "Resources",
    "app",
    "out",
    "vs",
    "workbench",
    "workbench.desktop.main.js"
  )
  const legacySuffix = path.join(
    "Resources",
    "app",
    "out",
    "vs",
    "code",
    "electron-sandbox",
    "workbench",
    "workbench.desktop.main.js"
  )

  const candidates: string[] = []

  if (process.platform === "darwin") {
    candidates.push(
      path.join("/Applications/Cursor.app/Contents", modernSuffix),
      path.join("/Applications/Cursor.app/Contents", legacySuffix),
      path.join(
        os.homedir(),
        "Applications",
        "Cursor.app",
        "Contents",
        modernSuffix
      ),
      path.join(
        os.homedir(),
        "Applications",
        "Cursor.app",
        "Contents",
        legacySuffix
      )
    )
  } else if (process.platform === "linux") {
    candidates.push(
      path.join("/usr/share/cursor", modernSuffix),
      path.join("/usr/share/cursor", legacySuffix),
      path.join("/opt/cursor", modernSuffix),
      path.join("/opt/cursor", legacySuffix),
      path.join(os.homedir(), ".local", "share", "cursor", modernSuffix),
      path.join(os.homedir(), ".local", "share", "cursor", legacySuffix)
    )
  } else if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    candidates.push(
      path.join(localAppData, "Programs", "cursor", modernSuffix),
      path.join(localAppData, "Programs", "cursor", legacySuffix),
      path.join(localAppData, "cursor", modernSuffix),
      path.join(localAppData, "cursor", legacySuffix)
    )
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  return candidates[0] || null
}

/** Returns the Cursor app resource root that contains product.json and out/ */
export function getCursorAppRootPath(): string | null {
  const workbenchPath = getCursorWorkbenchPath()
  if (!workbenchPath) return null

  const appRootPath = path.resolve(path.dirname(workbenchPath), "../../..")
  return fs.existsSync(appRootPath) ? appRootPath : null
}

/** Returns the Cursor product.json path */
export function getCursorProductJsonPath(): string | null {
  const appRootPath = getCursorAppRootPath()
  if (!appRootPath) return null

  const productPath = path.join(appRootPath, "product.json")
  return fs.existsSync(productPath) ? productPath : null
}

export type CursorProductMetadata = {
  version: string | null
  commit: string | null
  date: string | null
}

export function getCursorProductMetadata(): CursorProductMetadata | null {
  const productPath = getCursorProductJsonPath()
  if (!productPath) return null

  try {
    const raw = fs.readFileSync(productPath, "utf-8")
    const parsed = JSON.parse(raw) as {
      version?: unknown
      commit?: unknown
      date?: unknown
    }
    return {
      version: typeof parsed.version === "string" ? parsed.version : null,
      commit: typeof parsed.commit === "string" ? parsed.commit : null,
      date: typeof parsed.date === "string" ? parsed.date : null,
    }
  } catch {
    return null
  }
}

/** Returns the Cursor package.json path */
export function getCursorPackageJsonPath(): string | null {
  const appRootPath = getCursorAppRootPath()
  if (!appRootPath) return null

  const packageJsonPath = path.join(appRootPath, "package.json")
  return fs.existsSync(packageJsonPath) ? packageJsonPath : null
}

/** Returns the Cursor app version from package.json */
export function getCursorInstallVersion(): string | null {
  const product = getCursorProductMetadata()
  if (product?.version) {
    return product.version
  }

  const packageJsonPath = getCursorPackageJsonPath()
  if (!packageJsonPath) return null

  try {
    const raw = fs.readFileSync(packageJsonPath, "utf-8")
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === "string" ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * Returns a stable install fingerprint for backup scoping.
 * Uses version + commit + build date when available so same-version
 * repacks do not accidentally reuse an old baseline.
 */
export function getCursorInstallFingerprint(): string | null {
  const product = getCursorProductMetadata()
  if (product) {
    return JSON.stringify(product)
  }

  const version = getCursorInstallVersion()
  return version ? JSON.stringify({ version, commit: null, date: null }) : null
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
