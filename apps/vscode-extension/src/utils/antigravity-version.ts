import * as fs from "fs"
import * as path from "path"

function normalizeAntigravityVersion(rawValue: unknown): string | null {
  const raw = String(rawValue || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)

  if (!raw) {
    return null
  }

  const match = raw.match(/(?:Version:\s*)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i)
  return match?.[1] || raw
}

function readVersionFromPackageJson(packageJsonPath: string): string | null {
  if (!fs.existsSync(packageJsonPath)) {
    return null
  }

  try {
    const raw = fs.readFileSync(packageJsonPath, "utf8")
    const parsed = JSON.parse(raw) as { version?: unknown }
    return normalizeAntigravityVersion(parsed.version)
  } catch {
    return null
  }
}

function readVersionFromInfoPlist(infoPlistPath: string): string | null {
  if (!fs.existsSync(infoPlistPath)) {
    return null
  }

  try {
    const plist = fs.readFileSync(infoPlistPath, "utf8")
    const match = plist.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/
    )
    return normalizeAntigravityVersion(match?.[1])
  } catch {
    return null
  }
}

function readVersionFromAppBundle(appBundlePath: string): string | null {
  const normalizedAppPath = appBundlePath.trim()
  if (!normalizedAppPath) {
    return null
  }

  const candidates = [
    path.join(
      normalizedAppPath,
      "Contents",
      "Resources",
      "app",
      "package.json"
    ),
    path.join(
      normalizedAppPath,
      "Contents",
      "resources",
      "app",
      "package.json"
    ),
  ]

  for (const candidate of candidates) {
    const version = readVersionFromPackageJson(candidate)
    if (version) {
      return version
    }
  }

  return readVersionFromInfoPlist(
    path.join(normalizedAppPath, "Contents", "Info.plist")
  )
}

function getAntigravityAppPathCandidates(): string[] {
  const envPath = String(process.env.ANTIGRAVITY_APP_PATH || "").trim()
  const candidates = envPath ? [envPath] : []

  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Antigravity.app",
      "/Applications/Antigravity Beta.app",
      "/Applications/Setapp/Antigravity.app",
      path.join(process.env.HOME || "~", "Applications", "Antigravity.app")
    )
  }

  return Array.from(new Set(candidates))
}

export function detectCurrentAntigravityVersion(): string | null {
  for (const candidate of getAntigravityAppPathCandidates()) {
    const version = readVersionFromAppBundle(candidate)
    if (version) {
      return version
    }
  }

  return null
}
