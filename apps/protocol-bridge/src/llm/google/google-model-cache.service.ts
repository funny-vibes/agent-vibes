import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import {
  getDefaultModelIds,
  isSupportedModel as isRegistrySupported,
} from "../shared/model-registry"
import { ProcessPoolService } from "./process-pool.service"

/**
 * Model info from Cloud Code API
 */
interface GeminiModelInfo {
  modelId: string
  displayName?: string
  description?: string
  supportsThinking?: boolean
  thinkingBudget?: number
  minThinkingBudget?: number
}

/**
 * GoogleModelCacheService - Fetches and caches available models from Cloud Code API
 *
 * Model discovery is delegated to native worker processes
 * which call Cloud Code using the IDE's own network stack.
 */
@Injectable()
export class GoogleModelCacheService implements OnModuleInit {
  private readonly logger = new Logger(GoogleModelCacheService.name)

  // Model cache
  private modelCache: Map<string, GeminiModelInfo> = new Map()
  private lastUpdate: Date | null = null
  private readonly CACHE_TTL = 3600 * 1000 // 1 hour in ms

  // Default models from unified registry
  private readonly DEFAULT_MODELS = getDefaultModelIds()

  constructor(private readonly processPool: ProcessPoolService) {}

  onModuleInit(): void {
    // Load default models first, then try API in background
    this.addDefaultModels()

    if (this.processPool.isConfigured()) {
      this.logger.log("Using default models, loading from API in background...")
      this.loadModelsInBackground()
    } else {
      this.logger.warn(
        "Antigravity not configured, using default Gemini models"
      )
    }
  }

  /**
   * Load models in background via native worker (non-blocking)
   */
  private loadModelsInBackground(): void {
    const LOAD_TIMEOUT_MS = 15000

    const loadPromise = this.loadModels()
    const timeoutPromise = new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error("Model loading timeout")),
        LOAD_TIMEOUT_MS
      )
    )

    Promise.race([loadPromise, timeoutPromise]).catch((error) => {
      this.logger.warn(
        `Background model loading failed: ${error instanceof Error ? error.message : String(error)}, using defaults`
      )
    })
  }

  /**
   * Load models from Cloud Code API via native worker process
   */
  async loadModels(): Promise<void> {
    this.logger.log("Loading models via native process pool...")

    try {
      const result = (await this.processPool.fetchAvailableModels()) as {
        models?: Record<
          string,
          {
            displayName?: string
            supportsThinking?: boolean
            thinkingBudget?: number
            minThinkingBudget?: number
            quotaInfo?: { remainingFraction?: number; resetTime?: string }
          }
        >
      }

      const modelsMap = result?.models || {}

      // Update cache
      this.modelCache.clear()
      for (const [modelId, modelData] of Object.entries(modelsMap)) {
        if (this.isSupportedModel(modelId)) {
          this.modelCache.set(modelId, {
            modelId,
            displayName: modelData.displayName,
            supportsThinking: modelData.supportsThinking,
            thinkingBudget:
              typeof modelData.thinkingBudget === "number"
                ? modelData.thinkingBudget
                : undefined,
            minThinkingBudget:
              typeof modelData.minThinkingBudget === "number"
                ? modelData.minThinkingBudget
                : undefined,
          })
        }
      }
      this.lastUpdate = new Date()

      this.logger.log(
        `Loaded ${this.modelCache.size} models via native process`
      )
      this.logger.debug(
        `Models: ${Array.from(this.modelCache.keys()).join(", ")}`
      )
    } catch (error) {
      this.logger.warn(
        `Failed to fetch models via native process: ${error instanceof Error ? error.message : String(error)}`
      )
      // Keep existing default models
    }
  }

  /**
   * Check if a model is supported (Claude or Gemini)
   */
  private isSupportedModel(modelId: string): boolean {
    return isRegistrySupported(modelId)
  }

  /**
   * Add default models to cache
   */
  private addDefaultModels(): void {
    this.modelCache.clear()
    for (const modelId of this.DEFAULT_MODELS) {
      this.modelCache.set(modelId, {
        modelId,
        displayName: modelId,
        description: "Gemini model via Antigravity Cloud Code",
      })
    }
    this.lastUpdate = new Date()
    this.logger.log(`Added ${this.DEFAULT_MODELS.length} default Gemini models`)
  }

  /**
   * Get all available model IDs
   */
  getAllModelIds(): string[] {
    return Array.from(this.modelCache.keys()).sort()
  }

  /**
   * Check if model exists in cache
   */
  isValidModel(modelId: string): boolean {
    return this.modelCache.has(modelId)
  }

  /**
   * Get model info
   */
  getModelInfo(modelId: string): GeminiModelInfo | undefined {
    return this.modelCache.get(modelId)
  }

  /**
   * Check if cache is stale
   */
  isStale(): boolean {
    if (!this.lastUpdate) return true
    return Date.now() - this.lastUpdate.getTime() > this.CACHE_TTL
  }

  /**
   * Refresh cache if stale
   */
  async refreshIfStale(): Promise<void> {
    if (this.isStale() && this.processPool.isConfigured()) {
      await this.loadModels()
    }
  }

  /**
   * Force refresh cache regardless of staleness.
   * Used when user explicitly requests model list refresh.
   */
  async forceRefresh(): Promise<void> {
    if (this.processPool.isConfigured()) {
      await this.loadModels()
    }
  }
}
