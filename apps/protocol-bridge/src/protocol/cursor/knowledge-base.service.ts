import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common"
import { randomUUID } from "crypto"
import { PersistenceService } from "../../persistence"

export interface KnowledgeBaseItem {
  id: string
  knowledge: string
  title: string
  createdAt: string
  isGenerated: boolean
}

interface KnowledgeBaseRow {
  id: string
  knowledge: string
  title: string
  created_at: string
  is_generated: number
}

@Injectable()
export class KnowledgeBaseService implements OnModuleDestroy {
  private readonly logger = new Logger(KnowledgeBaseService.name)

  constructor(private readonly persistence: PersistenceService) {
    this.logger.log("Knowledge Base service initialized")
  }

  onModuleDestroy(): void {
    // PersistenceService handles DB cleanup
  }

  private toKnowledgeBaseItem(row: KnowledgeBaseRow): KnowledgeBaseItem {
    return {
      id: row.id,
      knowledge: row.knowledge,
      title: row.title,
      createdAt: row.created_at,
      isGenerated: Boolean(row.is_generated),
    }
  }

  list(): KnowledgeBaseItem[] {
    try {
      const rows = this.persistence
        .prepare("SELECT * FROM knowledge_base ORDER BY created_at DESC")
        .all() as unknown as KnowledgeBaseRow[]
      return rows.map((row) => this.toKnowledgeBaseItem(row))
    } catch (error) {
      this.logger.error(`Failed to list knowledge base items: ${String(error)}`)
      return []
    }
  }

  get(id: string): KnowledgeBaseItem | null {
    try {
      const row = this.persistence
        .prepare("SELECT * FROM knowledge_base WHERE id = ?")
        .get(id) as KnowledgeBaseRow | undefined
      if (!row) return null
      return this.toKnowledgeBaseItem(row)
    } catch (error) {
      this.logger.error(
        `Failed to get knowledge base item ${id}: ${String(error)}`
      )
      return null
    }
  }

  add(
    knowledge: string,
    title: string,
    isGenerated: boolean = false
  ): KnowledgeBaseItem | null {
    try {
      // Deduplicate: if an item with identical knowledge content already exists,
      // return the existing item instead of creating a duplicate.
      // This prevents rule accumulation across Cursor restarts where the IDE
      // may re-sync items from the official server before the proxy takes over.
      const existing = this.persistence
        .prepare("SELECT * FROM knowledge_base WHERE knowledge = ? LIMIT 1")
        .get(knowledge) as KnowledgeBaseRow | undefined
      if (existing) {
        this.logger.debug(
          `Knowledge base item already exists (id=${existing.id}), skipping duplicate add`
        )
        return this.toKnowledgeBaseItem(existing)
      }

      const id = randomUUID()
      const createdAt = new Date().toISOString()

      this.persistence
        .prepare(
          `INSERT INTO knowledge_base (id, knowledge, title, created_at, is_generated)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(id, knowledge, title, createdAt, isGenerated ? 1 : 0)

      return { id, knowledge, title, createdAt, isGenerated }
    } catch (error) {
      this.logger.error(`Failed to add knowledge base item: ${String(error)}`)
      return null
    }
  }

  update(id: string, knowledge: string, title: string): boolean {
    try {
      const result = this.persistence
        .prepare(
          `UPDATE knowledge_base SET knowledge = ?, title = ? WHERE id = ?`
        )
        .run(knowledge, title, id)

      return result.changes > 0
    } catch (error) {
      this.logger.error(
        `Failed to update knowledge base item ${id}: ${String(error)}`
      )
      return false
    }
  }

  remove(id: string): boolean {
    try {
      const result = this.persistence
        .prepare("DELETE FROM knowledge_base WHERE id = ?")
        .run(id)

      return result.changes > 0
    } catch (error) {
      this.logger.error(
        `Failed to remove knowledge base item ${id}: ${String(error)}`
      )
      return false
    }
  }
}
