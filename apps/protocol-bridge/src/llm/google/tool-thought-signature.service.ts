import { Injectable, Logger } from "@nestjs/common"
import * as fs from "fs"
import * as path from "path"
import {
  getAgentVibesHome,
  ensureAgentVibesDirs,
} from "../../shared/agent-vibes-paths"

/**
 * ToolThoughtSignatureStore - Cross-turn signature cache
 *
 * The Thought Signatures protocol requires that if a model response contains
 * thoughtSignature, the next request must return it to the corresponding part.
 *
 * However, Claude Code does not return `tool_use.signature` (non-standard field),
 * so we need to maintain a tool_use.id -> thoughtSignature mapping within the proxy
 * and fill it back when converting to v1internal.
 */
@Injectable()
export class ToolThoughtSignatureService {
  private readonly logger = new Logger(ToolThoughtSignatureService.name)

  // TTL configuration
  private readonly TTL_DAYS = 21
  private readonly TTL_MS = this.TTL_DAYS * 24 * 60 * 60 * 1000
  private readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

  // In-memory cache: tool_use.id -> { sig, expiresAt, createdAt, updatedAt }
  private readonly signatures = new Map<
    string,
    {
      sig: string
      expiresAt: number
      createdAt: number
      updatedAt: number
    }
  >()

  // Cache file path
  private readonly cacheFilePath: string

  // Last cleanup timestamp
  private lastCleanupAt = 0

  // Loaded from disk flag
  private loadedFromDisk = false

  constructor() {
    ensureAgentVibesDirs()
    const storageDir = getAgentVibesHome()
    this.cacheFilePath = path.join(storageDir, "tool-thought-signatures.json")
    this.loadFromDisk()
  }

  /**
   * Load signatures from disk on startup
   */
  private loadFromDisk(): void {
    if (this.loadedFromDisk) return
    this.loadedFromDisk = true

    try {
      if (!fs.existsSync(this.cacheFilePath)) return

      const raw = fs.readFileSync(this.cacheFilePath, "utf8")
      const parsed = JSON.parse(raw) as Record<string, unknown>

      if (!parsed || typeof parsed !== "object") return

      const now = Date.now()
      let needsPersist = false

      for (const [id, entry] of Object.entries(parsed)) {
        if (!id) continue

        let sig: string | null = null
        let expiresAt: number | null = null
        let createdAt: number | null = null
        let updatedAt: number | null = null

        if (typeof entry === "string") {
          sig = entry
          needsPersist = true
        } else if (entry && typeof entry === "object") {
          const e = entry as Record<string, unknown>
          if (typeof e.sig === "string") sig = e.sig
          if (typeof e.expiresAt === "number") expiresAt = e.expiresAt
          if (typeof e.createdAt === "number") createdAt = e.createdAt
          if (typeof e.updatedAt === "number") updatedAt = e.updatedAt
        }

        if (!sig) {
          needsPersist = true
          continue
        }

        if (expiresAt === null) {
          expiresAt = now + this.TTL_MS
          needsPersist = true
        }

        if (expiresAt <= now) {
          needsPersist = true
          continue
        }

        if (createdAt === null) {
          createdAt = now
          needsPersist = true
        }

        if (updatedAt === null) {
          updatedAt = createdAt
          needsPersist = true
        }

        this.signatures.set(id, { sig, expiresAt, createdAt, updatedAt })
      }

      if (needsPersist) {
        this.persistToDisk()
      }

      this.logger.log(
        `Loaded ${this.signatures.size} tool thought signatures from disk`
      )
    } catch {
      // Ignore load errors
    }
  }

  /**
   * Persist signatures to disk
   */
  private persistToDisk(): void {
    if (this.signatures.size === 0) {
      try {
        if (fs.existsSync(this.cacheFilePath)) {
          fs.unlinkSync(this.cacheFilePath)
        }
      } catch {
        // Ignore delete errors
      }
      return
    }

    const out: Record<
      string,
      { sig: string; expiresAt: number; createdAt: number; updatedAt: number }
    > = {}

    for (const [id, entry] of this.signatures.entries()) {
      if (!id || !entry.sig) continue
      out[id] = {
        sig: entry.sig,
        expiresAt: entry.expiresAt,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }
    }

    const content = JSON.stringify(out, null, 2)
    const tmpPath = `${this.cacheFilePath}.tmp`

    try {
      fs.writeFileSync(tmpPath, content, "utf8")
      fs.renameSync(tmpPath, this.cacheFilePath)
    } catch {
      try {
        fs.unlinkSync(tmpPath)
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Cleanup expired signatures
   */
  private cleanup(): void {
    const now = Date.now()
    if (now - this.lastCleanupAt < this.CLEANUP_INTERVAL_MS) return
    this.lastCleanupAt = now

    let changed = false
    for (const [id, entry] of this.signatures.entries()) {
      if (entry.expiresAt <= now) {
        this.signatures.delete(id)
        changed = true
      }
    }

    if (changed) {
      this.persistToDisk()
    }
  }

  /**
   * Remember a tool_use.id -> thoughtSignature mapping
   */
  remember(toolUseId: string, thoughtSignature: string): void {
    if (!toolUseId || !thoughtSignature) return

    this.cleanup()

    const id = String(toolUseId)
    const sig = String(thoughtSignature)
    const now = Date.now()

    const prev = this.signatures.get(id)
    const createdAt = prev?.createdAt || now

    this.signatures.set(id, {
      sig,
      createdAt,
      updatedAt: now,
      expiresAt: now + this.TTL_MS,
    })

    this.persistToDisk()
    this.logger.debug(
      `Cached tool thought signature: ${id} (len=${sig.length})`
    )
  }

  /**
   * Get thoughtSignature for a tool_use.id
   */
  get(toolUseId: string): string | null {
    if (!toolUseId) return null

    this.cleanup()

    const id = String(toolUseId)
    const entry = this.signatures.get(id)

    if (!entry) return null

    if (entry.expiresAt <= Date.now()) {
      this.signatures.delete(id)
      this.persistToDisk()
      return null
    }

    return entry.sig
  }

  /**
   * Delete a tool_use.id -> thoughtSignature mapping
   */
  delete(toolUseId: string): void {
    if (!toolUseId) return

    this.cleanup()

    const id = String(toolUseId)
    if (!this.signatures.has(id)) return

    this.signatures.delete(id)
    this.persistToDisk()
    this.logger.debug(`Deleted tool thought signature: ${id}`)
  }

  /**
   * Check if a signature exists for a tool_use.id
   */
  has(toolUseId: string): boolean {
    return this.get(toolUseId) !== null
  }
}
