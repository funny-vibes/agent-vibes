import { Controller, Get, Post, Query } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { AnthropicApiService } from "./llm/anthropic/anthropic-api.service"
import type { GoogleQuotaAccountSnapshot } from "./llm/google/process-pool.service"
import { ProcessPoolService } from "./llm/google/process-pool.service"
import { CodexService } from "./llm/openai/codex.service"
import { OpenaiCompatService } from "./llm/openai/openai-compat.service"
import type {
  BackendPoolEntryState,
  BackendPoolEntryStatus,
  BackendPoolStatus,
  CodexRateLimitWindow,
} from "./llm/shared/backend-pool-status"
import { ChatSessionManager } from "./protocol/cursor/session/chat-session.service"
import { UsageStatsService } from "./usage"

type NativePoolStatusSummary = Pick<
  ReturnType<ProcessPoolService["getStatus"]>,
  "total" | "ready" | "available"
>

type PublicBackendPoolEntryStatus = Pick<
  BackendPoolEntryStatus,
  | "state"
  | "cooldownUntil"
  | "disabledAt"
  | "source"
  | "priority"
  | "planType"
  | "ready"
  | "requestCount"
  | "rateLimits"
> & {
  label: string
  accountId?: string
  cooldownRemainingMs: number
  modelCooldowns: Array<
    BackendPoolEntryStatus["modelCooldowns"][number] & {
      remainingMs: number
    }
  >
}

type PublicBackendPoolStatus = Omit<
  BackendPoolStatus,
  "configPath" | "statePath" | "entries"
> & {
  entries: PublicBackendPoolEntryStatus[]
}

type GoogleQuotaSortBy = "state" | "remaining" | "resetTime" | "requestCount"

@ApiTags("Health")
@Controller()
export class HealthController {
  constructor(
    private readonly processPool: ProcessPoolService,
    private readonly codexService: CodexService,
    private readonly openaiCompatService: OpenaiCompatService,
    private readonly anthropicApiService: AnthropicApiService,
    private readonly usageStats: UsageStatsService,
    private readonly chatSessions: ChatSessionManager
  ) {}

  @Get("health")
  @ApiOperation({ summary: "Health check endpoint" })
  health() {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    }
  }

  @Get("pool/status")
  @ApiOperation({ summary: "Get all backend pool statuses" })
  async getPoolStatus() {
    await this.processPool.reloadAccounts()
    const timestamp = new Date().toISOString()
    const nativeSummary = this.summarizeNativePoolStatus(
      this.processPool.getStatus()
    )

    const codexPoolStatus = this.codexService.getPoolStatus()

    return {
      timestamp,
      ...nativeSummary,
      native: nativeSummary,
      backends: {
        google: this.redactBackendPoolStatus(this.processPool.getPoolStatus()),
        codex: this.redactBackendPoolStatus(codexPoolStatus),
        openaiCompat: this.redactBackendPoolStatus(
          this.openaiCompatService.getPoolStatus()
        ),
        claudeApi: this.redactBackendPoolStatus(
          this.anthropicApiService.getPoolStatus()
        ),
      },
    }
  }

  @Get("pool/status/native")
  @ApiOperation({ summary: "Get redacted native process pool status" })
  async getNativePoolStatus() {
    await this.processPool.reloadAccounts()
    return this.redactBackendPoolStatus(this.processPool.getPoolStatus())
  }

  @Get("quota/google")
  @ApiOperation({ summary: "Get Google per-account quota snapshots" })
  async getGoogleQuotaStatus(
    @Query("model") model?: string,
    @Query("limit") limit?: string,
    @Query("sortBy") sortBy?: string,
    @Query("force") force?: string
  ) {
    await this.processPool.reloadAccounts()
    const normalizedModel = typeof model === "string" ? model.trim() : ""
    const parsedLimit = Number.parseInt(limit || "10", 10)
    const effectiveLimit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(parsedLimit, 100))
      : 10

    const normalizedSortBy = this.normalizeGoogleQuotaSortBy(sortBy)
    const forceRefresh = force === "1" || force === "true"
    const quotaCache = this.processPool.getGoogleQuotaSnapshotCacheMetadata()
    const shouldProbe = forceRefresh || !quotaCache.hasCache
    const accounts =
      await this.processPool.fetchGoogleQuotaSnapshots(shouldProbe)
    const effectiveQuotaCache =
      shouldProbe && !forceRefresh
        ? this.processPool.getGoogleQuotaSnapshotCacheMetadata()
        : quotaCache
    const filteredAccounts = this.filterGoogleQuotaAccounts(
      accounts,
      normalizedModel,
      normalizedSortBy
    )
    const visibleAccounts = filteredAccounts.slice(0, effectiveLimit)
    const allModels = filteredAccounts.flatMap((account) => account.models)
    const withPercent = allModels.filter(
      (entry) => typeof entry.percentage === "number"
    )
    const summaryByModel = this.buildGoogleQuotaSummaryByModel(filteredAccounts)
    const summary = this.buildGoogleQuotaSummary(
      filteredAccounts,
      summaryByModel
    )

    return {
      timestamp: new Date().toISOString(),
      source: shouldProbe ? "probe" : "cache",
      cacheHit: quotaCache.hasCache,
      fetchedAt:
        effectiveQuotaCache.fetchedAt != null
          ? new Date(effectiveQuotaCache.fetchedAt).toISOString()
          : null,
      cacheAgeMs: effectiveQuotaCache.cacheAgeMs,
      model: normalizedModel || null,
      limit: effectiveLimit,
      sortBy: normalizedSortBy,
      totalAccounts: filteredAccounts.length,
      returnedAccounts: visibleAccounts.length,
      hiddenAccounts: Math.max(
        0,
        filteredAccounts.length - visibleAccounts.length
      ),
      readyAccounts: filteredAccounts.filter(
        (account) => account.state === "ready"
      ).length,
      coolingAccounts: filteredAccounts.filter(
        (account) => account.state === "cooldown"
      ).length,
      modelCooldownAccounts: filteredAccounts.filter(
        (account) => account.state === "model_cooldown"
      ).length,
      degradedAccounts: filteredAccounts.filter(
        (account) => account.state === "degraded"
      ).length,
      unavailableAccounts: filteredAccounts.filter(
        (account) => account.state === "unavailable"
      ).length,
      tierCounts: filteredAccounts.reduce<Record<string, number>>(
        (acc, account) => {
          const tier = (account.tier || "unknown").toUpperCase()
          acc[tier] = (acc[tier] || 0) + 1
          return acc
        },
        {}
      ),
      averagePercentage:
        withPercent.length > 0
          ? Math.round(
              withPercent.reduce(
                (sum, entry) => sum + (entry.percentage || 0),
                0
              ) / withPercent.length
            )
          : null,
      summary,
      summaryByModel,
      accounts: visibleAccounts,
    }
  }

  @Post("pool/check")
  @ApiOperation({ summary: "Check Cloud Code availability via native process" })
  async checkAvailability() {
    const available = await this.processPool.checkAvailability()
    return {
      timestamp: new Date().toISOString(),
      available,
    }
  }

  @Get("usage/summary")
  @ApiOperation({ summary: "Get persisted usage summary for tracked backends" })
  getUsageSummary() {
    return {
      ...this.usageStats.getSummary(),
      runtimeSessions: this.chatSessions.getAnalyticsSummary(),
    }
  }

  @Get("usage/daily")
  @ApiOperation({ summary: "Get daily token usage for heatmap calendar" })
  getDailyUsage() {
    return this.usageStats.getDailyUsage()
  }

  @Get("quota/codex")
  @ApiOperation({ summary: "Get Codex per-account rate limit snapshots" })
  async getCodexQuotaStatus(@Query("force") force?: string) {
    const forceRefresh = force === "1" || force === "true"

    // Auto-probe accounts that don't have rate limit data yet, or refresh
    // the full pool when explicitly requested.
    const poolStatus = this.codexService.getPoolStatus()
    const hasUnprobed = poolStatus.entries.some(
      (e) => !e.rateLimits?.models?.length && e.state !== "disabled"
    )
    if (forceRefresh || hasUnprobed) {
      await this.codexService.probeRateLimits(forceRefresh)
    }

    // Re-fetch after probe
    const freshStatus = this.codexService.getPoolStatus()
    const now = Date.now()
    const accounts = freshStatus.entries.map((entry, index) => {
      const rateLimits = entry.rateLimits
      const effective = rateLimits?.effective
      const serializeWindow = (
        window: CodexRateLimitWindow | null | undefined
      ) =>
        window
          ? {
              usedPercent: window.usedPercent,
              remainingPercent: Math.max(
                0,
                +(100 - window.usedPercent).toFixed(1)
              ),
              windowMinutes: window.windowMinutes,
              resetsAt: window.resetsAt
                ? new Date(window.resetsAt * 1000).toISOString()
                : null,
            }
          : null

      return {
        label: entry.label || `codex-${index + 1}`,
        email: entry.email || null,
        accountId: entry.accountId || null,
        workspaceId: entry.workspaceId || null,
        state: entry.state,
        cooldownUntil: entry.cooldownUntil
          ? new Date(entry.cooldownUntil).toISOString()
          : null,
        cooldownRemainingMs: Math.max(0, entry.cooldownUntil - now),
        planType: entry.planType || null,
        modelCooldowns: entry.modelCooldowns.map((modelCooldown) => ({
          ...modelCooldown,
          cooldownUntil: modelCooldown.cooldownUntil
            ? new Date(modelCooldown.cooldownUntil).toISOString()
            : null,
          remainingMs: Math.max(0, modelCooldown.cooldownUntil - now),
        })),
        rateLimits: rateLimits
          ? {
              effective: effective
                ? {
                    model: effective.model,
                    displayModel: effective.displayModel,
                    source: effective.source,
                    primary: serializeWindow(effective.primary),
                    secondary: serializeWindow(effective.secondary),
                    updatedAt: new Date(effective.updatedAt).toISOString(),
                  }
                : null,
              models: rateLimits.models.map((modelSummary) => ({
                model: modelSummary.model,
                displayModel: modelSummary.displayModel,
                updatedAt: new Date(modelSummary.updatedAt).toISOString(),
                effective: modelSummary.effective
                  ? {
                      source: modelSummary.effective.source,
                      primary: serializeWindow(modelSummary.effective.primary),
                      secondary: serializeWindow(
                        modelSummary.effective.secondary
                      ),
                      updatedAt: new Date(
                        modelSummary.effective.updatedAt
                      ).toISOString(),
                    }
                  : null,
                request: modelSummary.request
                  ? {
                      primary: serializeWindow(modelSummary.request.primary),
                      secondary: serializeWindow(
                        modelSummary.request.secondary
                      ),
                      updatedAt: new Date(
                        modelSummary.request.updatedAt
                      ).toISOString(),
                    }
                  : null,
                probe: modelSummary.probe
                  ? {
                      primary: serializeWindow(modelSummary.probe.primary),
                      secondary: serializeWindow(modelSummary.probe.secondary),
                      updatedAt: new Date(
                        modelSummary.probe.updatedAt
                      ).toISOString(),
                    }
                  : null,
              })),
              updatedAt: rateLimits.updatedAt
                ? new Date(rateLimits.updatedAt).toISOString()
                : null,
            }
          : null,
      }
    })

    return {
      timestamp: new Date().toISOString(),
      totalAccounts: accounts.length,
      accounts,
    }
  }

  private summarizeNativePoolStatus(
    status: ReturnType<ProcessPoolService["getStatus"]>
  ): NativePoolStatusSummary {
    return {
      total: status.total,
      ready: status.ready,
      available: status.available,
    }
  }

  private normalizeGoogleQuotaSortBy(sortBy?: string): GoogleQuotaSortBy {
    switch ((sortBy || "state").trim()) {
      case "remaining":
      case "resetTime":
      case "requestCount":
        return sortBy as GoogleQuotaSortBy
      case "state":
      default:
        return "state"
    }
  }

  private compareGoogleQuotaAccounts(
    left: GoogleQuotaAccountSnapshot,
    right: GoogleQuotaAccountSnapshot,
    sortBy: GoogleQuotaSortBy
  ): number {
    const leftModel = left.models[0]
    const rightModel = right.models[0]
    const leftPct =
      typeof leftModel?.percentage === "number" ? leftModel.percentage : -1
    const rightPct =
      typeof rightModel?.percentage === "number" ? rightModel.percentage : -1
    const leftReset = leftModel?.resetTime
      ? Date.parse(leftModel.resetTime)
      : Number.POSITIVE_INFINITY
    const rightReset = rightModel?.resetTime
      ? Date.parse(rightModel.resetTime)
      : Number.POSITIVE_INFINITY

    if (sortBy === "requestCount") {
      if (right.requestCount !== left.requestCount) {
        return right.requestCount - left.requestCount
      }
    } else if (sortBy === "resetTime") {
      if (leftReset !== rightReset) {
        return leftReset - rightReset
      }
    } else if (sortBy === "remaining") {
      if (rightPct !== leftPct) {
        return rightPct - leftPct
      }
    } else {
      if (left.state !== right.state) {
        return (
          this.getBackendStateRank(left.state) -
          this.getBackendStateRank(right.state)
        )
      }
      if (rightPct !== leftPct) {
        return rightPct - leftPct
      }
    }

    if (left.state !== right.state) {
      return (
        this.getBackendStateRank(left.state) -
        this.getBackendStateRank(right.state)
      )
    }
    if (rightPct !== leftPct) {
      return rightPct - leftPct
    }
    if (leftReset !== rightReset) {
      return leftReset - rightReset
    }
    if (right.requestCount !== left.requestCount) {
      return right.requestCount - left.requestCount
    }
    return left.email.localeCompare(right.email)
  }

  private filterGoogleQuotaAccounts(
    accounts: GoogleQuotaAccountSnapshot[],
    model: string,
    sortBy: GoogleQuotaSortBy
  ): GoogleQuotaAccountSnapshot[] {
    const normalizedModel = model.trim()
    const scoped = normalizedModel
      ? accounts
          .map((account) => ({
            ...account,
            models: account.models.filter(
              (entry) => entry.name === normalizedModel
            ),
          }))
          .filter((account) => account.models.length > 0)
      : accounts

    return [...scoped].sort((left, right) =>
      this.compareGoogleQuotaAccounts(left, right, sortBy)
    )
  }

  private buildGoogleQuotaSummary(
    accounts: GoogleQuotaAccountSnapshot[],
    summaryByModel: Record<
      string,
      {
        accounts: number
        avgPercentage: number | null
        zeroQuotaAccounts: number
        earliestResetTime: string | null
      }
    >
  ): {
    mostConstrainedModel: string | null
    soonestRecoveringModel: string | null
    highestPressureAccounts: Array<{
      email: string
      requestCount: number
      state: GoogleQuotaAccountSnapshot["state"]
      topModel: string | null
      topModelPercentage: number | null
    }>
  } {
    const modelEntries = Object.entries(summaryByModel)
    const mostConstrainedModel =
      modelEntries.length > 0
        ? (modelEntries.slice().sort((left, right) => {
            if (left[1].zeroQuotaAccounts !== right[1].zeroQuotaAccounts) {
              return right[1].zeroQuotaAccounts - left[1].zeroQuotaAccounts
            }
            const leftAvg = left[1].avgPercentage ?? Number.POSITIVE_INFINITY
            const rightAvg = right[1].avgPercentage ?? Number.POSITIVE_INFINITY
            if (leftAvg !== rightAvg) {
              return leftAvg - rightAvg
            }
            return left[0].localeCompare(right[0])
          })[0]?.[0] ?? null)
        : null

    const soonestRecoveringModel =
      modelEntries.length > 0
        ? (modelEntries
            .filter(([, summary]) => Boolean(summary.earliestResetTime))
            .sort((left, right) => {
              const leftReset = left[1].earliestResetTime
                ? Date.parse(left[1].earliestResetTime)
                : Number.POSITIVE_INFINITY
              const rightReset = right[1].earliestResetTime
                ? Date.parse(right[1].earliestResetTime)
                : Number.POSITIVE_INFINITY
              if (leftReset !== rightReset) {
                return leftReset - rightReset
              }
              return left[0].localeCompare(right[0])
            })[0]?.[0] ?? null)
        : null

    const highestPressureAccounts = accounts
      .slice()
      .sort((left, right) => {
        if (right.requestCount !== left.requestCount) {
          return right.requestCount - left.requestCount
        }
        return left.email.localeCompare(right.email)
      })
      .slice(0, 5)
      .map((account) => {
        const topModel = account.models.slice().sort((left, right) => {
          const leftPct =
            typeof left.percentage === "number" ? left.percentage : -1
          const rightPct =
            typeof right.percentage === "number" ? right.percentage : -1
          if (leftPct !== rightPct) {
            return leftPct - rightPct
          }
          return left.name.localeCompare(right.name)
        })[0]

        return {
          email: account.email,
          requestCount: account.requestCount,
          state: account.state,
          topModel: topModel?.name ?? null,
          topModelPercentage:
            typeof topModel?.percentage === "number"
              ? topModel.percentage
              : null,
        }
      })

    return {
      mostConstrainedModel,
      soonestRecoveringModel,
      highestPressureAccounts,
    }
  }

  private buildGoogleQuotaSummaryByModel(
    accounts: GoogleQuotaAccountSnapshot[]
  ): Record<
    string,
    {
      accounts: number
      avgPercentage: number | null
      zeroQuotaAccounts: number
      earliestResetTime: string | null
    }
  > {
    const groups = new Map<
      string,
      {
        accounts: number
        percentageSum: number
        percentageCount: number
        zeroQuotaAccounts: number
        earliestResetTimeMs: number
      }
    >()

    for (const account of accounts) {
      for (const model of account.models) {
        const current = groups.get(model.name) ?? {
          accounts: 0,
          percentageSum: 0,
          percentageCount: 0,
          zeroQuotaAccounts: 0,
          earliestResetTimeMs: Number.POSITIVE_INFINITY,
        }

        current.accounts += 1
        if (typeof model.percentage === "number") {
          current.percentageSum += model.percentage
          current.percentageCount += 1
          if (model.percentage <= 0) {
            current.zeroQuotaAccounts += 1
          }
        }

        if (model.resetTime) {
          const parsed = Date.parse(model.resetTime)
          if (Number.isFinite(parsed)) {
            current.earliestResetTimeMs = Math.min(
              current.earliestResetTimeMs,
              parsed
            )
          }
        }

        groups.set(model.name, current)
      }
    }

    return Object.fromEntries(
      Array.from(groups.entries())
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([name, summary]) => [
          name,
          {
            accounts: summary.accounts,
            avgPercentage:
              summary.percentageCount > 0
                ? Math.round(summary.percentageSum / summary.percentageCount)
                : null,
            zeroQuotaAccounts: summary.zeroQuotaAccounts,
            earliestResetTime: Number.isFinite(summary.earliestResetTimeMs)
              ? new Date(summary.earliestResetTimeMs).toISOString()
              : null,
          },
        ])
    )
  }

  private redactBackendPoolStatus(
    status: BackendPoolStatus
  ): PublicBackendPoolStatus {
    const now = Date.now()

    return {
      backend: status.backend,
      kind: status.kind,
      configured: status.configured,
      total: status.total,
      available: status.available,
      ready: status.ready,
      degraded: status.degraded,
      modelCooldown: status.modelCooldown,
      cooling: status.cooling,
      disabled: status.disabled,
      unavailable: status.unavailable,
      entries: status.entries.map((entry, index) => {
        const publicEntry: PublicBackendPoolEntryStatus = {
          label: entry.email || entry.label || `${status.backend}-${index + 1}`,
          state: entry.state,
          cooldownUntil: entry.cooldownUntil,
          cooldownRemainingMs: Math.max(0, entry.cooldownUntil - now),
          modelCooldowns: entry.modelCooldowns.map((modelCooldown) => ({
            ...modelCooldown,
            remainingMs: Math.max(0, modelCooldown.cooldownUntil - now),
          })),
        }

        if (typeof entry.disabledAt === "number") {
          publicEntry.disabledAt = entry.disabledAt
        }
        if (entry.source) {
          publicEntry.source = entry.source
        }
        if (typeof entry.priority === "number") {
          publicEntry.priority = entry.priority
        }
        if (entry.planType) {
          publicEntry.planType = entry.planType
        }
        if (typeof entry.ready === "boolean") {
          publicEntry.ready = entry.ready
        }
        if (typeof entry.requestCount === "number") {
          publicEntry.requestCount = entry.requestCount
        }
        if (entry.rateLimits) {
          publicEntry.rateLimits = entry.rateLimits
        }
        if (entry.accountId) {
          publicEntry.accountId = entry.accountId
        }

        return publicEntry
      }),
    }
  }

  private getBackendStateRank(state: BackendPoolEntryState): number {
    switch (state) {
      case "ready":
        return 0
      case "degraded":
        return 1
      case "model_cooldown":
        return 2
      case "cooldown":
        return 3
      case "disabled":
        return 4
      case "unavailable":
        return 5
      default:
        return 6
    }
  }
}
