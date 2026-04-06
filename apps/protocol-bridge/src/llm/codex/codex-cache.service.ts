/**
 * Codex Prompt Cache Service
 *
 * Manages prompt cache keys for Codex upstream to enable prompt caching.
 * The Codex API supports prompt caching via Conversation_id and Session_id
 * headers, which allow the upstream to reuse cached prompt prefixes.
 *
 * Ported from CLIProxyAPI:
 *   - internal/runtime/executor/cache_helpers.go
 *   - internal/runtime/executor/codex_executor.go (cacheHelper)
 *   - internal/runtime/executor/codex_websockets_executor.go (applyCodexPromptCacheHeaders)
 */

import { Injectable, Logger } from "@nestjs/common"
import * as crypto from "crypto"

// ── Types ──────────────────────────────────────────────────────────────

interface CacheEntry {
  id: string
  expire: number // Unix timestamp in ms
}

// ── Service ────────────────────────────────────────────────────────────

@Injectable()
export class CodexCacheService {
  private readonly logger = new Logger(CodexCacheService.name)

  /** Cache map: key -> CacheEntry */
  private readonly cache = new Map<string, CacheEntry>()

  /** Default TTL: 1 hour */
  private readonly DEFAULT_TTL_MS = 60 * 60 * 1000

  /** Cleanup interval: 10 minutes */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    // Periodic cleanup of expired entries
    this.cleanupTimer = setInterval(() => this.cleanup(), 10 * 60 * 1000)
  }

  /**
   * Get or create a cache ID for a given model + user combination.
   * Ported from: codex_executor.go cacheHelper()
   */
  getOrCreateCacheId(model: string, userId?: string): string {
    if (!userId) {
      return this.generateCacheId()
    }

    const key = `${model}-${userId}`
    const existing = this.cache.get(key)

    if (existing && existing.expire > Date.now()) {
      return existing.id
    }

    const id = crypto.randomUUID()
    this.cache.set(key, {
      id,
      expire: Date.now() + this.DEFAULT_TTL_MS,
    })

    return id
  }

  /**
   * Generate a deterministic cache ID from an API key.
   * Used for OpenAI-format requests where we don't have a user ID.
   * Ported from: codex_executor.go cacheHelper() (openai branch)
   */
  getCacheIdFromApiKey(apiKey: string): string {
    if (!apiKey) return ""

    return this.buildDeterministicCacheId(
      `cli-proxy-api:codex:prompt-cache:${apiKey}`
    )
  }

  /**
   * Generate a deterministic cache ID from an arbitrary stable identity.
   * Useful for OAuth-backed flows where no API key is available but we still
   * want prompt cache reuse across related requests.
   */
  getCacheIdFromIdentity(identity: string): string {
    if (!identity) return ""

    return this.buildDeterministicCacheId(
      `cli-proxy-api:codex:prompt-cache:${identity}`
    )
  }

  private buildDeterministicCacheId(name: string): string {
    const namespace = "6ba7b812-9dad-11d1-80b4-00c04fd430c8" // UUID v5 OID namespace

    const hash = crypto
      .createHash("sha1")
      .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
      .update(name)
      .digest()

    hash[6] = (hash[6]! & 0x0f) | 0x50
    hash[8] = (hash[8]! & 0x3f) | 0x80

    const hex = hash.toString("hex").slice(0, 32)
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join("-")
  }

  /**
   * Generate a random cache ID.
   */
  private generateCacheId(): string {
    return crypto.randomUUID()
  }

  /**
   * Build prompt cache headers for Codex requests.
   * Returns headers to be added to the HTTP request.
   */
  buildHttpCacheHeaders(cacheId: string): Record<string, string> {
    if (!cacheId) return {}

    return {
      Session_id: cacheId,
    }
  }

  buildWebSocketCacheHeaders(cacheId: string): Record<string, string> {
    if (!cacheId) return {}

    return {
      Conversation_id: cacheId,
    }
  }

  /**
   * Inject prompt_cache_key into the request body.
   */
  injectCacheKey(
    body: Record<string, unknown>,
    cacheId: string
  ): Record<string, unknown> {
    if (!cacheId) return body
    return { ...body, prompt_cache_key: cacheId }
  }

  /**
   * Clean up expired cache entries.
   */
  private cleanup(): void {
    const now = Date.now()
    let removed = 0

    for (const [key, entry] of this.cache) {
      if (entry.expire <= now) {
        this.cache.delete(key)
        removed++
      }
    }

    if (removed > 0) {
      this.logger.debug(`Cleaned up ${removed} expired cache entries`)
    }
  }

  /**
   * Get current cache size (for monitoring).
   */
  getCacheSize(): number {
    return this.cache.size
  }

  /**
   * Clear all cache entries.
   */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * Destroy the service (cleanup timer).
   */
  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }
}
