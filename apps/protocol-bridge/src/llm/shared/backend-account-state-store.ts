import { PersistenceService } from "../../persistence"

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

interface StoreLogger {
  log(message: string): void
  warn(message: string): void
}

export class BackendAccountStateStore {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly logger: StoreLogger
  ) {}

  loadStates(
    backend: BackendAccountStateNamespace
  ): Map<string, PersistedBackendAccountState> {
    const result = new Map<string, PersistedBackendAccountState>()
    try {
      const rows = this.persistence
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
        `Failed to load ${backend} account state: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    return result
  }

  replaceStates(
    backend: BackendAccountStateNamespace,
    states: PersistedBackendAccountState[]
  ): void {
    try {
      this.persistence.runInTransaction(() => {
        this.persistence
          .prepare(`DELETE FROM backend_account_states WHERE backend = ?`)
          .run(backend)

        if (states.length === 0) {
          return
        }

        const insert = this.persistence.prepare(
          `INSERT INTO backend_account_states (backend, state_key, updated_at, state_json)
           VALUES (?, ?, ?, ?)`
        )

        for (const record of states) {
          insert.run(
            backend,
            record.stateKey,
            record.updatedAt,
            JSON.stringify(record)
          )
        }
      })
    } catch (error) {
      this.logger.warn(
        `Failed to persist ${backend} account state: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}
