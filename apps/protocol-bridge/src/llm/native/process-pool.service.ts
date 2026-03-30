import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { ChildProcess, spawn } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as readline from "readline"
import { getAntigravityAccountsConfigPathCandidates } from "../../shared/protocol-bridge-paths"
import {
  BackendPoolEntryState,
  BackendPoolStatus,
} from "../shared/backend-pool-status"

/**
 * Account configuration for a native worker process
 */
export interface NativeAccount {
  email: string
  accessToken: string
  refreshToken: string
  expiresAt?: string
  projectId?: string
  isGcpTos?: boolean
  cloudCodeUrlOverride?: string
}

/**
 * IPC request message
 */
interface WorkerRequest {
  id: string
  method: string
  params?: Record<string, unknown>
}

/**
 * Pending request with promise resolve/reject
 */
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  streamCallback?: (chunk: unknown) => void
  timeout: ReturnType<typeof setTimeout>
}

/**
 * Per-model cooldown state for a worker (inspired by CLIProxyAPI's ModelState)
 */
interface WorkerModelState {
  cooldownUntil: number // Date.now() timestamp; 0 = available
  quotaExhausted: boolean
}

/**
 * A managed worker process
 */
interface WorkerHandle {
  process: ChildProcess
  account: NativeAccount
  ready: boolean
  pending: Map<string, PendingRequest>
  requestCount: number
  cooldownUntil: number // Date.now() timestamp; 0 = available
  modelStates: Map<string, WorkerModelState> // per-model cooldown state
  bootstrapComplete: boolean
  readyResolve?: () => void // event-driven ready notification
}

const WORKER_SCRIPT = path.resolve(__dirname, "worker.js")

const ANTIGRAVITY_HELPER_RELATIVE_PATH = path.join(
  "Contents",
  "Frameworks",
  "Antigravity Helper (Plugin).app",
  "Contents",
  "MacOS",
  "Antigravity Helper (Plugin)"
)

const ANTIGRAVITY_NODE_MODULES_RELATIVE_PATH = path.join(
  "Contents",
  "Resources",
  "app",
  "node_modules"
)

function expandHomeDir(inputPath: string): string {
  if (inputPath === "~") return os.homedir()
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2))
  }
  return inputPath
}

function resolveAppBundlePaths(appPath: string): {
  nodeBinary: string
  nodeModules: string
} {
  return {
    nodeBinary: path.join(appPath, ANTIGRAVITY_HELPER_RELATIVE_PATH),
    nodeModules: path.join(appPath, ANTIGRAVITY_NODE_MODULES_RELATIVE_PATH),
  }
}

/**
 * ProcessPoolService — Manages a pool of Antigravity native worker processes
 *
 * Each worker process:
 * - Runs using the Antigravity IDE's Node.js binary
 * - Loads google-auth-library from the IDE's node_modules
 * - Makes Cloud Code API calls with 100% native fingerprint
 * - Communicates via JSON Lines over stdin/stdout
 */
@Injectable()
export class ProcessPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProcessPoolService.name)
  private readonly workers: WorkerHandle[] = []
  private currentWorkerIndex = -1
  private requestCounter = 0
  /** Tracks the worker that most recently executed a request (for precise cooldown targeting) */
  private lastUsedWorker: WorkerHandle | null = null
  /** Per-model sticky affinity: remember the last worker that succeeded for each model */
  private readonly preferredWorkerByModel = new Map<string, WorkerHandle>()
  /** Timeout for non-streaming generation (deep thinking models may take long) */
  private readonly GENERATE_TIMEOUT_MS = 3_600_000 // 1 hour
  private antigravityNodeBinary: string | null = null
  private antigravityNodeModules: string | null = null

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.logger.log("Initializing native process pool...")

    const runtimePaths = this.resolveAntigravityRuntimePaths()
    if (!runtimePaths) {
      return
    }
    this.antigravityNodeBinary = runtimePaths.nodeBinary
    this.antigravityNodeModules = runtimePaths.nodeModules
    this.logger.log(
      `Using Antigravity runtime: ${runtimePaths.nodeBinary} (NODE_PATH=${runtimePaths.nodeModules})`
    )

    // Verify worker script exists
    if (!fs.existsSync(WORKER_SCRIPT)) {
      this.logger.error(`Worker script not found: ${WORKER_SCRIPT}`)
      return
    }

    // Load accounts and spawn workers
    const accounts = this.loadAccounts()
    if (accounts.length === 0) {
      this.logger.warn("No accounts configured — pool is empty")
      return
    }

    for (const account of accounts) {
      await this.spawnWorker(account)
    }

    this.logger.log(
      `Process pool initialized: ${this.workers.length} worker(s)`
    )

    // Pre-flight quota check: test each worker and cooldown exhausted ones
    await this.preflightQuotaCheck()
  }

  private resolveAntigravityRuntimePaths(): {
    nodeBinary: string
    nodeModules: string
  } | null {
    const envBinary = this.configService.get<string>("ANTIGRAVITY_NODE_BINARY")
    const envModules = this.configService.get<string>(
      "ANTIGRAVITY_NODE_MODULES"
    )
    const envAppPath = this.configService.get<string>("ANTIGRAVITY_APP_PATH")

    if (envBinary && envModules) {
      const nodeBinary = expandHomeDir(envBinary.trim())
      const nodeModules = expandHomeDir(envModules.trim())
      if (!fs.existsSync(nodeBinary)) {
        this.logger.error(
          `Configured ANTIGRAVITY_NODE_BINARY does not exist: ${nodeBinary}`
        )
        return null
      }
      if (!fs.existsSync(nodeModules)) {
        this.logger.error(
          `Configured ANTIGRAVITY_NODE_MODULES does not exist: ${nodeModules}`
        )
        return null
      }
      return { nodeBinary, nodeModules }
    }

    if (envBinary || envModules) {
      this.logger.error(
        "ANTIGRAVITY_NODE_BINARY and ANTIGRAVITY_NODE_MODULES must be set together"
      )
      return null
    }

    const appCandidates = [
      envAppPath?.trim(),
      "/Applications/Antigravity.app",
      path.join(os.homedir(), "Applications", "Antigravity.app"),
    ]
      .filter((candidate): candidate is string => Boolean(candidate))
      .map((candidate) => expandHomeDir(candidate))

    for (const appPath of appCandidates) {
      const resolved = resolveAppBundlePaths(appPath)
      if (
        fs.existsSync(resolved.nodeBinary) &&
        fs.existsSync(resolved.nodeModules)
      ) {
        return resolved
      }
    }

    this.logger.error(
      [
        "Antigravity runtime not found.",
        "Set ANTIGRAVITY_APP_PATH to the .app bundle, or set both ANTIGRAVITY_NODE_BINARY and ANTIGRAVITY_NODE_MODULES.",
        `Checked app bundles: ${appCandidates.join(", ")}`,
      ].join(" ")
    )
    return null
  }

  /**
   * Pre-flight quota check: probe each worker with a minimal request.
   * Workers that return 429 get a long cooldown so they are not
   * selected during rotation.
   */
  private async preflightQuotaCheck(): Promise<void> {
    const PREFLIGHT_COOLDOWN_MS = 5 * 60_000 // 5 minutes

    const checks = this.workers
      .filter((w) => w.ready)
      .map(async (worker) => {
        try {
          await this.primeWorkerBootstrap(worker)
          await this.sendRequest(worker, "checkAvailability", undefined, 15000)
          this.logger.log(
            `[Worker ${worker.account.email}] quota check: ✓ available`
          )
        } catch (err) {
          const msg = (err as Error).message || ""
          if (msg.includes("429")) {
            worker.cooldownUntil = Date.now() + PREFLIGHT_COOLDOWN_MS
            this.logger.warn(
              `[Worker ${worker.account.email}] quota check: ✗ rate-limited, cooldown ${PREFLIGHT_COOLDOWN_MS / 1000}s`
            )
          } else {
            this.logger.warn(
              `[Worker ${worker.account.email}] quota check: ✗ ${msg.slice(0, 120)}`
            )
          }
        }
      })

    await Promise.all(checks)

    const available = this.workers.filter(
      (w) => w.ready && w.cooldownUntil <= Date.now()
    ).length
    this.logger.log(
      `Pre-flight quota check: ${available}/${this.workers.length} worker(s) available`
    )
  }

  onModuleDestroy(): void {
    this.logger.log("Shutting down process pool...")
    for (const worker of this.workers) {
      this.killWorker(worker)
    }
    this.workers.length = 0
  }

  /**
   * Load accounts from config file.
   * Canonical location: apps/protocol-bridge/data/antigravity-accounts.json
   * (generated by: npm run antigravity:sync -- --ide)
   */
  private loadAccounts(): NativeAccount[] {
    const configPaths = getAntigravityAccountsConfigPathCandidates()

    for (const configPath of configPaths) {
      if (fs.existsSync(configPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
            accounts?: NativeAccount[]
          }
          if (Array.isArray(data.accounts) && data.accounts.length > 0) {
            this.logger.log(
              `Loaded ${data.accounts.length} account(s) from ${configPath}`
            )
            return data.accounts
          }
        } catch (err) {
          this.logger.warn(
            `Failed to parse ${configPath}: ${(err as Error).message}`
          )
        }
      }
    }

    this.logger.warn(
      "No Antigravity accounts configured — run: npm run antigravity:sync -- --ide"
    )
    return []
  }

  /**
   * Spawn a native worker process for the given account
   */
  private async spawnWorker(account: NativeAccount): Promise<void> {
    if (!this.antigravityNodeBinary || !this.antigravityNodeModules) {
      throw new Error("Antigravity runtime paths not initialized")
    }

    const child = spawn(this.antigravityNodeBinary, [WORKER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_PATH: this.antigravityNodeModules,
        NODE_OPTIONS: "",
      },
    })

    const handle: WorkerHandle = {
      process: child,
      account,
      ready: false,
      pending: new Map(),
      requestCount: 0,
      cooldownUntil: 0,
      modelStates: new Map(),
      bootstrapComplete: false,
    }

    // Parse stdout as JSON Lines
    const rl = readline.createInterface({
      input: child.stdout ?? process.stdin,
      terminal: false,
    })

    rl.on("line", (line: string) => {
      this.handleWorkerMessage(handle, line)
    })

    // Log stderr
    child.stderr?.on("data", (data: Buffer) => {
      this.logger.debug(
        `[Worker ${account.email}] stderr: ${data.toString().trim()}`
      )
    })

    child.on("exit", (code: number | null) => {
      this.logger.warn(`[Worker ${account.email}] exited with code ${code}`)
      handle.ready = false
      // Reject all pending requests
      for (const [, pending] of handle.pending) {
        clearTimeout(pending.timeout)
        pending.reject(new Error(`Worker process exited (code ${code})`))
      }
      handle.pending.clear()
      // Auto-restart after delay
      setTimeout(() => {
        this.restartWorker(handle).catch((err) => {
          this.logger.error(
            `Failed to restart worker: ${(err as Error).message}`
          )
        })
      }, 3000)
    })

    this.workers.push(handle)

    // Wait for ready signal
    await this.waitForReady(handle, 10000)

    // Initialize with account credentials
    await this.sendRequest(handle, "init", {
      account: {
        email: account.email,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        expiresAt: account.expiresAt,
        projectId: account.projectId,
        isGcpTos: account.isGcpTos ?? false,
        cloudCodeUrlOverride: account.cloudCodeUrlOverride,
      },
    })

    handle.ready = true
    this.logger.log(`[Worker ${account.email}] initialized and ready`)
  }

  /**
   * Wait for worker ready signal
   */
  private waitForReady(handle: WorkerHandle, timeoutMs: number): Promise<void> {
    if (handle.ready) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.readyResolve = undefined
        reject(new Error("Worker ready timeout"))
      }, timeoutMs)

      handle.readyResolve = () => {
        clearTimeout(timer)
        handle.readyResolve = undefined
        resolve()
      }
    })
  }

  /**
   * Restart a crashed worker
   */
  private async restartWorker(oldHandle: WorkerHandle): Promise<void> {
    const index = this.workers.indexOf(oldHandle)
    if (index === -1) return

    this.logger.log(`Restarting worker for ${oldHandle.account.email}...`)
    this.workers.splice(index, 1)
    await this.spawnWorker(oldHandle.account)
  }

  /**
   * Kill a worker process
   */
  private killWorker(handle: WorkerHandle): void {
    try {
      handle.process.kill("SIGTERM")
    } catch {
      // Process may already be dead
    }
    for (const [, pending] of handle.pending) {
      clearTimeout(pending.timeout)
      pending.reject(new Error("Worker killed"))
    }
    handle.pending.clear()
  }

  /**
   * Handle a message from a worker process
   */
  private handleWorkerMessage(handle: WorkerHandle, line: string): void {
    try {
      const msg = JSON.parse(line) as {
        type?: string
        id?: string
        result?: unknown
        error?: { message: string; stack?: string }
        stream?: unknown
        tokens?: {
          accessToken: string
          refreshToken: string
          expiresAt?: string
        }
      }

      // Ready signal
      if (msg.type === "ready") {
        handle.ready = true
        if (handle.readyResolve) handle.readyResolve()
        this.logger.debug(
          `[Worker ${handle.account.email}] ready (pid: ${handle.process.pid})`
        )
        return
      }

      // Token refresh notification
      if (msg.type === "token_refresh" && msg.tokens) {
        handle.account.accessToken = msg.tokens.accessToken
        handle.account.refreshToken = msg.tokens.refreshToken
        if (msg.tokens.expiresAt) {
          handle.account.expiresAt = msg.tokens.expiresAt
        }
        this.logger.debug(`[Worker ${handle.account.email}] token refreshed`)
        return
      }

      // Response to a pending request
      const id = msg.id
      if (!id) return

      const pending = handle.pending.get(id)
      if (!pending) return

      // Streaming chunk
      if ("stream" in msg) {
        if (msg.stream === null) {
          // Stream end
          clearTimeout(pending.timeout)
          handle.pending.delete(id)
          pending.resolve(undefined)
        } else if (pending.streamCallback) {
          pending.streamCallback(msg.stream)
        }
        return
      }

      // Regular response
      clearTimeout(pending.timeout)
      handle.pending.delete(id)

      if (msg.error) {
        pending.reject(new Error(msg.error.message))
      } else {
        pending.resolve(msg.result)
      }
    } catch (err) {
      this.logger.warn(
        `Failed to parse worker message: ${(err as Error).message}`
      )
    }
  }

  private extractCloudCodeProjectId(result: unknown): string | null {
    if (!result || typeof result !== "object") return null
    const candidate = (result as { cloudaicompanionProject?: unknown })
      .cloudaicompanionProject
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim()
    }
    return null
  }

  private async ensureWorkerProjectId(handle: WorkerHandle): Promise<void> {
    const currentProjectId =
      typeof handle.account.projectId === "string"
        ? handle.account.projectId.trim()
        : ""
    if (currentProjectId) return

    const result = await this.sendRequest(
      handle,
      "loadCodeAssist",
      {
        metadata: {
          ideType: "ANTIGRAVITY",
        },
      },
      15000
    )
    const resolvedProjectId = this.extractCloudCodeProjectId(result)
    if (resolvedProjectId) {
      handle.account.projectId = resolvedProjectId
      this.logger.log(
        `[Worker ${handle.account.email}] resolved Cloud Code project: ${resolvedProjectId}`
      )
      return
    }

    this.logger.warn(
      `[Worker ${handle.account.email}] loadCodeAssist returned no Cloud Code project`
    )
  }

  private async primeWorkerBootstrap(handle: WorkerHandle): Promise<void> {
    if (handle.bootstrapComplete) return

    try {
      await this.sendRequest(handle, "fetchUserInfo", undefined, 10000)
    } catch (error) {
      this.logger.debug(
        `[Worker ${handle.account.email}] fetchUserInfo bootstrap skipped: ${(error as Error).message}`
      )
    }

    await this.ensureWorkerProjectId(handle)
    handle.bootstrapComplete = true
  }

  private async preparePayloadForWorker(
    handle: WorkerHandle,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.primeWorkerBootstrap(handle)
    const projectId =
      typeof handle.account.projectId === "string"
        ? handle.account.projectId.trim()
        : ""
    if (projectId) {
      payload.project = projectId
    }
  }

  /**
   * Send request to a specific worker and wait for response
   */
  private sendRequest(
    handle: WorkerHandle,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number = 60000
  ): Promise<unknown> {
    const id = `req-${++this.requestCounter}`

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        handle.pending.delete(id)
        reject(new Error(`Worker request timeout: ${method}`))
      }, timeoutMs)

      handle.pending.set(id, { resolve, reject, timeout })

      const request: WorkerRequest = { id, method, params }
      handle.process.stdin!.write(JSON.stringify(request) + "\n")
    })
  }

  /**
   * Send streaming request to a specific worker
   */
  private async sendStreamRequest(
    handle: WorkerHandle,
    method: string,
    params: Record<string, unknown>,
    onChunk: (chunk: unknown) => void,
    timeoutMs: number = 300000
  ): Promise<void> {
    const id = `req-${++this.requestCounter}`

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        handle.pending.delete(id)
        reject(new Error(`Worker stream timeout: ${method}`))
      }, timeoutMs)

      handle.pending.set(id, {
        resolve: () => resolve(),
        reject,
        streamCallback: onChunk,
        timeout,
      })

      const request: WorkerRequest = { id, method, params }
      handle.process.stdin!.write(JSON.stringify(request) + "\n")
    })
  }

  // =========================================================================
  // Public API
  // =========================================================================

  private normalizeWorkerIndex(workerCount: number): number {
    if (workerCount <= 0) return 0
    const normalized = this.currentWorkerIndex % workerCount
    return normalized < 0 ? normalized + workerCount : normalized
  }

  /**
   * Get the next available worker (sticky-preferred, then round-robin fallback)
   *
   * Selection priority:
   * 1. Preferred worker for this model (last successful) — if still available
   * 2. Round-robin across all ready workers, skipping those in cooldown
   * 3. Fallback: the worker whose cooldown expires soonest
   *
   * This avoids pointlessly rotating through all accounts on every request.
   * A worker stays preferred until it enters cooldown, at which point the
   * preference is cleared and round-robin takes over.
   */
  private getNextWorker(model?: string): WorkerHandle {
    const now = Date.now()
    const readyWorkers = this.workers.filter((w) => w.ready)
    if (readyWorkers.length === 0) {
      throw new Error("No ready workers in the process pool")
    }

    // 1. Try preferred worker for this model (sticky affinity)
    if (model) {
      const preferred = this.preferredWorkerByModel.get(model)
      if (preferred && preferred.ready) {
        const globalAvailable = preferred.cooldownUntil <= now
        const modelState = preferred.modelStates.get(model)
        const modelAvailable = !modelState || modelState.cooldownUntil <= now

        if (globalAvailable && modelAvailable) {
          // Update currentWorkerIndex to match so round-robin stays coherent
          const preferredIdx = readyWorkers.indexOf(preferred)
          if (preferredIdx >= 0) {
            this.currentWorkerIndex = preferredIdx
          }
          return preferred
        }
        // Preferred worker is in cooldown — clear preference so we don't
        // keep checking a stale entry on every request
        this.preferredWorkerByModel.delete(model)
      }
    }

    // 2. Round-robin across all ready workers (offset from 0 to stay on
    //    the current index if it is still available, avoiding unnecessary skips)
    const startIndex = this.normalizeWorkerIndex(readyWorkers.length)
    let fallbackIndex = startIndex
    let fallbackCooldown = Number.POSITIVE_INFINITY

    for (let offset = 0; offset < readyWorkers.length; offset++) {
      const index = (startIndex + offset) % readyWorkers.length
      const worker = readyWorkers[index]
      if (!worker) continue

      const globalAvailable = worker.cooldownUntil <= now
      const modelState = model ? worker.modelStates.get(model) : undefined
      const modelAvailable = !modelState || modelState.cooldownUntil <= now

      if (globalAvailable && modelAvailable) {
        this.currentWorkerIndex = index
        return worker
      }

      // Track the worker whose effective cooldown expires soonest
      const effectiveCooldown = Math.max(
        worker.cooldownUntil,
        modelState?.cooldownUntil ?? 0
      )
      if (effectiveCooldown < fallbackCooldown) {
        fallbackCooldown = effectiveCooldown
        fallbackIndex = index
      }
    }

    this.currentWorkerIndex = fallbackIndex
    return readyWorkers[fallbackIndex]!
  }

  private findReadyWorkerByProjectId(projectId: string): WorkerHandle | null {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) return null

    const now = Date.now()
    const readyWorkers = this.workers.filter((worker) => {
      if (!worker.ready) return false
      const workerProjectId =
        typeof worker.account.projectId === "string"
          ? worker.account.projectId.trim()
          : ""
      return workerProjectId === normalizedProjectId
    })
    if (readyWorkers.length === 0) return null

    const available = readyWorkers.filter(
      (worker) => worker.cooldownUntil <= now
    )
    return available[0] ?? readyWorkers[0] ?? null
  }

  /**
   * Switch to next worker (on error/quota exhaustion)
   */
  switchToNextWorker(): void {
    this.currentWorkerIndex++
    this.logger.log(
      `Switched to worker index ${this.currentWorkerIndex % Math.max(this.workers.length, 1)}`
    )
  }

  private formatDuration(delayMs: number): string {
    if (delayMs >= 3600_000) {
      return `${Math.floor(delayMs / 3600_000)}h ${Math.floor((delayMs % 3600_000) / 60_000)}m`
    }
    if (delayMs >= 60_000) {
      return `${Math.floor(delayMs / 60_000)}m ${Math.floor((delayMs % 60_000) / 1000)}s`
    }
    return `${delayMs}ms`
  }

  /**
   * @deprecated Use setCooldownForLastWorker() for accurate targeting.
   * Legacy: marks the last-used worker as rate-limited.
   */
  setCooldown(delayMs: number): void {
    this.setCooldownForLastWorker(delayMs)
  }

  /**
   * Mark the last-used worker (the one that actually executed the request)
   * as globally rate-limited for `delayMs` milliseconds.
   *
   * Unlike the old setCooldown which relied on a drifting currentWorkerIndex,
   * this precisely targets the worker that reported the error.
   */
  setCooldownForLastWorker(delayMs: number): void {
    const worker = this.lastUsedWorker
    if (!worker) return
    const now = Date.now()
    worker.cooldownUntil = now + delayMs
    this.logger.warn(
      `[Worker ${worker.account.email}] rate-limited, cooldown ${this.formatDuration(delayMs)}`
    )
  }

  /**
   * Mark the last-used worker as rate-limited for a specific model.
   * Inspired by CLIProxyAPI's MarkResult per-model state tracking.
   *
   * The worker may still be available for other models.
   * Also clears sticky preference so getNextWorker falls through to round-robin.
   */
  setModelCooldownForLastWorker(
    model: string,
    delayMs: number,
    quotaExhausted: boolean = false
  ): void {
    const worker = this.lastUsedWorker
    if (!worker || !model) return
    const now = Date.now()
    worker.modelStates.set(model, {
      cooldownUntil: now + delayMs,
      quotaExhausted,
    })
    // Clear sticky preference — this worker is no longer suitable for this model
    if (this.preferredWorkerByModel.get(model) === worker) {
      this.preferredWorkerByModel.delete(model)
    }
    this.logger.warn(
      `[Worker ${worker.account.email}] model ${model} ${
        quotaExhausted ? "quota exhausted" : "rate-limited"
      }, cooldown ${this.formatDuration(delayMs)}`
    )
  }

  /**
   * Clear per-model cooldown for the last-used worker (on success).
   */
  clearModelCooldownForLastWorker(model: string): void {
    const worker = this.lastUsedWorker
    if (!worker || !model) return
    worker.modelStates.delete(model)
  }

  /**
   * Mark the last-used worker as the preferred (sticky) worker for a model.
   * Called on successful request completion so subsequent requests reuse the
   * same worker instead of rotating through all accounts unnecessarily.
   */
  markSuccessForModel(model: string): void {
    const worker = this.lastUsedWorker
    if (!worker || !model) return
    this.preferredWorkerByModel.set(model, worker)
    // Also clear any lingering model cooldown (recovery)
    worker.modelStates.delete(model)
  }

  /**
   * Returns true if at least one ready worker is NOT in cooldown.
   */
  hasAvailableWorker(): boolean {
    const now = Date.now()
    return this.workers.some((w) => w.ready && w.cooldownUntil <= now)
  }

  /**
   * Returns true if at least one ready worker is available for a specific model.
   * Checks both global cooldown and per-model cooldown.
   */
  hasAvailableWorkerForModel(model: string): boolean {
    const now = Date.now()
    return this.workers.some((w) => {
      if (!w.ready || w.cooldownUntil > now) return false
      const modelState = model ? w.modelStates.get(model) : undefined
      return !modelState || modelState.cooldownUntil <= now
    })
  }

  /**
   * Returns the shortest remaining cooldown (ms) across all ready workers.
   * Returns 0 if a worker is already available.
   */
  getMinCooldownMs(): number {
    const now = Date.now()
    let min = Infinity
    for (const w of this.workers) {
      if (!w.ready) continue
      const remaining = Math.max(0, w.cooldownUntil - now)
      if (remaining < min) min = remaining
    }
    return min === Infinity ? 0 : min
  }

  /**
   * Returns the shortest remaining cooldown (ms) for a specific model.
   * Considers both global cooldown and per-model cooldown.
   */
  getMinCooldownMsForModel(model: string): number {
    const now = Date.now()
    let min = Infinity
    for (const w of this.workers) {
      if (!w.ready) continue
      const globalRemaining = Math.max(0, w.cooldownUntil - now)
      const modelState = model ? w.modelStates.get(model) : undefined
      const modelRemaining = modelState
        ? Math.max(0, modelState.cooldownUntil - now)
        : 0
      const remaining = Math.max(globalRemaining, modelRemaining)
      if (remaining < min) min = remaining
    }
    return min === Infinity ? 0 : min
  }

  /**
   * Check if any worker is available
   */
  isConfigured(): boolean {
    return this.workers.some((w) => w.ready)
  }

  /**
   * Check Cloud Code availability
   */
  async checkAvailability(): Promise<boolean> {
    try {
      const worker = this.getNextWorker()
      await this.primeWorkerBootstrap(worker)
      const result = (await this.sendRequest(
        worker,
        "checkAvailability",
        undefined,
        15000
      )) as { available: boolean }
      return result.available
    } catch (err) {
      this.logger.error(`Availability check failed: ${(err as Error).message}`)
      return false
    }
  }

  /**
   * Send non-streaming generate request.
   * If `model` is provided, per-model cooldown is checked during worker selection.
   */
  async generate(
    payload: Record<string, unknown>,
    model?: string
  ): Promise<unknown> {
    const worker = this.getNextWorker(model)
    this.lastUsedWorker = worker
    worker.requestCount++
    await this.preparePayloadForWorker(worker, payload)
    // Use long timeout for non-streaming generation, especially for deep thinking models
    return this.sendRequest(
      worker,
      "generate",
      { payload },
      this.GENERATE_TIMEOUT_MS
    )
  }

  /**
   * Send streaming generate request.
   * If `model` is provided, per-model cooldown is checked during worker selection.
   */
  async generateStream(
    payload: Record<string, unknown>,
    onChunk: (chunk: unknown) => void,
    model?: string
  ): Promise<void> {
    const worker = this.getNextWorker(model)
    this.lastUsedWorker = worker
    worker.requestCount++
    await this.preparePayloadForWorker(worker, payload)
    await this.sendStreamRequest(worker, "generateStream", { payload }, onChunk)
  }

  /**
   * Get available models from Cloud Code
   */
  async fetchAvailableModels(): Promise<unknown> {
    const worker = this.getNextWorker()
    await this.primeWorkerBootstrap(worker)
    return this.sendRequest(worker, "fetchAvailableModels")
  }

  async fetchUserInfo(projectId?: string): Promise<unknown> {
    const worker = this.getNextWorker()
    return this.sendRequest(worker, "fetchUserInfo", { projectId })
  }

  async loadCodeAssist(
    metadata?: Record<string, unknown>,
    projectId?: string
  ): Promise<unknown> {
    const worker = this.getNextWorker()
    const result = await this.sendRequest(worker, "loadCodeAssist", {
      metadata,
      projectId,
    })
    const resolvedProjectId = this.extractCloudCodeProjectId(result)
    if (resolvedProjectId) {
      worker.account.projectId = resolvedProjectId
    }
    return result
  }

  /**
   * Execute web search via Cloud Code API (through worker with auth)
   */
  async webSearch(query: string): Promise<unknown> {
    const worker = this.getNextWorker()
    await this.primeWorkerBootstrap(worker)
    return this.sendRequest(worker, "webSearch", { query })
  }

  async recordCodeAssistMetrics(
    payload: Record<string, unknown>
  ): Promise<unknown> {
    const requestedProjectId =
      typeof payload.project === "string" ? payload.project.trim() : ""
    const worker =
      this.findReadyWorkerByProjectId(requestedProjectId) ??
      this.getNextWorker()
    await this.primeWorkerBootstrap(worker)
    if (
      typeof payload.project !== "string" ||
      payload.project.trim().length === 0
    ) {
      const projectId =
        typeof worker.account.projectId === "string"
          ? worker.account.projectId.trim()
          : ""
      if (projectId) {
        payload.project = projectId
      }
    }
    return this.sendRequest(worker, "recordCodeAssistMetrics", { payload })
  }

  async recordTrajectoryAnalytics(
    payload: Record<string, unknown>,
    projectId?: string
  ): Promise<unknown> {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : ""
    const worker =
      this.findReadyWorkerByProjectId(normalizedProjectId) ??
      this.getNextWorker()
    return this.sendRequest(worker, "recordTrajectoryAnalytics", { payload })
  }

  /**
   * Get current worker account email
   */
  getCurrentEmail(): string | null {
    const readyWorkers = this.workers.filter((w) => w.ready)
    if (readyWorkers.length === 0) return null
    const idx = this.normalizeWorkerIndex(readyWorkers.length)
    const worker = readyWorkers[idx]
    return worker?.account.email ?? null
  }

  /**
   * Get the email of the worker that last executed a request.
   * Useful for logging which worker encountered an error.
   */
  getLastWorkerEmail(): string | null {
    return this.lastUsedWorker?.account.email ?? null
  }

  /**
   * Get total number of workers in the pool
   */
  get workerCount(): number {
    return this.workers.length
  }

  /**
   * Get pool status
   */
  getStatus(): {
    total: number
    ready: number
    available: number
    workers: Array<{
      email: string
      ready: boolean
      cooldownUntil: number
      requestCount: number
      pid: number | undefined
    }>
  } {
    const now = Date.now()
    return {
      total: this.workers.length,
      ready: this.workers.filter((w) => w.ready).length,
      available: this.workers.filter((w) => w.ready && w.cooldownUntil <= now)
        .length,
      workers: this.workers.map((w) => ({
        email: w.account.email,
        ready: w.ready,
        cooldownUntil: w.cooldownUntil,
        requestCount: w.requestCount,
        pid: w.process.pid,
      })),
    }
  }

  getPoolStatus(): BackendPoolStatus {
    const now = Date.now()
    const entries = this.workers.map((worker) => {
      const modelCooldowns = Array.from(worker.modelStates.entries())
        .filter(([, state]) => state.cooldownUntil > now)
        .map(([model, state]) => ({
          model,
          cooldownUntil: state.cooldownUntil,
          quotaExhausted: state.quotaExhausted,
        }))
        .sort((left, right) => left.cooldownUntil - right.cooldownUntil)

      let state: BackendPoolEntryState
      if (!worker.ready) {
        state = "unavailable"
      } else if (worker.cooldownUntil > now) {
        state = "cooldown"
      } else if (modelCooldowns.length > 0) {
        state = "degraded"
      } else {
        state = "ready"
      }

      return {
        id: worker.account.email,
        label: worker.account.email,
        state,
        cooldownUntil: worker.cooldownUntil,
        email: worker.account.email,
        ready: worker.ready,
        requestCount: worker.requestCount,
        pid: worker.process.pid,
        modelCooldowns,
      }
    })

    return {
      backend: "google",
      kind: "native-worker-pool",
      configured: this.workers.length > 0,
      total: entries.length,
      available: entries.filter(
        (entry) => entry.state === "ready" || entry.state === "degraded"
      ).length,
      ready: entries.filter((entry) => entry.state === "ready").length,
      degraded: entries.filter((entry) => entry.state === "degraded").length,
      cooling: entries.filter((entry) => entry.state === "cooldown").length,
      disabled: 0,
      unavailable: entries.filter((entry) => entry.state === "unavailable")
        .length,
      entries,
    }
  }
}
