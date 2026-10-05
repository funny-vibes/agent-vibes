import { requireExactDurableIdentifier } from "../../context/durable-identifier"
import { CodexConversationSessionStore } from "./codex-conversation-session-store"
import type { CodexRuntimeCacheStore } from "./codex-runtime-cache-store"
import type { CodexInputItem } from "./codex-native-types"
import {
  buildCodexScopedWsCacheKey,
  buildCodexTurnWsSessionId,
  codexTurnContextToCachedWsEntry,
  createCodexTurnContext,
  reuseCodexActiveTurnContext,
  type CodexTurnContext,
} from "./codex-turn-context"
import {
  captureCodexTurnResponse,
  commitCodexTurnStateRequest,
  hasCodexTurnContinuationState,
  planCodexFullTurnStateRequest,
  planCodexTurnStateRequest,
  resetCodexTurnContinuationState,
  startCodexFullResponseChain,
  type CodexPreparedTurnRequest,
} from "./codex-turn-state"
import { hashCodexIdentityPart, type CodexSlotKey } from "./codex-slot-identity"

export interface CodexTurnContextManagerOptions {
  runtimeCache: CodexRuntimeCacheStore
  closeWsSession: (sessionId: string) => void
  now?: () => number
}

export interface CodexTurnContextCacheScope {
  slotKey: CodexSlotKey
  modelName: string
  conversationId?: string
}

export interface CodexGetOrCreateTurnContextInput extends CodexTurnContextCacheScope {
  conversationId: string
  turnKey?: string
}

export interface CodexResetContinuationInput {
  conversationId: string | undefined
  modelName?: string
  slotKeys?: CodexSlotKey[]
}

export interface CodexResetContinuationResult {
  conversationId: string | undefined
  modelName: string | undefined
  resetCount: number
  discardedActivePreviousResponseId: string | undefined
}

export interface CodexClearContinuationBaselineInput {
  conversationId: string | undefined
  modelName?: string
  slotKeys?: CodexSlotKey[]
}

export interface CodexClearContinuationBaselineResult {
  conversationId: string | undefined
  modelName: string | undefined
  resetCount: number
  discardedPreviousResponseId: string | undefined
}

/** Transport routing evidence observed from a failed physical attempt. */
export interface CodexHttpFallbackTransportInput extends CodexTurnContextCacheScope {
  conversationId: string | undefined
  /** The upstream rejected the account header for this exact session scope. */
  omitAccountId?: boolean
}

export interface CodexHttpFallbackTransportResult {
  conversationId: string | undefined
  httpFallbackActivated: boolean
  omitAccountId: boolean
}

/** A successful HTTP attempt may now retire its old WebSocket baseline. */
export interface CodexCommittedHttpTransportInput extends CodexTurnContextCacheScope {
  conversationId: string | undefined
}

export interface CodexCommittedHttpTransportResult {
  conversationId: string | undefined
  clearedActiveContext: boolean
  deletedCachedContext: boolean
  discardedPreviousResponseId: string | undefined
  closedSessionIds: string[]
}

export interface CodexPreparedWarmupContext {
  cacheKey: string
  sessionId: string
  reusedCache: boolean
}

export interface CodexWarmPoolAvailabilityInput extends Omit<
  CodexTurnContextCacheScope,
  "conversationId"
> {
  wsUrl: string
  hasOpenSessionConnection: (sessionId: string, wsUrl: string) => boolean
}

export type CodexWarmPoolAvailability =
  | {
      available: true
      sessionId: string
      source: "cached_entry" | "cache_key"
    }
  | {
      available: false
    }

/**
 * Owns Codex logical turn lifecycle.
 *
 * This mirrors Codex CLI's separation between a logical ModelClientSession and
 * the physical WebSocket transport. The manager is deliberately framework-free:
 * callers provide the shared runtime cache and transport close primitive.
 */
export class CodexTurnContextManager {
  private readonly sessions =
    new CodexConversationSessionStore<CodexTurnContext>()
  private readonly httpFallbackTransports = new Set<string>()
  private readonly httpFallbackTransportOptions = new Map<
    string,
    { omitAccountId: boolean }
  >()
  private readonly runtimeCache: CodexRuntimeCacheStore
  private readonly closeWsSession: (sessionId: string) => void
  private readonly now: () => number

  constructor(options: CodexTurnContextManagerOptions) {
    this.runtimeCache = options.runtimeCache
    this.closeWsSession = options.closeWsSession
    this.now = options.now ?? (() => Date.now())
  }

  buildWsCacheKey(input: CodexTurnContextCacheScope): string {
    return buildCodexScopedWsCacheKey(input)
  }

  isHttpFallbackTransport(input: CodexTurnContextCacheScope): boolean {
    const conversationId = this.requireOptionalConversationId(
      input.conversationId
    )
    if (conversationId === undefined) return false
    return this.httpFallbackTransports.has(
      this.buildHttpFallbackTransportKey({ ...input, conversationId })
    )
  }

  shouldOmitAccountIdForHttpTransport(
    input: CodexTurnContextCacheScope
  ): boolean {
    const conversationId = this.requireOptionalConversationId(
      input.conversationId
    )
    if (conversationId === undefined) return false
    const cacheKey = this.buildHttpFallbackTransportKey({
      ...input,
      conversationId,
    })
    return (
      this.httpFallbackTransportOptions.get(cacheKey)?.omitAccountId === true
    )
  }

  /**
   * Persist routing evidence without touching the response chain. A failed
   * WebSocket/HTTP attempt may prove the preferred next transport, but it
   * cannot publish or discard a continuation baseline.
   */
  recordHttpFallbackTransport(
    input: CodexHttpFallbackTransportInput
  ): CodexHttpFallbackTransportResult {
    const conversationId = this.requireOptionalConversationId(
      input.conversationId
    )
    if (conversationId === undefined) {
      return {
        conversationId: undefined,
        httpFallbackActivated: false,
        omitAccountId: false,
      }
    }

    const fallbackKey = this.buildHttpFallbackTransportKey({
      conversationId,
      slotKey: input.slotKey,
      modelName: input.modelName,
    })
    const httpFallbackActivated = !this.httpFallbackTransports.has(fallbackKey)
    this.httpFallbackTransports.add(fallbackKey)
    const existing = this.httpFallbackTransportOptions.get(fallbackKey)
    this.httpFallbackTransportOptions.set(fallbackKey, {
      omitAccountId:
        existing?.omitAccountId === true || input.omitAccountId === true,
    })

    return {
      conversationId,
      httpFallbackActivated,
      omitAccountId:
        this.httpFallbackTransportOptions.get(fallbackKey)?.omitAccountId ===
        true,
    }
  }

  /**
   * Publish the HTTP transport transition after that exact attempt is
   * accepted. This is the only path that clears an active/cached response
   * chain merely because a full-input HTTP request superseded it.
   */
  commitHttpTransportTurn(
    input: CodexCommittedHttpTransportInput
  ): CodexCommittedHttpTransportResult {
    const conversationId = this.requireOptionalConversationId(
      input.conversationId
    )
    if (conversationId === undefined) {
      return {
        conversationId: undefined,
        clearedActiveContext: false,
        deletedCachedContext: false,
        discardedPreviousResponseId: undefined,
        closedSessionIds: [],
      }
    }

    let discardedPreviousResponseId: string | undefined
    let clearedActiveContext = false
    const closedSessionIds = new Set<string>()

    const activeContext = this.sessions.getActive(conversationId)
    if (activeContext) {
      discardedPreviousResponseId =
        resetCodexTurnContinuationState(activeContext)
      activeContext.connectionReused = false
      closedSessionIds.add(activeContext.wsSessionId)
      this.sessions.clearActive(conversationId)
      clearedActiveContext = true
    }

    const cached = this.runtimeCache.deleteWs(
      this.buildWsCacheKey({
        conversationId,
        slotKey: input.slotKey,
        modelName: input.modelName,
      })
    )
    if (cached) {
      discardedPreviousResponseId =
        discardedPreviousResponseId || cached.lastResponse?.responseId
      closedSessionIds.add(cached.wsSessionId)
    }

    for (const sessionId of closedSessionIds) {
      this.closeWsSession(sessionId)
    }

    return {
      conversationId,
      clearedActiveContext,
      deletedCachedContext: !!cached,
      discardedPreviousResponseId,
      closedSessionIds: Array.from(closedSessionIds),
    }
  }

  prepareWarmupContext(
    input: CodexTurnContextCacheScope & { turnKey?: string }
  ): CodexPreparedWarmupContext {
    const conversationId = this.requireOptionalConversationId(
      input.conversationId
    )
    const turnKey =
      input.turnKey === undefined
        ? undefined
        : requireExactDurableIdentifier(input.turnKey, "Codex warmup turn key")
    const cacheKey = this.buildWsCacheKey({
      slotKey: input.slotKey,
      modelName: input.modelName,
      conversationId,
    })
    let cached = this.runtimeCache.getWs(cacheKey)
    if (cached && cached.turnKey !== turnKey) {
      cached = {
        ...cached,
        modelClientSessionId:
          conversationId === undefined
            ? cacheKey
            : buildCodexTurnWsSessionId(conversationId, turnKey),
        turnKey,
        turnState: undefined,
        lastRequest: undefined,
        lastResponse: undefined,
      }
      this.runtimeCache.setWs(cacheKey, cached)
    }
    const sessionId =
      cached?.wsSessionId ||
      (conversationId !== undefined
        ? buildCodexTurnWsSessionId(conversationId, turnKey)
        : cacheKey)

    if (!cached) {
      this.runtimeCache.setWs(cacheKey, {
        wsSessionId: sessionId,
        modelClientSessionId: sessionId,
        turnKey,
        turnState: undefined,
        lastResponse: undefined,
        lastRequest: undefined,
        updatedAt: this.now(),
      })
    }

    return {
      cacheKey,
      sessionId,
      reusedCache: !!cached,
    }
  }

  getWarmPoolAvailability(
    input: CodexWarmPoolAvailabilityInput
  ): CodexWarmPoolAvailability {
    const cacheKey = this.buildWsCacheKey({
      slotKey: input.slotKey,
      modelName: input.modelName,
    })
    const cached = this.runtimeCache.getWs(cacheKey)
    if (
      cached &&
      input.hasOpenSessionConnection(cached.wsSessionId, input.wsUrl)
    ) {
      return {
        available: true,
        sessionId: cached.wsSessionId,
        source: "cached_entry",
      }
    }

    if (input.hasOpenSessionConnection(cacheKey, input.wsUrl)) {
      return {
        available: true,
        sessionId: cacheKey,
        source: "cache_key",
      }
    }

    return { available: false }
  }

  pruneRuntimeState(): void {
    this.runtimeCache.prune()
  }

  getOrCreateContext(
    input: CodexGetOrCreateTurnContextInput
  ): CodexTurnContext {
    const conversationId = this.requireConversationId(input.conversationId)
    const turnKey =
      input.turnKey === undefined
        ? undefined
        : requireExactDurableIdentifier(input.turnKey, "Codex turn key")
    this.sessions.getOrCreate(conversationId)

    const existing = this.sessions.getActive(conversationId)
    if (existing) {
      if (existing.turnKey === turnKey) {
        return existing
      }

      return reuseCodexActiveTurnContext(existing, conversationId, turnKey)
    }

    const cacheKey = this.buildWsCacheKey({
      slotKey: input.slotKey,
      modelName: input.modelName,
      conversationId,
    })
    const globalCacheKey = this.buildWsCacheKey({
      slotKey: input.slotKey,
      modelName: input.modelName,
    })
    const takenCache = this.runtimeCache.takeConversationWsWithGlobalFallback(
      cacheKey,
      globalCacheKey
    )
    const context = createCodexTurnContext({
      conversationId,
      turnKey,
      takenCache,
      reuseCachedLogicalSession: takenCache?.cacheKey === cacheKey,
    })

    this.sessions.setActive(conversationId, context)
    return context
  }

  disposeContext(input: CodexTurnContextCacheScope): void {
    const conversationId = this.requireOptionalConversationId(
      input.conversationId
    )
    if (conversationId === undefined) return

    const context = this.sessions.getActive(conversationId)
    if (!context) return

    this.runtimeCache.setWs(
      this.buildWsCacheKey({
        slotKey: input.slotKey,
        modelName: input.modelName,
        conversationId,
      }),
      codexTurnContextToCachedWsEntry(context, this.now())
    )
    this.sessions.clearActive(conversationId)
  }

  /**
   * Build a request-local continuation receipt. This does not mutate the
   * active context; the caller publishes it through `commitPreparedRequest`
   * only after its physical provider lifecycle has accepted.
   */
  planRequest(
    request: Record<string, unknown>,
    context: CodexTurnContext,
    allowEmptyDelta: boolean = true
  ): CodexPreparedTurnRequest {
    return planCodexTurnStateRequest(request, context, allowEmptyDelta)
  }

  planFullRequest(
    request: Record<string, unknown>,
    context: CodexTurnContext
  ): CodexPreparedTurnRequest {
    return planCodexFullTurnStateRequest(request, context)
  }

  commitPreparedRequest(
    context: CodexTurnContext,
    prepared: CodexPreparedTurnRequest
  ): void {
    commitCodexTurnStateRequest(context, prepared)
  }

  captureResponseForContext(
    context: CodexTurnContext,
    responseId: string,
    itemsAdded: CodexInputItem[]
  ): void {
    captureCodexTurnResponse(
      context,
      requireExactDurableIdentifier(responseId, "Codex response id"),
      itemsAdded
    )
  }

  beginFullResponseChain(
    context: CodexTurnContext | undefined,
    request: Record<string, unknown>
  ): string | undefined {
    return context ? startCodexFullResponseChain(context, request) : undefined
  }

  clearContinuationBaseline(
    input: CodexClearContinuationBaselineInput
  ): CodexClearContinuationBaselineResult {
    const conversationId = this.requireOptionalConversationId(
      input.conversationId
    )
    const modelName = input.modelName
    if (conversationId === undefined) {
      return {
        conversationId: undefined,
        modelName,
        resetCount: 0,
        discardedPreviousResponseId: undefined,
      }
    }

    let resetCount = 0
    let discardedPreviousResponseId: string | undefined
    const activeContext = this.sessions.getActive(conversationId)
    if (activeContext) {
      const hadContinuationBaseline =
        !!activeContext.lastRequest || !!activeContext.lastResponse
      discardedPreviousResponseId =
        resetCodexTurnContinuationState(activeContext)
      activeContext.connectionReused = false
      this.sessions.touch(conversationId)
      if (hadContinuationBaseline) {
        resetCount++
      }
    }

    const hasExactCacheScope =
      modelName !== undefined && (input.slotKeys?.length ?? 0) > 0
    if (hasExactCacheScope) {
      for (const slotKey of input.slotKeys ?? []) {
        const cacheKey = this.buildWsCacheKey({
          slotKey,
          modelName,
          conversationId,
        })
        const cached = this.runtimeCache.getWs(cacheKey)
        if (!cached) {
          continue
        }
        const hadContinuationBaseline =
          !!cached.lastRequest || !!cached.lastResponse
        if (!hadContinuationBaseline) {
          continue
        }
        discardedPreviousResponseId =
          discardedPreviousResponseId || cached.lastResponse?.responseId
        this.runtimeCache.setWs(cacheKey, {
          ...cached,
          lastRequest: undefined,
          lastResponse: undefined,
          updatedAt: this.now(),
        })
        resetCount++
      }
    } else {
      const cleared = this.runtimeCache.clearWsBaselinesByConversationHash(
        hashCodexIdentityPart(conversationId)
      )
      discardedPreviousResponseId =
        discardedPreviousResponseId || cleared.discardedPreviousResponseId
      resetCount += cleared.clearedCount
    }

    return {
      conversationId,
      modelName,
      resetCount,
      discardedPreviousResponseId,
    }
  }

  resetContinuationState(
    input: CodexResetContinuationInput
  ): CodexResetContinuationResult {
    const conversationId = this.requireOptionalConversationId(
      input.conversationId
    )
    if (conversationId === undefined) {
      return {
        conversationId: undefined,
        modelName: input.modelName,
        resetCount: 0,
        discardedActivePreviousResponseId: undefined,
      }
    }

    let resetCount = 0
    let discardedActivePreviousResponseId: string | undefined
    const activeContext = this.sessions.getActive(conversationId)
    if (activeContext) {
      discardedActivePreviousResponseId =
        resetCodexTurnContinuationState(activeContext)
      this.closeWsSession(activeContext.wsSessionId)
      this.sessions.clearActive(conversationId)
      resetCount++
    }

    const modelName = input.modelName
    const hasExactCacheScope =
      modelName !== undefined && (input.slotKeys?.length ?? 0) > 0
    if (hasExactCacheScope) {
      for (const slotKey of input.slotKeys ?? []) {
        const cached = this.runtimeCache.deleteWs(
          this.buildWsCacheKey({
            slotKey,
            modelName,
            conversationId,
          })
        )
        if (!cached) {
          continue
        }
        this.closeWsSession(cached.wsSessionId)
        resetCount++
      }
    } else {
      for (const entry of this.runtimeCache.takeWsEntriesByConversationHash(
        hashCodexIdentityPart(conversationId)
      )) {
        this.closeWsSession(entry.wsSessionId)
        resetCount++
      }
    }

    return {
      conversationId,
      modelName,
      resetCount,
      discardedActivePreviousResponseId,
    }
  }

  hasContinuationState(
    conversationId: string,
    scope?: Omit<CodexTurnContextCacheScope, "conversationId">
  ): boolean {
    const exactConversationId = this.requireConversationId(conversationId)

    if (
      hasCodexTurnContinuationState(
        this.sessions.getActive(exactConversationId)
      )
    ) {
      return true
    }

    if (!scope) {
      return false
    }

    return hasCodexTurnContinuationState(
      this.runtimeCache.getWs(
        this.buildWsCacheKey({
          slotKey: scope.slotKey,
          modelName: scope.modelName,
          conversationId: exactConversationId,
        })
      )
    )
  }

  acquireStreamLock(conversationId: string): Promise<() => void> {
    return this.sessions.acquireStreamLock(
      this.requireConversationId(conversationId)
    )
  }

  clearActiveContext(conversationId: string): void {
    this.sessions.clearActive(this.requireConversationId(conversationId))
  }

  deleteConversation(conversationId: string): void {
    const exactConversationId = this.requireConversationId(conversationId)

    const activeContext = this.sessions.getActive(exactConversationId)
    if (activeContext) {
      this.closeWsSession(activeContext.wsSessionId)
    }
    this.sessions.delete(exactConversationId)
    for (const entry of this.runtimeCache.takeWsEntriesByConversationHash(
      hashCodexIdentityPart(exactConversationId)
    )) {
      this.closeWsSession(entry.wsSessionId)
    }
    this.deleteHttpFallbackTransports(exactConversationId)
  }

  private requireConversationId(conversationId: string): string {
    return requireExactDurableIdentifier(
      conversationId,
      "Codex conversation id"
    )
  }

  private requireOptionalConversationId(
    conversationId: string | undefined
  ): string | undefined {
    return conversationId === undefined
      ? undefined
      : this.requireConversationId(conversationId)
  }

  private buildHttpFallbackTransportKey(
    input: Omit<CodexTurnContextCacheScope, "conversationId"> & {
      conversationId: string
    }
  ): string {
    return this.buildWsCacheKey({
      conversationId: this.requireConversationId(input.conversationId),
      slotKey: input.slotKey,
      modelName: input.modelName,
    })
  }

  private deleteHttpFallbackTransports(conversationId: string): void {
    const suffix = `:conversation:${hashCodexIdentityPart(conversationId)}`
    for (const key of Array.from(this.httpFallbackTransports)) {
      if (key.endsWith(suffix)) {
        this.httpFallbackTransports.delete(key)
        this.httpFallbackTransportOptions.delete(key)
      }
    }
  }
}
