import {
  Global,
  Injectable,
  Module,
  OnModuleInit,
  Optional,
} from "@nestjs/common"
import { PersistenceService } from "./persistence"

export type UsageBackend = "codex" | "google" | "openai-compat" | "claude-api"

export type UsageTransport = string

type UsageBucketState = {
  requests: number
  totalAttempts: number
  cachedRequests: number
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  outputTokens: number
  webSearchRequests: number
  error429Count: number
  error503Count: number
  totalDurationMs: number
  lastSeenAt: number | null
}

type UsageBucketSummary = {
  requests: number
  totalAttempts: number
  cachedRequests: number
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  totalContextTokens: number
  billableInputTokens: number
  outputTokens: number
  webSearchRequests: number
  error429Count: number
  error503Count: number
  error429Rate: number | null
  error503Rate: number | null
  totalDurationMs: number
  avgDurationMs: number | null
  cacheHitRate: number | null
  cacheReuseRate: number | null
  lastSeenAt: string | null
}

type AccountUsageBucketState = UsageBucketState & {
  label: string
}

type BackendUsageState = {
  totals: UsageBucketState
  transports: Map<string, UsageBucketState>
  models: Map<string, UsageBucketState>
  accounts: Map<string, AccountUsageBucketState>
}

type NormalizedUsageRecord = {
  backend: UsageBackend
  transport: string
  modelName: string
  accountKey: string
  accountLabel: string
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  outputTokens: number
  webSearchRequests: number
  error429Count: number
  error503Count: number
  durationMs: number
  recordedAt: number
}

type PersistedUsageEventRow = {
  backend: UsageBackend
  transport: string
  model_name: string
  account_key: string
  account_label: string
  input_tokens: number
  cached_input_tokens: number
  cache_creation_input_tokens: number
  output_tokens: number
  web_search_requests: number
  error_429_count: number
  error_503_count: number
  duration_ms: number
  recorded_at: number
}

type UsageRecentRecord = {
  backend: UsageBackend
  backendLabel: string
  transport: string
  model: string
  accountLabel: string
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  totalContextTokens: number
  billableInputTokens: number
  outputTokens: number
  webSearchRequests: number
  error429Count: number
  error503Count: number
  durationMs: number
  recordedAt: string
}

type BackendUsageSummary = {
  tracked: boolean
  label: string
  totals: UsageBucketSummary
  transports: Record<string, UsageBucketSummary>
  models: Array<
    UsageBucketSummary & {
      model: string
    }
  >
  accounts: Array<
    UsageBucketSummary & {
      label: string
    }
  >
}

type UsageSummaryResponse = {
  timestamp: string
  windowStartedAt: string
  lastUpdatedAt: string | null
  uptimeMs: number
  notes: string[]
  totals: UsageBucketSummary
  routes: Array<
    UsageBucketSummary & {
      backend: UsageBackend
      backendLabel: string
      transport: string
    }
  >
  topModels: Array<
    UsageBucketSummary & {
      backend: UsageBackend
      backendLabel: string
      model: string
    }
  >
  topAccounts: Array<
    UsageBucketSummary & {
      backend: UsageBackend
      backendLabel: string
      label: string
    }
  >
  recent: UsageRecentRecord[]
  backends: Record<UsageBackend, BackendUsageSummary>
}

export type CodexUsageRecord = {
  transport: UsageTransport
  modelName: string
  accountKey: string
  accountLabel: string
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens?: number
  outputTokens: number
  webSearchRequests?: number
  durationMs?: number
  recordedAt?: number
}

export type BackendUsageRecord = {
  transport: UsageTransport
  modelName: string
  accountKey: string
  accountLabel: string
  inputTokens: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  outputTokens: number
  webSearchRequests?: number
  error429Count?: number
  error503Count?: number
  durationMs?: number
  recordedAt?: number
}

const BACKEND_LABELS: Record<UsageBackend, string> = {
  codex: "Codex",
  google: "Antigravity",
  "openai-compat": "OpenAI-Compatible",
  "claude-api": "Claude API",
}

const TRACKED_BACKENDS = Object.keys(BACKEND_LABELS) as UsageBackend[]
const RECENT_EVENT_LIMIT = 20

@Injectable()
export class UsageStatsService implements OnModuleInit {
  private readonly serviceStartedAt = Date.now()
  private windowStartedAt = this.serviceStartedAt
  private lastUpdatedAt: number | null = null
  private backendStates = this.createBackendStateMap()
  private recentEvents: NormalizedUsageRecord[] = []

  constructor(@Optional() private readonly persistence?: PersistenceService) {}

  onModuleInit(): void {
    this.hydrateFromPersistence()
  }

  recordCodexUsage(record: CodexUsageRecord): void {
    this.recordUsage({
      backend: "codex",
      transport: record.transport,
      modelName: record.modelName,
      accountKey: record.accountKey,
      accountLabel: record.accountLabel,
      inputTokens: record.inputTokens,
      cachedInputTokens: record.cachedInputTokens,
      cacheCreationInputTokens: record.cacheCreationInputTokens,
      outputTokens: record.outputTokens,
      webSearchRequests: record.webSearchRequests,
      durationMs: record.durationMs,
      recordedAt: record.recordedAt,
    })
  }

  recordGoogleUsage(record: BackendUsageRecord): void {
    this.recordUsage({
      backend: "google",
      transport: record.transport,
      modelName: record.modelName,
      accountKey: record.accountKey,
      accountLabel: record.accountLabel,
      inputTokens: record.inputTokens,
      cachedInputTokens: record.cachedInputTokens,
      cacheCreationInputTokens: record.cacheCreationInputTokens,
      outputTokens: record.outputTokens,
      webSearchRequests: record.webSearchRequests,
      error429Count: record.error429Count,
      error503Count: record.error503Count,
      durationMs: record.durationMs,
      recordedAt: record.recordedAt,
    })
  }

  recordOpenAiCompatUsage(record: BackendUsageRecord): void {
    this.recordUsage({
      backend: "openai-compat",
      transport: record.transport,
      modelName: record.modelName,
      accountKey: record.accountKey,
      accountLabel: record.accountLabel,
      inputTokens: record.inputTokens,
      cachedInputTokens: record.cachedInputTokens,
      cacheCreationInputTokens: record.cacheCreationInputTokens,
      outputTokens: record.outputTokens,
      webSearchRequests: record.webSearchRequests,
      durationMs: record.durationMs,
      recordedAt: record.recordedAt,
    })
  }

  recordClaudeApiUsage(record: BackendUsageRecord): void {
    this.recordUsage({
      backend: "claude-api",
      transport: record.transport,
      modelName: record.modelName,
      accountKey: record.accountKey,
      accountLabel: record.accountLabel,
      inputTokens: record.inputTokens,
      cachedInputTokens: record.cachedInputTokens,
      cacheCreationInputTokens: record.cacheCreationInputTokens,
      outputTokens: record.outputTokens,
      webSearchRequests: record.webSearchRequests,
      durationMs: record.durationMs,
      recordedAt: record.recordedAt,
    })
  }

  getDailyUsage(): {
    days: Array<{
      date: string
      requests: number
      inputTokens: number
      cachedInputTokens: number
      cacheCreationInputTokens: number
      outputTokens: number
      totalContextTokens: number
      webSearchRequests: number
      error429Count: number
      error503Count: number
    }>
  } {
    if (!this.persistence?.isReady) {
      return { days: [] }
    }

    const rows = this.persistence
      .prepare(
        `SELECT
           date(recorded_at / 1000, 'unixepoch', 'localtime') as day,
           COUNT(*) as requests,
           SUM(input_tokens) as input_tokens,
           SUM(cached_input_tokens) as cached_input_tokens,
           SUM(cache_creation_input_tokens) as cache_creation_input_tokens,
           SUM(output_tokens) as output_tokens,
           SUM(web_search_requests) as web_search_requests,
           SUM(error_429_count) as error_429_count,
           SUM(error_503_count) as error_503_count
         FROM usage_events
         GROUP BY day
         ORDER BY day ASC`
      )
      .all() as unknown as Array<{
      day: string
      requests: number
      input_tokens: number
      cached_input_tokens: number
      cache_creation_input_tokens: number
      output_tokens: number
      web_search_requests: number
      error_429_count: number
      error_503_count: number
    }>

    return {
      days: rows.map((row) => {
        const input = this.toWholeNumber(row.input_tokens)
        const cached = this.toWholeNumber(row.cached_input_tokens)
        const cacheCreation = this.toWholeNumber(
          row.cache_creation_input_tokens
        )
        return {
          date: row.day,
          requests: this.toWholeNumber(row.requests),
          inputTokens: input,
          cachedInputTokens: cached,
          cacheCreationInputTokens: cacheCreation,
          outputTokens: this.toWholeNumber(row.output_tokens),
          totalContextTokens: input + cached + cacheCreation,
          webSearchRequests: this.toWholeNumber(row.web_search_requests),
          error429Count: this.toWholeNumber(row.error_429_count),
          error503Count: this.toWholeNumber(row.error_503_count),
        }
      }),
    }
  }

  getSummary(): UsageSummaryResponse {
    const backendSummaries = TRACKED_BACKENDS.reduce(
      (acc, backend) => {
        acc[backend] = this.toBackendSummary(
          backend,
          this.backendStates[backend]
        )
        return acc
      },
      {} as Record<UsageBackend, BackendUsageSummary>
    )

    const routes = TRACKED_BACKENDS.flatMap((backend) =>
      Object.entries(backendSummaries[backend].transports).map(
        ([transport, summary]) => ({
          backend,
          backendLabel: BACKEND_LABELS[backend],
          transport,
          ...summary,
        })
      )
    ).sort((left, right) => this.compareUsageEntries(left, right))

    const topModels = TRACKED_BACKENDS.flatMap((backend) =>
      backendSummaries[backend].models.map((entry) => ({
        ...entry,
        backend,
        backendLabel: BACKEND_LABELS[backend],
      }))
    )
      .sort((left, right) => this.compareUsageEntries(left, right))
      .slice(0, 12)

    const topAccounts = TRACKED_BACKENDS.flatMap((backend) =>
      backendSummaries[backend].accounts.map((entry) => ({
        ...entry,
        backend,
        backendLabel: BACKEND_LABELS[backend],
      }))
    )
      .sort((left, right) => this.compareUsageEntries(left, right))
      .slice(0, 12)

    return {
      timestamp: new Date().toISOString(),
      windowStartedAt: new Date(this.windowStartedAt).toISOString(),
      lastUpdatedAt:
        this.lastUpdatedAt != null
          ? new Date(this.lastUpdatedAt).toISOString()
          : null,
      uptimeMs: Math.max(0, Date.now() - this.serviceStartedAt),
      notes: [
        "Usage events persist across bridge restarts.",
        "Input, cache read, and cache write are tracked separately when the upstream backend exposes them.",
        "Google account 429/503 ratios count failed attempts captured by the bridge.",
        "Duration is measured as end-to-end upstream request time for successful requests only.",
      ],
      totals: this.toSummaryBucket(
        TRACKED_BACKENDS.reduce((acc, backend) => {
          const state = this.backendStates[backend]
          acc.requests += state.totals.requests
          acc.cachedRequests += state.totals.cachedRequests
          acc.inputTokens += state.totals.inputTokens
          acc.cachedInputTokens += state.totals.cachedInputTokens
          acc.cacheCreationInputTokens += state.totals.cacheCreationInputTokens
          acc.outputTokens += state.totals.outputTokens
          acc.webSearchRequests += state.totals.webSearchRequests
          acc.error429Count += state.totals.error429Count
          acc.error503Count += state.totals.error503Count
          acc.totalDurationMs += state.totals.totalDurationMs
          if (
            state.totals.lastSeenAt != null &&
            (acc.lastSeenAt == null || state.totals.lastSeenAt > acc.lastSeenAt)
          ) {
            acc.lastSeenAt = state.totals.lastSeenAt
          }
          return acc
        }, this.createBucket())
      ),
      routes,
      topModels,
      topAccounts,
      recent: this.recentEvents.map((event) => this.toRecentRecord(event)),
      backends: backendSummaries,
    }
  }

  private recordUsage(record: {
    backend: UsageBackend
    transport: UsageTransport
    modelName: string
    accountKey: string
    accountLabel: string
    inputTokens: number
    cachedInputTokens?: number
    cacheCreationInputTokens?: number
    outputTokens: number
    webSearchRequests?: number
    error429Count?: number
    error503Count?: number
    durationMs?: number
    recordedAt?: number
  }): void {
    const normalized = this.normalizeRecord(record)
    this.applyUsageRecord(normalized)
    this.persistUsageRecord(normalized)
  }

  private hydrateFromPersistence(): void {
    if (!this.persistence?.isReady) return

    const rows = this.persistence
      .prepare(
        `SELECT
           backend,
           transport,
           model_name,
           account_key,
           account_label,
           input_tokens,
           cached_input_tokens,
           cache_creation_input_tokens,
           output_tokens,
           web_search_requests,
           error_429_count,
           error_503_count,
           duration_ms,
           recorded_at
         FROM usage_events
         ORDER BY recorded_at ASC, id ASC`
      )
      .all() as unknown as PersistedUsageEventRow[]

    if (rows.length === 0) {
      return
    }

    this.resetState()
    for (const row of rows) {
      this.applyUsageRecord(
        this.normalizeRecord({
          backend: row.backend,
          transport: row.transport,
          modelName: row.model_name,
          accountKey: row.account_key,
          accountLabel: row.account_label,
          inputTokens: row.input_tokens,
          cachedInputTokens: row.cached_input_tokens,
          cacheCreationInputTokens: row.cache_creation_input_tokens,
          outputTokens: row.output_tokens,
          webSearchRequests: row.web_search_requests,
          error429Count: row.error_429_count,
          error503Count: row.error_503_count,
          durationMs: row.duration_ms,
          recordedAt: row.recorded_at,
        })
      )
    }
  }

  private persistUsageRecord(record: NormalizedUsageRecord): void {
    if (!this.persistence?.isReady) return

    this.persistence
      .prepare(
        `INSERT INTO usage_events (
           backend,
           transport,
           model_name,
           account_key,
           account_label,
           input_tokens,
           cached_input_tokens,
           cache_creation_input_tokens,
           output_tokens,
           web_search_requests,
           error_429_count,
           error_503_count,
           duration_ms,
           recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.backend,
        record.transport,
        record.modelName,
        record.accountKey,
        record.accountLabel,
        record.inputTokens,
        record.cachedInputTokens,
        record.cacheCreationInputTokens,
        record.outputTokens,
        record.webSearchRequests,
        record.error429Count,
        record.error503Count,
        record.durationMs,
        record.recordedAt
      )
  }

  private applyUsageRecord(record: NormalizedUsageRecord): void {
    const backendState = this.backendStates[record.backend]

    this.applyUsage(backendState.totals, record)

    const transportBucket =
      backendState.transports.get(record.transport) ?? this.createBucket()
    this.applyUsage(transportBucket, record)
    backendState.transports.set(record.transport, transportBucket)

    const modelBucket =
      backendState.models.get(record.modelName) ?? this.createBucket()
    this.applyUsage(modelBucket, record)
    backendState.models.set(record.modelName, modelBucket)

    const accountBucket =
      backendState.accounts.get(record.accountKey) ??
      ({
        ...this.createBucket(),
        label: record.accountLabel,
      } satisfies AccountUsageBucketState)
    accountBucket.label = record.accountLabel
    this.applyUsage(accountBucket, record)
    backendState.accounts.set(record.accountKey, accountBucket)

    this.recentEvents.unshift(record)
    if (this.recentEvents.length > RECENT_EVENT_LIMIT) {
      this.recentEvents.length = RECENT_EVENT_LIMIT
    }

    if (record.recordedAt < this.windowStartedAt) {
      this.windowStartedAt = record.recordedAt
    }
    if (this.lastUpdatedAt == null || record.recordedAt > this.lastUpdatedAt) {
      this.lastUpdatedAt = record.recordedAt
    }
  }

  private normalizeRecord(record: {
    backend: UsageBackend
    transport: UsageTransport
    modelName: string
    accountKey: string
    accountLabel: string
    inputTokens: number
    cachedInputTokens?: number
    cacheCreationInputTokens?: number
    outputTokens: number
    webSearchRequests?: number
    error429Count?: number
    error503Count?: number
    durationMs?: number
    recordedAt?: number
  }): NormalizedUsageRecord {
    const recordedAt =
      typeof record.recordedAt === "number" &&
      Number.isFinite(record.recordedAt)
        ? Math.round(record.recordedAt)
        : Date.now()

    return {
      backend: record.backend,
      transport: `${record.transport || "unknown"}`.trim() || "unknown",
      modelName: record.modelName.trim() || "(unknown)",
      accountKey: record.accountKey.trim() || "(unknown)",
      accountLabel:
        record.accountLabel.trim() ||
        `${BACKEND_LABELS[record.backend]} account`,
      inputTokens: this.toWholeNumber(record.inputTokens),
      cachedInputTokens: this.toWholeNumber(record.cachedInputTokens ?? 0),
      cacheCreationInputTokens: this.toWholeNumber(
        record.cacheCreationInputTokens ?? 0
      ),
      outputTokens: this.toWholeNumber(record.outputTokens),
      webSearchRequests: this.toWholeNumber(record.webSearchRequests ?? 0),
      error429Count: this.toWholeNumber(record.error429Count ?? 0),
      error503Count: this.toWholeNumber(record.error503Count ?? 0),
      durationMs: this.toWholeNumber(record.durationMs ?? 0),
      recordedAt,
    }
  }

  private createBackendStateMap(): Record<UsageBackend, BackendUsageState> {
    return {
      codex: this.createBackendState(),
      google: this.createBackendState(),
      "openai-compat": this.createBackendState(),
      "claude-api": this.createBackendState(),
    }
  }

  private createBackendState(): BackendUsageState {
    return {
      totals: this.createBucket(),
      transports: new Map(),
      models: new Map(),
      accounts: new Map(),
    }
  }

  private resetState(): void {
    this.windowStartedAt = this.serviceStartedAt
    this.lastUpdatedAt = null
    this.backendStates = this.createBackendStateMap()
    this.recentEvents = []
  }

  private createBucket(): UsageBucketState {
    return {
      requests: 0,
      cachedRequests: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      webSearchRequests: 0,
      totalAttempts: 0,
      error429Count: 0,
      error503Count: 0,
      totalDurationMs: 0,
      lastSeenAt: null,
    }
  }

  private applyUsage(
    bucket: UsageBucketState,
    values: {
      inputTokens: number
      cachedInputTokens: number
      cacheCreationInputTokens: number
      outputTokens: number
      webSearchRequests: number
      error429Count: number
      error503Count: number
      durationMs: number
      recordedAt: number
    }
  ): void {
    bucket.requests += 1
    bucket.totalAttempts += 1
    if (values.cachedInputTokens > 0) {
      bucket.cachedRequests += 1
    }
    bucket.inputTokens += values.inputTokens
    bucket.cachedInputTokens += values.cachedInputTokens
    bucket.cacheCreationInputTokens += values.cacheCreationInputTokens
    bucket.outputTokens += values.outputTokens
    bucket.webSearchRequests += values.webSearchRequests
    bucket.error429Count += values.error429Count
    bucket.error503Count += values.error503Count
    bucket.totalDurationMs += values.durationMs
    bucket.lastSeenAt = values.recordedAt
  }

  private toBackendSummary(
    backend: UsageBackend,
    state: BackendUsageState
  ): BackendUsageSummary {
    const transportEntries = Array.from(state.transports.entries())
      .map(
        ([transport, bucket]) =>
          [transport, this.toSummaryBucket(bucket)] as [
            string,
            UsageBucketSummary,
          ]
      )
      .sort((left, right) => this.compareUsageEntries(left[1], right[1]))

    return {
      tracked: true,
      label: BACKEND_LABELS[backend],
      totals: this.toSummaryBucket(state.totals),
      transports: Object.fromEntries(transportEntries),
      models: Array.from(state.models.entries())
        .map(([model, bucket]) => ({
          model,
          ...this.toSummaryBucket(bucket),
        }))
        .sort((left, right) => this.compareUsageEntries(left, right)),
      accounts: Array.from(state.accounts.values())
        .map((bucket) => ({
          label: bucket.label,
          ...this.toSummaryBucket(bucket),
        }))
        .sort((left, right) => this.compareUsageEntries(left, right)),
    }
  }

  private toSummaryBucket(bucket: UsageBucketState): UsageBucketSummary {
    const totalPromptTokens = bucket.inputTokens + bucket.cachedInputTokens
    const totalContextTokens =
      totalPromptTokens + bucket.cacheCreationInputTokens
    const totalAttempts = bucket.totalAttempts
    const cacheHitRate =
      bucket.requests > 0
        ? this.roundPercentage((bucket.cachedRequests / bucket.requests) * 100)
        : null
    const cacheReuseRate =
      totalPromptTokens > 0
        ? this.roundPercentage(
            (bucket.cachedInputTokens / totalPromptTokens) * 100
          )
        : null

    return {
      requests: bucket.requests,
      totalAttempts,
      cachedRequests: bucket.cachedRequests,
      inputTokens: bucket.inputTokens,
      cachedInputTokens: bucket.cachedInputTokens,
      cacheCreationInputTokens: bucket.cacheCreationInputTokens,
      totalContextTokens,
      billableInputTokens: bucket.inputTokens + bucket.cacheCreationInputTokens,
      outputTokens: bucket.outputTokens,
      webSearchRequests: bucket.webSearchRequests,
      error429Count: bucket.error429Count,
      error503Count: bucket.error503Count,
      error429Rate:
        totalAttempts > 0
          ? this.roundPercentage((bucket.error429Count / totalAttempts) * 100)
          : null,
      error503Rate:
        totalAttempts > 0
          ? this.roundPercentage((bucket.error503Count / totalAttempts) * 100)
          : null,
      totalDurationMs: bucket.totalDurationMs,
      avgDurationMs:
        bucket.requests > 0
          ? Math.round((bucket.totalDurationMs / bucket.requests) * 10) / 10
          : null,
      cacheHitRate,
      cacheReuseRate,
      lastSeenAt:
        bucket.lastSeenAt != null
          ? new Date(bucket.lastSeenAt).toISOString()
          : null,
    }
  }

  private toRecentRecord(record: NormalizedUsageRecord): UsageRecentRecord {
    return {
      backend: record.backend,
      backendLabel: BACKEND_LABELS[record.backend],
      transport: record.transport,
      model: record.modelName,
      accountLabel: record.accountLabel,
      inputTokens: record.inputTokens,
      cachedInputTokens: record.cachedInputTokens,
      cacheCreationInputTokens: record.cacheCreationInputTokens,
      totalContextTokens:
        record.inputTokens +
        record.cachedInputTokens +
        record.cacheCreationInputTokens,
      billableInputTokens: record.inputTokens + record.cacheCreationInputTokens,
      outputTokens: record.outputTokens,
      webSearchRequests: record.webSearchRequests,
      error429Count: record.error429Count,
      error503Count: record.error503Count,
      durationMs: record.durationMs,
      recordedAt: new Date(record.recordedAt).toISOString(),
    }
  }

  private compareUsageEntries(
    left: Pick<
      UsageBucketSummary,
      "totalContextTokens" | "inputTokens" | "requests" | "lastSeenAt"
    >,
    right: Pick<
      UsageBucketSummary,
      "totalContextTokens" | "inputTokens" | "requests" | "lastSeenAt"
    >
  ): number {
    if (right.totalContextTokens !== left.totalContextTokens) {
      return right.totalContextTokens - left.totalContextTokens
    }
    if (right.inputTokens !== left.inputTokens) {
      return right.inputTokens - left.inputTokens
    }
    if (right.requests !== left.requests) {
      return right.requests - left.requests
    }

    const leftSeen = left.lastSeenAt ? Date.parse(left.lastSeenAt) : 0
    const rightSeen = right.lastSeenAt ? Date.parse(right.lastSeenAt) : 0
    return rightSeen - leftSeen
  }

  private roundPercentage(value: number): number {
    return Math.round(value * 10) / 10
  }

  private toWholeNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.round(value))
      : 0
  }
}

@Global()
@Module({
  providers: [UsageStatsService],
  exports: [UsageStatsService],
})
export class UsageStatsModule {}
