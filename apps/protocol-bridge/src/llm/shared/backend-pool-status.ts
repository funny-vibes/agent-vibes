export type BackendPoolEntryState =
  | "ready"
  | "degraded"
  | "model_cooldown"
  | "cooldown"
  | "disabled"
  | "unavailable"

export type BackendPoolModelCooldownReason =
  | "quota_exhausted"
  | "rate_limited"
  | "capacity_exhausted"
  | "transient"

export interface BackendPoolModelCooldownStatus {
  model: string
  cooldownUntil: number
  quotaExhausted?: boolean
  reason?: BackendPoolModelCooldownReason
  backoffLevel?: number
}

export interface BackendPoolEndpointCooldownStatus {
  endpoint: string
  model: string
  cooldownUntil: number
  quotaExhausted?: boolean
  backoffLevel?: number
}

export type CodexRateLimitSource = "request" | "probe"

export interface CodexRateLimitWindow {
  usedPercent: number
  windowMinutes: number | null
  resetsAt: number | null
}

export interface CodexRateLimitSnapshot {
  model: string
  displayModel: string
  source: CodexRateLimitSource
  primary?: CodexRateLimitWindow
  secondary?: CodexRateLimitWindow
  updatedAt: number
}

export interface CodexRateLimitModelSummary {
  model: string
  displayModel: string
  effective: CodexRateLimitSnapshot | null
  request?: CodexRateLimitSnapshot
  probe?: CodexRateLimitSnapshot
  updatedAt: number
}

/**
 * Where an image-limit reading came from: the headers of an image response,
 * or an image request refused because the limit is spent.
 */
export type CodexImageGenLimitSource = "response" | "limit-error"

/** The backend's separate meter for standalone image generation. */
export interface CodexImageGenLimitSnapshot {
  source: CodexImageGenLimitSource
  /** The backend's limit id, e.g. `imagegen_premium`. */
  limitName?: string
  primary?: CodexRateLimitWindow
  secondary?: CodexRateLimitWindow
  limitReached?: boolean
  /** Unix seconds; set when the backend names one reset for the whole limit. */
  resetsAt?: number
  updatedAt: number
}

export interface CodexRateLimitAccountSummary {
  effective: CodexRateLimitSnapshot | null
  models: CodexRateLimitModelSummary[]
  imageGen?: CodexImageGenLimitSnapshot
  updatedAt: number | null
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
  maxContextTokens?: number
  modelCooldowns: BackendPoolModelCooldownStatus[]
  endpointCooldowns?: BackendPoolEndpointCooldownStatus[]
  rateLimits?: CodexRateLimitAccountSummary
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
