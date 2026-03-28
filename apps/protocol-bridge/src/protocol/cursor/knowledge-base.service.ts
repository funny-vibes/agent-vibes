import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common"
import Database from "better-sqlite3"
import * as fs from "fs"
import * as path from "path"
import { randomUUID } from "crypto"

export interface KnowledgeBaseItem {
  id: string
  knowledge: string
  title: string
  createdAt: string
  isGenerated: boolean
}

@Injectable()
export class KnowledgeBaseService implements OnModuleDestroy {
  private readonly logger = new Logger(KnowledgeBaseService.name)
  private readonly dbPath: string
  private db: Database.Database | null = null

  constructor() {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp"
    const dataDir = path.join(homeDir, ".protocol-bridge")
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
    this.dbPath = path.join(dataDir, "knowledge-base.db")
    this.initDatabase()
  }

  onModuleDestroy(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  private initDatabase(): void {
    try {
      this.db = new Database(this.dbPath)
      this.db.pragma("journal_mode = WAL")
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_base (
          id TEXT PRIMARY KEY,
          knowledge TEXT NOT NULL,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL,
          is_generated INTEGER NOT NULL DEFAULT 0
        );
      `)
      this.logger.log(
        `Knowledge Base persistence initialized at ${this.dbPath}`
      )
    } catch (error) {
      this.logger.error(
        `Failed to initialize knowledge base persistence: ${String(error)}`
      )
      this.db = null
    }
  }

  list(): KnowledgeBaseItem[] {
    if (!this.db) return []
    try {
      const rows = this.db
        .prepare("SELECT * FROM knowledge_base ORDER BY created_at DESC")
        .all() as any[]
      return rows.map((row) => ({
        id: row.id,
        knowledge: row.knowledge,
        title: row.title,
        createdAt: row.created_at,
        isGenerated: Boolean(row.is_generated),
      }))
    } catch (error) {
      this.logger.error(`Failed to list knowledge base items: ${String(error)}`)
      return []
    }
  }

  get(id: string): KnowledgeBaseItem | null {
    if (!this.db) return null
    try {
      const row = this.db
        .prepare("SELECT * FROM knowledge_base WHERE id = ?")
        .get(id) as any
      if (!row) return null
      return {
        id: row.id,
        knowledge: row.knowledge,
        title: row.title,
        createdAt: row.created_at,
        isGenerated: Boolean(row.is_generated),
      }
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
    if (!this.db) return null
    try {
      const id = randomUUID()
      const createdAt = new Date().toISOString()

      this.db
        .prepare(
          `INSERT INTO knowledge_base (id, knowledge, title, created_at, is_generated)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(id, knowledge, title, createdAt, isGenerated ? 1 : 0)

      return {
        id,
        knowledge,
        title,
        createdAt,
        isGenerated,
      }
    } catch (error) {
      this.logger.error(`Failed to add knowledge base item: ${String(error)}`)
      return null
    }
  }

  update(id: string, knowledge: string, title: string): boolean {
    if (!this.db) return false
    try {
      const result = this.db
        .prepare(
          `UPDATE knowledge_base
           SET knowledge = ?, title = ?
           WHERE id = ?`
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
    if (!this.db) return false
    try {
      const result = this.db
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
