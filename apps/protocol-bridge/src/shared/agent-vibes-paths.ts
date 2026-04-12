import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/**
 * Unified runtime data directory: ~/.agent-vibes/
 * Replaces the scattered legacy paths:
 *   - apps/protocol-bridge/data/
 *   - apps/protocol-bridge/.runtime/
 *   - ~/.protocol-bridge/
 */

const DEFAULT_DATA_DIR_NAME = ".agent-vibes"

export function getAgentVibesHome(): string {
  const envOverride = process.env.AGENT_VIBES_DATA_DIR
  if (envOverride) {
    return path.resolve(envOverride)
  }
  return path.join(os.homedir(), DEFAULT_DATA_DIR_NAME)
}

export function getAgentVibesPgDataDir(): string {
  return path.join(getAgentVibesHome(), "pgdata")
}

export function getAgentVibesLogsDir(): string {
  return path.join(getAgentVibesHome(), "logs")
}

export function getAgentVibesCertsDir(): string {
  return path.join(getAgentVibesHome(), "certs")
}

export function getAgentVibesAccountsDir(): string {
  return path.join(getAgentVibesHome(), "data")
}

export function ensureAgentVibesDirs(): void {
  const dirs = [
    getAgentVibesHome(),
    getAgentVibesPgDataDir(),
    getAgentVibesLogsDir(),
    getAgentVibesCertsDir(),
    getAgentVibesAccountsDir(),
  ]
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }
}
