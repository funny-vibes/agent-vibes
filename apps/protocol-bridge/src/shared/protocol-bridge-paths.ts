import * as fs from "fs"
import * as path from "path"
import * as os from "os"

const APP_ROOT_MARKER = "nest-cli.json"
const ACCOUNT_CONFIG_ENV_VARS: Record<string, string> = {
  "antigravity-accounts.json": "AGENT_VIBES_ANTIGRAVITY_ACCOUNTS_PATH",
  "claude-api-accounts.json": "AGENT_VIBES_CLAUDE_API_ACCOUNTS_PATH",
  "codex-accounts.json": "AGENT_VIBES_CODEX_ACCOUNTS_PATH",
  "openai-compat-accounts.json": "AGENT_VIBES_OPENAI_COMPAT_ACCOUNTS_PATH",
}

/**
 * Returns the unified Agent Vibes data directory.
 * Priority: AGENT_VIBES_DATA_DIR env > ~/.agent-vibes/
 */
export function getAgentVibesDataDir(): string {
  return (
    process.env.AGENT_VIBES_DATA_DIR || path.join(os.homedir(), ".agent-vibes")
  )
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((candidate) => path.resolve(candidate))))
}

export function resolveProtocolBridgeAppRoot(): string {
  const cwd = process.cwd()
  const nestedRoot = path.resolve(cwd, "apps/protocol-bridge")

  if (fs.existsSync(path.join(cwd, APP_ROOT_MARKER))) {
    return cwd
  }

  if (fs.existsSync(path.join(nestedRoot, APP_ROOT_MARKER))) {
    return nestedRoot
  }

  return nestedRoot
}

export function resolveProtocolBridgePath(...segments: string[]): string {
  return path.resolve(resolveProtocolBridgeAppRoot(), ...segments)
}

export function getAccountConfigEnvVarName(filename: string): string | null {
  return ACCOUNT_CONFIG_ENV_VARS[filename] || null
}

export function resolveConfiguredAccountConfigPath(
  filename: string
): string | null {
  const envVar = getAccountConfigEnvVarName(filename)
  if (!envVar) {
    return null
  }

  const configuredPath = process.env[envVar]?.trim()
  if (!configuredPath) {
    return null
  }

  return path.resolve(configuredPath)
}

/**
 * Get candidate paths for an account config file.
 * Priority:
 * 1. Explicit backend-specific env override
 * 2. Unified runtime path (~/.agent-vibes/data/)
 * 3. Legacy dev fallback (only while the unified file is absent)
 */
export function getAccountConfigPathCandidates(filename: string): string[] {
  const configuredPath = resolveConfiguredAccountConfigPath(filename)
  if (configuredPath) {
    return [configuredPath]
  }

  const unifiedPath = path.resolve(getAgentVibesDataDir(), "data", filename)
  if (fs.existsSync(unifiedPath)) {
    return [unifiedPath]
  }

  return uniquePaths([
    unifiedPath,
    resolveProtocolBridgePath("data", filename),
    resolveProtocolBridgePath("data", "accounts", filename),
  ])
}

export function resolveDefaultAccountConfigPath(filename: string): string {
  return (
    resolveConfiguredAccountConfigPath(filename) ||
    path.resolve(getAgentVibesDataDir(), "data", filename)
  )
}

export function getAntigravityAccountsConfigPathCandidates(): string[] {
  const primaryCandidates = getAccountConfigPathCandidates(
    "antigravity-accounts.json"
  )
  const configuredPath = resolveConfiguredAccountConfigPath(
    "antigravity-accounts.json"
  )

  if (configuredPath || fs.existsSync(primaryCandidates[0]!)) {
    return primaryCandidates
  }

  return uniquePaths([
    ...primaryCandidates,
    resolveProtocolBridgePath("data", "accounts.json"),
  ])
}

export function getAntigravityIdeStateDbPathCandidates(): string[] {
  const explicitStateDbPath =
    process.env.AGENT_VIBES_ANTIGRAVITY_IDE_STATE_DB_PATH?.trim()
  if (explicitStateDbPath) {
    return [path.resolve(explicitStateDbPath)]
  }

  const explicitDataDir =
    process.env.AGENT_VIBES_ANTIGRAVITY_IDE_DATA_DIR?.trim()
  if (explicitDataDir) {
    return [path.resolve(explicitDataDir, "state.vscdb")]
  }

  const home = os.homedir()
  const candidates: string[] = []

  switch (process.platform) {
    case "darwin":
      candidates.push(
        path.join(
          home,
          "Library",
          "Application Support",
          "Antigravity",
          "User",
          "globalStorage",
          "state.vscdb"
        )
      )
      break
    case "linux": {
      const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim()
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
          home,
          ".config",
          "Antigravity",
          "User",
          "globalStorage",
          "state.vscdb"
        )
      )
      break
    }
    case "win32": {
      const appData =
        process.env.APPDATA || path.join(home, "AppData", "Roaming")
      candidates.push(
        path.join(
          appData,
          "Antigravity",
          "User",
          "globalStorage",
          "state.vscdb"
        )
      )
      break
    }
    default:
      candidates.push(
        path.join(
          home,
          ".config",
          "Antigravity",
          "User",
          "globalStorage",
          "state.vscdb"
        )
      )
      break
  }

  return uniquePaths(candidates)
}

export function resolveAntigravityIdeStateDbPath(): string {
  const candidates = getAntigravityIdeStateDbPathCandidates()
  const existing = candidates.find((candidate) => fs.existsSync(candidate))
  return existing || candidates[0]!
}
