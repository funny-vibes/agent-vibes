/**
 * Shared constants for the Agent Vibes extension.
 */

// Extension identifiers
export const EXTENSION_ID = "agent-vibes"
export const EXTENSION_DISPLAY_NAME = "Agent Vibes"

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
  GENERATE_CERT: "agentVibes.generateCert",
  ENABLE_FORWARDING: "agentVibes.enableForwarding",
  DISABLE_FORWARDING: "agentVibes.disableForwarding",
  FORWARDING_STATUS: "agentVibes.forwardingStatus",
  COLLECT_DIAGNOSTICS: "agentVibes.collectDiagnostics",
  OPEN_CONFIG: "agentVibes.openConfig",
  PATCH_CURSOR: "agentVibes.patchCursor",
  RESTORE_CURSOR: "agentVibes.restoreCursor",
  REFRESH_DASHBOARD: "agentVibes.refreshDashboard",
  OPEN_DASHBOARD: "agentVibes.openDashboard",
} as const

// Default configuration values
export const DEFAULTS = {
  PORT: 8000,
  HEALTH_CHECK_INTERVAL: 30, // seconds
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
