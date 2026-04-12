import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common"
import { DatabaseSync } from "node:sqlite"
import * as fs from "fs"
import * as path from "path"
import {
  getAgentVibesPgDataDir,
  getAgentVibesAccountsDir,
  ensureAgentVibesDirs,
} from "../shared/agent-vibes-paths"
import { resolveProtocolBridgePath } from "../shared/protocol-bridge-paths"

const DB_FILENAME = "agent-vibes.db"

/**
 * Unified persistence layer powered by node:sqlite (built-in).
 *
 * Uses Node.js 24+ built-in SQLite module — zero native addon dependencies.
 * This makes SEA (Single Executable Application) packaging straightforward.
 *
 * Architecture benefits:
 * - Single DB connection, single WAL journal
 * - Version-controlled schema migrations
 * - Unified data directory: ~/.agent-vibes/
 * - All services share one PersistenceService via NestJS DI
 * - Zero native C++ addon — SEA-compatible
 */
@Injectable()
export class PersistenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PersistenceService.name)
  private db: DatabaseSync | null = null

  get database(): DatabaseSync {
    if (!this.db) {
      throw new Error("Database is not initialized. Call onModuleInit() first.")
    }
    return this.db
  }

  get isReady(): boolean {
    return this.db !== null
  }

  onModuleInit(): void {
    ensureAgentVibesDirs()
    const dataDir = getAgentVibesPgDataDir()
    const dbPath = path.join(dataDir, DB_FILENAME)

    this.logger.log(`Initializing SQLite at ${dbPath}`)
    this.db = new DatabaseSync(dbPath)
    this.db.exec("PRAGMA journal_mode = WAL")

    this.runMigrations()
    this.migrateAccountConfigs()
    this.logger.log("Persistence initialized successfully")
  }

  onModuleDestroy(): void {
    if (this.db) {
      this.db.close()
      this.db = null
      this.logger.log("Database connection closed")
    }
  }

  /**
   * Prepare a SQL statement.
   * Returns a StatementSync compatible with better-sqlite3's .get()/.all()/.run() API.
   */
  prepare(sql: string) {
    return this.database.prepare(sql)
  }

  /**
   * Execute raw SQL (for DDL / multi-statement operations).
   */
  exec(sql: string): void {
    this.database.exec(sql)
  }

  /**
   * Run a function within a transaction.
   * Manually wraps with BEGIN/COMMIT/ROLLBACK since node:sqlite
   * doesn't have a .transaction() helper like better-sqlite3.
   */
  runInTransaction<T>(fn: () => T): T {
    this.database.exec("BEGIN")
    try {
      const result = fn()
      this.database.exec("COMMIT")
      return result
    } catch (err) {
      this.database.exec("ROLLBACK")
      throw err
    }
  }

  // ── Migration System ────────────────────────────────────────────────

  private runMigrations(): void {
    // Ensure migrations tracking table exists
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    // Load migration files (SEA mode uses extracted assets, normal mode uses __dirname)
    const migrationsDir =
      process.env.SEA_MIGRATIONS_DIR || path.join(__dirname, "migrations")
    if (!fs.existsSync(migrationsDir)) {
      this.logger.warn(`Migrations directory not found: ${migrationsDir}`)
      return
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()

    // Get already-applied migrations
    const applied = this.database
      .prepare("SELECT name FROM _migrations ORDER BY id")
      .all() as unknown as Array<{ name: string }>
    const appliedSet = new Set(applied.map((r) => r.name))

    // Apply pending migrations in a transaction
    for (const file of files) {
      if (appliedSet.has(file)) continue

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8")
      this.logger.log(`Applying migration: ${file}`)

      this.runInTransaction(() => {
        this.database.exec(sql)
        this.database
          .prepare("INSERT INTO _migrations (name) VALUES (?)")
          .run(file)
      })

      this.logger.log(`Migration applied: ${file}`)
    }
  }

  /**
   * Auto-migrate account config files from the dev directory
   * (apps/protocol-bridge/data/) to the unified ~/.agent-vibes/data/.
   * Only copies if the target file does NOT already exist (safe first-run migration).
   */
  private migrateAccountConfigs(): void {
    const ACCOUNT_FILES = [
      "antigravity-accounts.json",
      "claude-api-accounts.json",
      "codex-accounts.json",
      "openai-compat-accounts.json",
    ]

    const targetDir = getAgentVibesAccountsDir()

    for (const filename of ACCOUNT_FILES) {
      const targetPath = path.join(targetDir, filename)
      if (fs.existsSync(targetPath)) {
        continue // already migrated or user-created
      }

      // Try to find source in dev data directory
      try {
        const sourcePath = resolveProtocolBridgePath("data", filename)
        if (fs.existsSync(sourcePath)) {
          fs.copyFileSync(sourcePath, targetPath)
          this.logger.log(`Migrated ${filename} → ${targetPath}`)
        }
      } catch {
        // Dev directory not available (e.g. SEA mode) — skip silently
      }
    }
  }
}
