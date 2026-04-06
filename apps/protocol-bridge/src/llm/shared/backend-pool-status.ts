export type BackendPoolEntryState =
  | "ready"
  | "degraded"
  | "model_cooldown"
  | "cooldown"
  | "disabled"
  | "unavailable"

export interface BackendPoolModelCooldownStatus {
  model: string
  cooldownUntil: number
  quotaExhausted?: boolean
  backoffLevel?: number
}

export interface CodexRateLimitWindow {
  usedPercent: number
  windowMinutes: number | null
  resetsAt: number | null
}

export interface CodexRateLimitSnapshot {
  primary?: CodexRateLimitWindow
  secondary?: CodexRateLimitWindow
  updatedAt: number
}

export interface BackendPoolEntryStatus {
  id: string
  label: string
  state: BackendPoolEntryState
  cooldownUntil: number
  disabledAt?: number
  disabledReason?: string
  source?: string
  baseUrl?: string
  proxyUrl?: string
  prefix?: string
  priority?: number
  planType?: string
  email?: string
  accountId?: string
  workspaceId?: string
  ready?: boolean
  requestCount?: number
  pid?: number
  modelCooldowns: BackendPoolModelCooldownStatus[]
  rateLimits?: CodexRateLimitSnapshot
}

export interface BackendPoolStatus {
  backend: string
  kind: "account-pool" | "native-worker-pool"
  configured: boolean
  total: number
  available: number
  ready: number
  degraded: number
  modelCooldown: number
  cooling: number
  disabled: number
  unavailable: number
  configPath?: string | null
  statePath?: string | null
  entries: BackendPoolEntryStatus[]
}
