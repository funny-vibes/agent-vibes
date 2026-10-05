import { requireExactDurableIdentifier } from "../../context/durable-identifier"
import type { CodexTurnContinuationState } from "./codex-turn-state"

export interface CodexCachedWsEntry extends CodexTurnContinuationState {
  wsSessionId: string
  turnKey: string | undefined
  turnState: string | undefined
  updatedAt: number
}

export interface CodexWsCacheKeyInput {
  slotKeyHash: string
  modelName: string
  conversationIdHash?: string
}

export interface CodexTakenWsEntry {
  cacheKey: string
  entry: CodexCachedWsEntry
}

export interface CodexRuntimeCacheStoreOptions {
  wsSessionTtlMs?: number
  maxWsSessions?: number
  now?: () => number
}

const DEFAULT_WS_SESSION_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_WS_SESSIONS = 128

export function createCodexWsCacheKey(input: CodexWsCacheKeyInput): string {
  const modelName = requireExactDurableIdentifier(
    input.modelName,
    "Codex runtime cache model"
  )
  const slotKeyHash = requireExactDurableIdentifier(
    input.slotKeyHash,
    "Codex runtime cache slot hash"
  )
  const conversationIdHash =
    input.conversationIdHash === undefined
      ? undefined
      : requireExactDurableIdentifier(
          input.conversationIdHash,
          "Codex runtime cache conversation hash"
        )
  const scope =
    conversationIdHash === undefined
      ? "global"
      : `conversation:${encodeURIComponent(conversationIdHash)}`
  return `ws:${encodeURIComponent(modelName)}:${encodeURIComponent(slotKeyHash)}:${scope}`
}

/**
 * Runtime cache entries are process-local, but old in-memory values can still
 * outlive a hot reload. A response chain without its authoritative
 * ModelClientSession id is not recoverable and must never be repaired from a
 * WebSocket id.
 */
export function isValidCodexCachedWsEntry(
  value: unknown
): value is CodexCachedWsEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false
  }

  const entry = value as Record<string, unknown>
  if (
    !isExactCodexCacheIdentifier(entry.wsSessionId) ||
    !isExactCodexCacheIdentifier(entry.modelClientSessionId) ||
    !isFiniteNumber(entry.updatedAt)
  ) {
    return false
  }

  if (
    entry.turnKey !== undefined &&
    !isExactCodexCacheIdentifier(entry.turnKey)
  ) {
    return false
  }
  if (
    entry.turnState !== undefined &&
    !isExactCodexCacheIdentifier(entry.turnState)
  ) {
    return false
  }
  if (
    entry.lastRequest !== undefined &&
    (!entry.lastRequest ||
      typeof entry.lastRequest !== "object" ||
      Array.isArray(entry.lastRequest))
  ) {
    return false
  }

  if (entry.lastResponse === undefined) {
    return true
  }
  if (
    !entry.lastResponse ||
    typeof entry.lastResponse !== "object" ||
    Array.isArray(entry.lastResponse)
  ) {
    return false
  }

  const response = entry.lastResponse as Record<string, unknown>
  return (
    isExactCodexCacheIdentifier(response.responseId) &&
    isExactCodexCacheIdentifier(response.modelClientSessionId) &&
    Array.isArray(response.itemsAdded)
  )
}

function isExactCodexCacheIdentifier(value: unknown): value is string {
  try {
    requireExactDurableIdentifier(value, "Codex runtime cache identifier")
    return true
  } catch {
    return false
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function conversationCacheSuffix(conversationIdHash: string): string {
  return `:conversation:${encodeURIComponent(
    requireExactDurableIdentifier(
      conversationIdHash,
      "Codex runtime cache conversation hash"
    )
  )}`
}

export class CodexRuntimeCacheStore {
  private readonly cachedWsSessions = new Map<string, CodexCachedWsEntry>()

  private readonly wsSessionTtlMs: number
  private readonly maxWsSessions: number
  private readonly now: () => number

  constructor(options: CodexRuntimeCacheStoreOptions = {}) {
    this.wsSessionTtlMs = options.wsSessionTtlMs ?? DEFAULT_WS_SESSION_TTL_MS
    this.maxWsSessions = options.maxWsSessions ?? DEFAULT_MAX_WS_SESSIONS
    if (!Number.isFinite(this.wsSessionTtlMs) || this.wsSessionTtlMs <= 0) {
      throw new Error("Codex runtime cache TTL must be positive")
    }
    if (!Number.isInteger(this.maxWsSessions) || this.maxWsSessions <= 0) {
      throw new Error("Codex runtime cache capacity must be a positive integer")
    }
    this.now = options.now ?? (() => Date.now())
  }

  prune(now: number = this.now()): void {
    for (const [key, entry] of this.cachedWsSessions) {
      if (
        !isExactCodexCacheIdentifier(key) ||
        !isValidCodexCachedWsEntry(entry) ||
        entry.updatedAt + this.wsSessionTtlMs <= now
      ) {
        this.cachedWsSessions.delete(key)
      }
    }
    this.pruneMapToMaxSize(this.cachedWsSessions, this.maxWsSessions)
  }

  getWs(cacheKey: string): CodexCachedWsEntry | undefined {
    const exactCacheKey = requireExactDurableIdentifier(
      cacheKey,
      "Codex runtime cache key"
    )
    this.prune()
    const entry = this.cachedWsSessions.get(exactCacheKey)
    if (!entry || isValidCodexCachedWsEntry(entry)) {
      return entry
    }
    this.cachedWsSessions.delete(exactCacheKey)
    return undefined
  }

  setWs(cacheKey: string, entry: CodexCachedWsEntry): void {
    const exactCacheKey = requireExactDurableIdentifier(
      cacheKey,
      "Codex runtime cache key"
    )
    this.prune()
    if (!isValidCodexCachedWsEntry(entry)) {
      this.cachedWsSessions.delete(exactCacheKey)
      throw new Error(
        "Codex runtime cache entry requires exact WebSocket and ModelClientSession identity"
      )
    }
    this.cachedWsSessions.set(exactCacheKey, {
      ...entry,
      updatedAt: this.now(),
    })
    this.pruneMapToMaxSize(this.cachedWsSessions, this.maxWsSessions)
  }

  takeWs(cacheKey: string): CodexTakenWsEntry | undefined {
    const exactCacheKey = requireExactDurableIdentifier(
      cacheKey,
      "Codex runtime cache key"
    )
    const entry = this.getWs(exactCacheKey)
    if (!entry) return undefined
    this.cachedWsSessions.delete(exactCacheKey)
    return { cacheKey: exactCacheKey, entry }
  }

  takeConversationWsWithGlobalFallback(
    conversationCacheKey: string,
    globalCacheKey: string
  ): CodexTakenWsEntry | undefined {
    const exactConversationCacheKey = requireExactDurableIdentifier(
      conversationCacheKey,
      "Codex conversation cache key"
    )
    const exactGlobalCacheKey = requireExactDurableIdentifier(
      globalCacheKey,
      "Codex global cache key"
    )
    const exact = this.takeWs(exactConversationCacheKey)
    if (exact || exactGlobalCacheKey === exactConversationCacheKey) {
      return exact
    }

    const global = this.getWs(exactGlobalCacheKey)
    if (!global || !isPristineCodexCachedWsEntry(global)) {
      return undefined
    }

    this.cachedWsSessions.delete(exactGlobalCacheKey)
    return { cacheKey: exactGlobalCacheKey, entry: global }
  }

  deleteWs(cacheKey: string): CodexCachedWsEntry | undefined {
    const exactCacheKey = requireExactDurableIdentifier(
      cacheKey,
      "Codex runtime cache key"
    )
    this.prune()
    const entry = this.cachedWsSessions.get(exactCacheKey)
    if (entry) {
      this.cachedWsSessions.delete(exactCacheKey)
    }
    return entry && isValidCodexCachedWsEntry(entry) ? entry : undefined
  }

  clearWsBaselinesByConversationHash(conversationIdHash: string): {
    clearedCount: number
    discardedPreviousResponseId: string | undefined
  } {
    this.prune()
    const suffix = conversationCacheSuffix(conversationIdHash)
    let clearedCount = 0
    let discardedPreviousResponseId: string | undefined
    for (const [key, entry] of this.cachedWsSessions) {
      if (!key.endsWith(suffix)) {
        continue
      }
      if (!isValidCodexCachedWsEntry(entry)) {
        this.cachedWsSessions.delete(key)
        continue
      }

      const hadContinuationBaseline =
        !!entry.lastRequest || !!entry.lastResponse
      if (!hadContinuationBaseline) {
        continue
      }

      discardedPreviousResponseId =
        discardedPreviousResponseId || entry.lastResponse?.responseId
      this.cachedWsSessions.set(key, {
        ...entry,
        lastRequest: undefined,
        lastResponse: undefined,
        updatedAt: this.now(),
      })
      clearedCount++
    }

    return {
      clearedCount,
      discardedPreviousResponseId,
    }
  }

  takeWsEntriesByConversationHash(
    conversationIdHash: string
  ): CodexCachedWsEntry[] {
    const suffix = conversationCacheSuffix(conversationIdHash)
    const entries: CodexCachedWsEntry[] = []
    for (const [key, entry] of this.cachedWsSessions) {
      if (!key.endsWith(suffix)) {
        continue
      }
      this.cachedWsSessions.delete(key)
      if (isValidCodexCachedWsEntry(entry)) {
        entries.push(entry)
      }
    }
    return entries
  }

  private pruneMapToMaxSize<K, V>(map: Map<K, V>, maxSize: number): void {
    while (map.size > maxSize) {
      const oldestKey = map.keys().next().value
      if (oldestKey === undefined) return
      map.delete(oldestKey)
    }
  }
}

export function isPristineCodexCachedWsEntry(
  entry: CodexCachedWsEntry
): boolean {
  return (
    isValidCodexCachedWsEntry(entry) &&
    !entry.lastResponse &&
    !entry.lastRequest
  )
}
