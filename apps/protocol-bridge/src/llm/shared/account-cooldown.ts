/**
 * Account Cooldown Manager — shared cooldown logic for multi-account pools.
 *
 * Inspired by CLIProxyAPI's per-model ModelState tracking and the native
 * ProcessPool's lightweight timestamp-based cooldown pattern. Provides:
 *
 *  1. Per-model cooldown with exponential backoff (429 quota errors)
 *  2. Global cooldown for auth/payment/transient errors (401/402/5xx)
 *  3. Cooldown-aware account selection (skips blocked accounts)
 *  4. Automatic recovery when cooldown expires
 *  5. Success-based cooldown reset
 */

import { Logger } from "@nestjs/common"

// ── Constants ────────────────────────────────────────────────────────────

/** Base cooldown for 429 when no Retry-After header is present */
const QUOTA_BACKOFF_BASE_MS = 30_000 // 30 seconds

/** Maximum 429 cooldown */
const QUOTA_BACKOFF_MAX_MS = 15 * 60_000 // 15 minutes

/** 401/402/403 cooldown */
const AUTH_COOLDOWN_MS = 30 * 60_000 // 30 minutes

/** 404 (model not supported) cooldown */
const NOT_FOUND_COOLDOWN_MS = 12 * 3600_000 // 12 hours

/** 5xx transient error cooldown */
const TRANSIENT_COOLDOWN_MS = 60_000 // 1 minute

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Per-model cooldown state (mirrors CLIProxyAPI's ModelState).
 */
export interface ModelCooldownState {
  /** Timestamp (Date.now()) until which this model is blocked; 0 = available */
  cooldownUntil: number
  /** Whether the cooldown is due to quota exhaustion (429) vs transient error */
  quotaExhausted: boolean
  /** Exponential backoff level for repeated 429s on this model */
  backoffLevel: number
}

/**
 * Mixin interface for accounts that support cooldown tracking.
 * Extend your account interface with this to enable cooldown management.
 */
export interface CooldownableAccount {
  /** Global cooldown timestamp (all models); 0 = available */
  cooldownUntil: number
  /** Per-model cooldown states */
  modelStates: Map<string, ModelCooldownState>
}

/**
 * Result of a cooldown-aware account pick.
 */
export interface PickResult<T> {
  account: T
  index: number
}

/**
 * Info returned when all accounts are cooling down.
 */
export interface AllCooldownInfo {
  /** Earliest timestamp when any account becomes available */
  earliestRecovery: number
  /** Duration in ms until earliest recovery */
  retryAfterMs: number
}

// ── Logger ───────────────────────────────────────────────────────────────

const logger = new Logger("AccountCooldown")

// ── Core Functions ───────────────────────────────────────────────────────

/**
 * Initialize cooldown fields on an account object.
 * Call this once when creating account slots.
 */
export function initCooldownFields<T extends CooldownableAccount>(
  account: T
): T {
  account.cooldownUntil = 0
  account.modelStates = new Map()
  return account
}

/**
 * Check if an account is available for a specific model at the given time.
 *
 * An account is blocked if:
 *  1. Its global cooldown is in effect (e.g. 401/5xx), OR
 *  2. The specific model has an active per-model cooldown (e.g. 429)
 *
 * Expired cooldowns are automatically cleared (lazy recovery).
 */
export function isAccountAvailableForModel(
  account: CooldownableAccount,
  model: string,
  now: number = Date.now()
): boolean {
  // Check global cooldown
  if (account.cooldownUntil > now) {
    return false
  }
  // Auto-clear expired global cooldown
  if (account.cooldownUntil > 0 && account.cooldownUntil <= now) {
    account.cooldownUntil = 0
  }

  // Check per-model cooldown
  if (model) {
    const modelState = account.modelStates.get(model)
    if (modelState) {
      if (modelState.cooldownUntil > now) {
        return false
      }
      // Auto-clear expired model cooldown
      if (modelState.cooldownUntil > 0 && modelState.cooldownUntil <= now) {
        account.modelStates.delete(model)
      }
    }
  }

  return true
}

/**
 * Mark an account as rate-limited based on the HTTP status code.
 *
 * Status code handling (aligned with CLIProxyAPI conductor.go):
 *  - 429: Per-model cooldown with exponential backoff (or Retry-After)
 *  - 401: Global cooldown 30 min (unauthorized)
 *  - 402/403: Global cooldown 30 min (payment required)
 *  - 404: Per-model cooldown 12 hours (model not supported)
 *  - 5xx: Global cooldown 1 min (transient)
 */
export function markAccountCooldown(
  account: CooldownableAccount,
  statusCode: number,
  model?: string,
  retryAfterHeader?: string,
  accountLabel?: string
): void {
  const now = Date.now()
  const label = accountLabel || "unknown"

  switch (statusCode) {
    case 429: {
      // Per-model cooldown with exponential backoff
      if (!model) {
        // No model context — apply global cooldown
        const delay = parseRetryAfterMs(retryAfterHeader, QUOTA_BACKOFF_BASE_MS)
        account.cooldownUntil = now + delay
        logger.warn(`[${label}] 429 global cooldown ${formatDuration(delay)}`)
        break
      }

      const existing = account.modelStates.get(model)
      const backoffLevel = existing?.backoffLevel ?? 0

      let delayMs: number
      if (retryAfterHeader) {
        delayMs = parseRetryAfterMs(retryAfterHeader, QUOTA_BACKOFF_BASE_MS)
      } else {
        delayMs = nextQuotaCooldown(backoffLevel)
      }

      account.modelStates.set(model, {
        cooldownUntil: now + delayMs,
        quotaExhausted: true,
        backoffLevel: backoffLevel + 1,
      })

      logger.warn(
        `[${label}] 429 model=${model} cooldown ${formatDuration(delayMs)} (backoff L${backoffLevel + 1})`
      )
      break
    }

    case 401:
      account.cooldownUntil = now + AUTH_COOLDOWN_MS
      logger.warn(`[${label}] 401 unauthorized, cooldown 30min`)
      break

    case 402:
    case 403:
      account.cooldownUntil = now + AUTH_COOLDOWN_MS
      logger.warn(`[${label}] ${statusCode} payment/forbidden, cooldown 30min`)
      break

    case 404:
      if (model) {
        account.modelStates.set(model, {
          cooldownUntil: now + NOT_FOUND_COOLDOWN_MS,
          quotaExhausted: false,
          backoffLevel: 0,
        })
        logger.warn(`[${label}] 404 model=${model} not found, cooldown 12h`)
      }
      break

    default:
      if (statusCode >= 500) {
        account.cooldownUntil = now + TRANSIENT_COOLDOWN_MS
        logger.warn(`[${label}] ${statusCode} server error, cooldown 1min`)
      }
      break
  }
}

/**
 * Mark an account as successfully responding, clearing its cooldown state.
 *
 * This clears:
 *  - Global cooldown
 *  - Per-model cooldown (if model is specified)
 *  - Resets backoff level for the model
 */
export function markAccountSuccess(
  account: CooldownableAccount,
  model?: string
): void {
  // Clear global cooldown
  account.cooldownUntil = 0

  // Clear per-model cooldown
  if (model && account.modelStates.has(model)) {
    account.modelStates.delete(model)
  }
}

/**
 * Pick the next available account from a pool, respecting cooldown states.
 *
 * Uses round-robin starting from `startIndex`, skipping accounts that are
 * in cooldown for the specified model. Returns null if all accounts are
 * currently cooling down.
 *
 * @param accounts - The account pool
 * @param model - The model being requested (for per-model cooldown checks)
 * @param startIndex - The round-robin starting index
 * @returns The picked account and its index, or null if none available
 */
export function pickAvailableAccount<T extends CooldownableAccount>(
  accounts: T[],
  model: string,
  startIndex: number
): PickResult<T> | null {
  if (accounts.length === 0) return null

  const now = Date.now()

  for (let offset = 0; offset < accounts.length; offset++) {
    const index = (startIndex + offset) % accounts.length
    const account = accounts[index]!
    if (isAccountAvailableForModel(account, model, now)) {
      return { account, index }
    }
  }

  return null
}

/**
 * Get the earliest recovery time across all accounts for a model.
 * Used to construct Retry-After header when all accounts are in cooldown.
 */
export function getEarliestRecovery(
  accounts: CooldownableAccount[],
  model: string
): AllCooldownInfo | null {
  if (accounts.length === 0) return null

  const now = Date.now()
  let earliest = Infinity

  for (const account of accounts) {
    // Check global cooldown
    if (account.cooldownUntil > now) {
      earliest = Math.min(earliest, account.cooldownUntil)
    }

    // Check per-model cooldown
    if (model) {
      const modelState = account.modelStates.get(model)
      if (modelState && modelState.cooldownUntil > now) {
        // For per-model cooldown, the effective recovery is the earlier of
        // global and model cooldown (both must expire for the account to be usable)
        const effectiveRecovery =
          account.cooldownUntil > now
            ? Math.max(account.cooldownUntil, modelState.cooldownUntil)
            : modelState.cooldownUntil
        earliest = Math.min(earliest, effectiveRecovery)
      } else if (account.cooldownUntil <= now) {
        // Account has no model cooldown and no global cooldown — available now
        // This shouldn't happen if pickAvailableAccount returned null, but be safe
        return null
      }
    }
  }

  if (earliest === Infinity) return null

  const retryAfterMs = Math.max(0, earliest - now)
  return { earliestRecovery: earliest, retryAfterMs }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Exponential backoff: base * 2^level, capped at max.
 */
function nextQuotaCooldown(backoffLevel: number): number {
  const delay = QUOTA_BACKOFF_BASE_MS * Math.pow(2, backoffLevel)
  return Math.min(delay, QUOTA_BACKOFF_MAX_MS)
}

/**
 * Parse the Retry-After header value (seconds) into milliseconds.
 * Falls back to defaultMs if parsing fails.
 */
function parseRetryAfterMs(
  retryAfterHeader: string | undefined,
  defaultMs: number
): number {
  if (!retryAfterHeader) return defaultMs

  const seconds = parseFloat(retryAfterHeader)
  if (isNaN(seconds) || seconds <= 0) return defaultMs

  return Math.ceil(seconds * 1000)
}

/**
 * Format duration in ms to human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}min`
  return `${(ms / 3600_000).toFixed(1)}h`
}
