import { Controller, Get, Post } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { ClaudeApiService } from "./llm/claude-api/claude-api.service"
import { CodexService } from "./llm/codex/codex.service"
import { ProcessPoolService } from "./llm/native/process-pool.service"
import { OpenaiCompatService } from "./llm/openai-compat/openai-compat.service"
import type {
  BackendPoolEntryStatus,
  BackendPoolStatus,
} from "./llm/shared/backend-pool-status"

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
  | "modelCooldowns"
> & {
  label: string
}

type PublicBackendPoolStatus = Omit<
  BackendPoolStatus,
  "configPath" | "statePath" | "entries"
> & {
  entries: PublicBackendPoolEntryStatus[]
}

@ApiTags("Health")
@Controller()
export class HealthController {
  constructor(
    private readonly processPool: ProcessPoolService,
    private readonly codexService: CodexService,
    private readonly openaiCompatService: OpenaiCompatService,
    private readonly claudeApiService: ClaudeApiService
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
  getPoolStatus() {
    const timestamp = new Date().toISOString()
    const nativeSummary = this.summarizeNativePoolStatus(
      this.processPool.getStatus()
    )

    return {
      timestamp,
      ...nativeSummary,
      native: nativeSummary,
      backends: {
        google: this.redactBackendPoolStatus(this.processPool.getPoolStatus()),
        codex: this.redactBackendPoolStatus(this.codexService.getPoolStatus()),
        openaiCompat: this.redactBackendPoolStatus(
          this.openaiCompatService.getPoolStatus()
        ),
        claudeApi: this.redactBackendPoolStatus(
          this.claudeApiService.getPoolStatus()
        ),
      },
    }
  }

  @Get("pool/status/native")
  @ApiOperation({ summary: "Get redacted native process pool status" })
  getNativePoolStatus() {
    return this.redactBackendPoolStatus(this.processPool.getPoolStatus())
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

  private summarizeNativePoolStatus(
    status: ReturnType<ProcessPoolService["getStatus"]>
  ): NativePoolStatusSummary {
    return {
      total: status.total,
      ready: status.ready,
      available: status.available,
    }
  }

  private redactBackendPoolStatus(
    status: BackendPoolStatus
  ): PublicBackendPoolStatus {
    return {
      backend: status.backend,
      kind: status.kind,
      configured: status.configured,
      total: status.total,
      available: status.available,
      ready: status.ready,
      degraded: status.degraded,
      cooling: status.cooling,
      disabled: status.disabled,
      unavailable: status.unavailable,
      entries: status.entries.map((entry, index) => {
        const publicEntry: PublicBackendPoolEntryStatus = {
          label: `${status.backend}-${index + 1}`,
          state: entry.state,
          cooldownUntil: entry.cooldownUntil,
          modelCooldowns: entry.modelCooldowns.map((modelCooldown) => ({
            ...modelCooldown,
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

        return publicEntry
      }),
    }
  }
}
