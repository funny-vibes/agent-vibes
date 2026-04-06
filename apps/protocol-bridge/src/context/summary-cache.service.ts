import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common"
import * as crypto from "crypto"
import { PersistenceService } from "../persistence"
import { TokenCounterService } from "./token-counter.service"
import { UnifiedMessage, extractText } from "./types"

/**
 * Cached summary record
 */
interface CachedSummary {
  hash: string
  summary_text: string
  token_count: number
  message_count: number
  created_at: number
}

/**
 * Summary Cache Service
 *
 * Lightweight caching for conversation summaries.
 * Key insight: We cache based on the TRUNCATED messages' content hash,
 * not session ID. This works because:
 * 1. Cursor sends full history each time
 * 2. Same truncated portion = same summary needed
 * 3. No need to store original messages
 */
@Injectable()
export class SummaryCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SummaryCacheService.name)

  constructor(
    private readonly tokenCounter: TokenCounterService,
    private readonly persistence: PersistenceService
  ) {}

  onModuleInit() {
    // Cleanup old entries (older than 7 days)
    this.cleanupOldEntries(7)
    this.logger.log("Summary cache initialized")
  }

  onModuleDestroy() {
    // PersistenceService handles DB cleanup
  }

  /**
   * Generate hash for truncated messages
   */
  generateHash(messages: UnifiedMessage[]): string {
    const content = messages
      .map((m) => {
        const text = extractText(m.content)
        return `${m.role}:${text.slice(0, 200)}`
      })
      .join("|")

    return crypto
      .createHash("sha256")
      .update(content)
      .digest("hex")
      .slice(0, 32)
  }

  /**
   * Get cached summary for truncated messages
   */
  getCachedSummary(truncatedMessages: UnifiedMessage[]): CachedSummary | null {
    const hash = this.generateHash(truncatedMessages)

    try {
      const row = this.persistence
        .prepare(
          `SELECT hash, summary_text, token_count, message_count, created_at
           FROM summaries WHERE hash = ?`
        )
        .get(hash) as CachedSummary | undefined

      if (row) {
        // Update last_used_at
        this.persistence
          .prepare(`UPDATE summaries SET last_used_at = ? WHERE hash = ?`)
          .run(Date.now(), hash)

        this.logger.debug(`Cache hit for summary: ${hash.slice(0, 8)}...`)
        return row
      }

      return null
    } catch (error) {
      this.logger.error(`Failed to get cached summary: ${String(error)}`)
      return null
    }
  }

  /**
   * Store summary in cache
   */
  storeSummary(truncatedMessages: UnifiedMessage[], summaryText: string): void {
    const hash = this.generateHash(truncatedMessages)
    const tokenCount = this.tokenCounter.countText(summaryText)
    const now = Date.now()

    try {
      this.persistence
        .prepare(
          `INSERT OR REPLACE INTO summaries
           (hash, summary_text, token_count, message_count, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(hash, summaryText, tokenCount, truncatedMessages.length, now, now)

      this.logger.debug(
        `Cached summary: ${hash.slice(0, 8)}... (${tokenCount} tokens, ${truncatedMessages.length} messages)`
      )
    } catch (error) {
      this.logger.error(`Failed to store summary: ${String(error)}`)
    }
  }

  /**
   * Cleanup old cache entries
   */
  private cleanupOldEntries(daysToKeep: number): void {
    if (!this.persistence.isReady) return
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000

    try {
      const result = this.persistence
        .prepare(`DELETE FROM summaries WHERE last_used_at < ?`)
        .run(cutoffTime)

      if (result.changes > 0) {
        this.logger.log(
          `Cleaned up ${result.changes} old summary cache entries`
        )
      }
    } catch (error) {
      this.logger.error(`Failed to cleanup old entries: ${String(error)}`)
    }
  }

  /**
   * Get cache stats
   */
  getStats(): { totalEntries: number; totalTokens: number } {
    try {
      const row = this.persistence
        .prepare(
          `SELECT COUNT(*) as count, COALESCE(SUM(token_count), 0) as tokens FROM summaries`
        )
        .get() as { count: number; tokens: number }

      return { totalEntries: row.count, totalTokens: row.tokens }
    } catch {
      return { totalEntries: 0, totalTokens: 0 }
    }
  }
}
