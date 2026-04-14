/**
 * Shared constants for the Agent Vibes extension.
 */

// Extension identifiers
export const EXTENSION_ID = "agent-vibes"
export const EXTENSION_DISPLAY_NAME = "Agent Vibes"
export const GITHUB_REPO = "funny-vibes/agent-vibes"
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`
export const GITHUB_RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`

// Context keys (for when-clause evaluation)
export const CTX_SERVER_RUNNING = "agentVibes.serverRunning"

// Command identifiers
export const CMD = {
  START_SERVER: "agentVibes.startServer",
  STOP_SERVER: "agentVibes.stopServer",
  RESTART_SERVER: "agentVibes.restartServer",
  SYNC_ANTIGRAVITY_IDE: "agentVibes.syncAntigravityIDE",
  SYNC_ANTIGRAVITY_TOOLS: "agentVibes.syncAntigravityTools",
  SYNC_CLAUDE: "agentVibes.syncClaude",
  SYNC_CODEX: "agentVibes.syncCodex",
  IMPORT_CODEX_CPA_JSONS: "agentVibes.importCodexCpaJsons",
  OPEN_OPENAI_COMPAT_ACCOUNTS: "agentVibes.openOpenAICompatAccounts",
  OPEN_CLAUDE_API_ACCOUNTS: "agentVibes.openClaudeApiAccounts",
  GENERATE_CERT: "agentVibes.generateCert",
  ENABLE_FORWARDING: "agentVibes.enableForwarding",
  DISABLE_FORWARDING: "agentVibes.disableForwarding",
  FORWARDING_STATUS: "agentVibes.forwardingStatus",
  CHECK_UPDATES: "agentVibes.checkExtensionUpdates",
  OPEN_CONFIG: "agentVibes.openConfig",
  OPEN_DASHBOARD: "agentVibes.openDashboard",
} as const

// Default configuration values
export const DEFAULTS = {
  PORT: 2026,
  HEALTH_CHECK_INTERVAL: 30, // seconds
  UPDATE_CHECK_INTERVAL_HOURS: 12,
  LOOPBACK_IP: "127.0.0.2",
  FROM_PORT: 443,
} as const

// Server state
export type ServerState = "stopped" | "starting" | "running" | "error"

// Cursor domains that need to be redirected
export const CURSOR_DOMAINS = [
  "api5.cursor.sh",
  "api5geo.cursor.sh",
  "api5lat.cursor.sh",
  "api2.cursor.sh",
  "api2geo.cursor.sh",
  "api2direct.cursor.sh",
] as const

// Generate full host entries (base + agent. + agentn. prefixes)
export function getCursorHostEntries(ip: string): string[] {
  const entries: string[] = []
  for (const domain of CURSOR_DOMAINS) {
    entries.push(`${ip}   ${domain}`)
    entries.push(`${ip}   agent.${domain}`)
    entries.push(`${ip}   agentn.${domain}`)
  }
  return entries
}
