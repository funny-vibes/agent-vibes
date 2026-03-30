import Database from "better-sqlite3"
import * as fs from "fs"
import * as path from "path"

export const BACKEND_ACCOUNT_STATE_DB_FILENAME = "backend-account-state.db"

export type BackendAccountStateNamespace = "claude-api" | "openai-compat"

export interface PersistedBackendAccountModelState {
  model: string
  cooldownUntil: number
  quotaExhausted: boolean
  backoffLevel: number
}

export interface PersistedBackendAccountState {
  stateKey: string
  label?: string
  cooldownUntil?: number
  modelStates?: PersistedBackendAccountModelState[]
  disabledAt?: number
  disabledReason?: string
  disabledStatusCode?: number
  disabledMessage?: string
  updatedAt: number
}

interface PersistedBackendAccountStateFile {
  version?: number
  accounts?: PersistedBackendAccountState[]
}

interface StoreLogger {
  log(message: string): void
  warn(message: string): void
}

export class BackendAccountStateStore {
  private db: Database.Database | null = null

  constructor(
    private readonly dbPath: string,
    private readonly logger: StoreLogger
  ) {}

  loadStates(
    backend: BackendAccountStateNamespace,
    legacyJsonPath?: string | null
  ): Map<string, PersistedBackendAccountState> {
    this.migrateLegacyJsonIfNeeded(backend, legacyJsonPath)

    const result = new Map<string, PersistedBackendAccountState>()
    try {
      const rows = this.getDb()
        .prepare(
          `SELECT state_key, state_json
           FROM backend_account_states
           WHERE backend = ?
           ORDER BY updated_at ASC`
        )
        .all(backend) as Array<{ state_key: string; state_json: string }>

      for (const row of rows) {
        try {
          const parsed = JSON.parse(
            row.state_json
          ) as PersistedBackendAccountState
          if (!parsed?.stateKey || parsed.stateKey !== row.state_key) {
            continue
          }
          result.set(parsed.stateKey, parsed)
        } catch (error) {
          this.logger.warn(
            `Failed to parse persisted ${backend} account state row ${row.state_key}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    } catch (error) {
      this.logger.warn(
        `Failed to load ${backend} account state from ${this.dbPath}: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    return result
  }

  replaceStates(
    backend: BackendAccountStateNamespace,
    states: PersistedBackendAccountState[]
  ): void {
    try {
      const db = this.getDb()
      const write = db.transaction(
        (
          backendName: BackendAccountStateNamespace,
          records: PersistedBackendAccountState[]
        ) => {
          db.prepare(
            `DELETE FROM backend_account_states
             WHERE backend = ?`
          ).run(backendName)

          if (records.length === 0) {
            return
          }

          const insert = db.prepare(
            `INSERT INTO backend_account_states (
               backend,
               state_key,
               updated_at,
               state_json
             ) VALUES (?, ?, ?, ?)`
          )

          for (const record of records) {
            insert.run(
              backendName,
              record.stateKey,
              record.updatedAt,
              JSON.stringify(record)
            )
          }
        }
      )

      write(backend, states)
    } catch (error) {
      this.logger.warn(
        `Failed to persist ${backend} account state to ${this.dbPath}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private migrateLegacyJsonIfNeeded(
    backend: BackendAccountStateNamespace,
    legacyJsonPath?: string | null
  ): void {
    if (!legacyJsonPath || !fs.existsSync(legacyJsonPath)) {
      return
    }

    try {
      const db = this.getDb()
      const existing = db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM backend_account_states
           WHERE backend = ?`
        )
        .get(backend) as { count?: number } | undefined

      if ((existing?.count ?? 0) > 0) {
        return
      }

      const parsed = JSON.parse(
        fs.readFileSync(legacyJsonPath, "utf8")
      ) as PersistedBackendAccountStateFile
      const entries = Array.isArray(parsed.accounts)
        ? parsed.accounts.filter(
            (entry): entry is PersistedBackendAccountState =>
              !!entry &&
              typeof entry.stateKey === "string" &&
              entry.stateKey.length > 0
          )
        : []

      if (entries.length === 0) {
        return
      }

      this.replaceStates(backend, entries)
      this.logger.log(
        `Migrated ${entries.length} ${backend} account state record(s) from ${legacyJsonPath} to ${this.dbPath}`
      )
    } catch (error) {
      this.logger.warn(
        `Failed to migrate legacy ${backend} account state from ${legacyJsonPath}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private getDb(): Database.Database {
    if (this.db) {
      return this.db
    }

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true })
    const db = new Database(this.dbPath)
    db.pragma("journal_mode = WAL")
    db.exec(`
      CREATE TABLE IF NOT EXISTS backend_account_states (
        backend TEXT NOT NULL,
        state_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        PRIMARY KEY (backend, state_key)
      );

      CREATE INDEX IF NOT EXISTS idx_backend_account_states_backend_updated
        ON backend_account_states(backend, updated_at);
    `)

    this.db = db
    return db
  }
}
