import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { AsyncLocalStorage } from "async_hooks"
import { ChildProcess, spawn } from "child_process"
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as readline from "readline"
import { getAntigravityAccountsConfigPathCandidates } from "../../shared/protocol-bridge-paths"
import { UsageStatsService } from "../../usage"
import { UpstreamRequestAbortedError } from "../shared/abort-signal"
import {
  BackendPoolEntryState,
  BackendPoolModelCooldownReason,
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
  quotaProjectId?: string
  isGcpTos?: boolean
  cloudCodeUrlOverride?: string
  proxyUrl?: string
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
  timeoutMs?: number
  timeoutMessage?: string
  abortCleanup?: () => void
}

/**
 * Per-model cooldown state for a worker (inspired by CLIProxyAPI's ModelState)
 */
interface WorkerModelState {
  cooldownUntil: number // Date.now() timestamp; 0 = available
  quotaExhausted: boolean
  reason?: BackendPoolModelCooldownReason
}

/**
 * A managed worker process
 */
interface WorkerConversationSession {
  uuid: string
  seq: number
}

interface WorkerHandle {
  process: ChildProcess
  account: NativeAccount
  stableKey: string
  configSignature: string
  cloudCodeSessionId: string
  conversationSessions: Map<string, WorkerConversationSession>
  fallbackConversationSession: WorkerConversationSession
  ready: boolean
  draining: boolean
  pending: Map<string, PendingRequest>
  requestCount: number
  activeGenerationRequests: number
  cooldownUntil: number // Date.now() timestamp; 0 = available
  cooldownReason?: BackendPoolModelCooldownReason
  modelStates: Map<string, WorkerModelState> // per-model cooldown state
  disabledAt?: number
  disabledReason?: string
  bootstrapComplete: boolean
  readyResolve?: () => void // event-driven ready notification
  intentionalShutdown?: boolean
  drainReason?: string
  drainStartedAt?: number
  stderrBuffer?: string
}

export interface GoogleQuotaModelSnapshot {
  name: string
  displayName?: string
  remainingFraction?: number
  percentage?: number
  resetTime?: string
}

export interface GoogleQuotaAccountSnapshot {
  email: string
  ready: boolean
  requestCount: number
  cooldownUntil: number
  state: BackendPoolEntryState
  projectId?: string
  tier?: string
  models: GoogleQuotaModelSnapshot[]
  fetchedAt: number
}

export class WorkerPoolCooldownError extends Error {
  constructor(
    readonly waitMs: number,
    readonly model?: string,
    readonly reason?: BackendPoolModelCooldownReason
  ) {
    super(
      `No available worker${model ? ` for ${model}` : ""}; shortest cooldown ${waitMs}ms${
        reason ? ` (${reason})` : ""
      }`
    )
    this.name = "WorkerPoolCooldownError"
  }
}

interface WorkerSelectionOptions {
  excludedWorkerEmails?: ReadonlySet<string>
  requireGenerationCapacity?: boolean
}

const GO_WORKER_DIR = path.resolve(__dirname, "go-worker")
const GO_WORKER_MODULE_FILE = path.join(GO_WORKER_DIR, "go.mod")
const GO_WORKER_SUM_FILE = path.join(GO_WORKER_DIR, "go.sum")
const GO_WORKER_ENTRY = path.join(GO_WORKER_DIR, "main.go")
const GO_WORKER_BINARY_NAME =
  "agent-vibes-google-go-worker" + (process.platform === "win32" ? ".exe" : "")
const GO_WORKER_BUNDLED_BINARY = path.join(GO_WORKER_DIR, GO_WORKER_BINARY_NAME)

function pickFirstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }
  return undefined
}

function getNativeAccountStableKey(account: NativeAccount): string {
  return [
    account.email?.trim().toLowerCase() || "",
    account.quotaProjectId?.trim() || "",
    account.proxyUrl?.trim() || "",
    account.cloudCodeUrlOverride?.trim() || "",
    account.isGcpTos ? "gcp-tos" : "non-gcp",
  ].join("|")
}

function getNativeAccountConfigSignature(account: NativeAccount): string {
  return [
    account.refreshToken?.trim() || "",
    account.projectId?.trim() || "",
    account.quotaProjectId?.trim() || "",
    account.proxyUrl?.trim() || "",
    account.cloudCodeUrlOverride?.trim() || "",
    account.isGcpTos ? "gcp-tos" : "non-gcp",
  ].join("|")
}

function generateCloudCodeSessionId(): string {
  const buf = crypto.randomBytes(8)
  const unsigned = buf.readBigUInt64BE()
  const signed =
    unsigned > BigInt("9223372036854775807")
      ? unsigned - BigInt("18446744073709551616")
      : unsigned
  return signed.toString()
}

function extractConversationKeyFromRequestId(
  payload: Record<string, unknown>
): string {
  const explicitKey =
    typeof payload.__workerConversationKey === "string"
      ? payload.__workerConversationKey.trim()
      : ""
  if (explicitKey) return explicitKey

  const requestId =
    typeof payload.requestId === "string" ? payload.requestId.trim() : ""
  const match = /^agent\/\d+\/([^/]+)\/\d+$/.exec(requestId)
  return match?.[1] || "__fallback__"
}

function resolveWorkerConversationSession(
  handle: WorkerHandle,
  payload: Record<string, unknown>
): WorkerConversationSession {
  const conversationKey = extractConversationKeyFromRequestId(payload)
  if (conversationKey === "__fallback__") {
    return handle.fallbackConversationSession
  }

  const existing = handle.conversationSessions.get(conversationKey)
  if (existing) return existing

  const created = { uuid: crypto.randomUUID(), seq: 0 }
  handle.conversationSessions.set(conversationKey, created)
  return created
}

/**
 * ProcessPoolService — Manages a pool of Go native worker processes
 *
 * Each worker process:
 * - Runs as a compiled Go binary (aligned with Antigravity Go LS fingerprint)
 * - Makes Cloud Code API calls with native Go TLS/HTTP/2 fingerprint
 * - Communicates via JSON Lines over stdin/stdout
 */
@Injectable()
export class ProcessPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProcessPoolService.name)
  private readonly workers: WorkerHandle[] = []
  private defaultWorkerIndex = -1
  /** Per-model round-robin indices to prevent cross-model interference */
  private readonly workerIndexByModel = new Map<string, number>()
  private requestCounter = 0
  /**
   * Request-scoped worker context using AsyncLocalStorage.
   * Each generate/generateStream call binds the selected worker to the current
   * async context via enterWith(), so that subsequent setCooldownForLastWorker()
   * calls in the same async chain (e.g. catch blocks in google.service.ts)
   * target the correct worker — even under concurrent requests.
   */
  private readonly workerContext = new AsyncLocalStorage<WorkerHandle>()
  /**
   * @deprecated Legacy fallback — only used when workerContext has no store
   * (i.e. calls outside of generate/generateStream async context).
   */
  private lastUsedWorker: WorkerHandle | null = null
  /** Per-model sticky affinity: remember the last worker that succeeded for each model */
  private readonly preferredWorkerByModel = new Map<string, WorkerHandle>()
  /** Pool-level model gates for transient global model saturation (e.g. 503 capacity exhausted). */
  private readonly poolModelCooldowns = new Map<
    string,
    { cooldownUntil: number; reason?: BackendPoolModelCooldownReason }
  >()
  private readonly MAX_CONCURRENT_GENERATIONS_PER_WORKER = 1
  private readonly WORKER_BUSY_RETRY_HINT_MS = 1000
  private readonly GOOGLE_QUOTA_SNAPSHOT_CACHE_TTL_MS = 60_000
  /**
   * Google quota snapshots report a protected floor around 20% remaining; keep
   * an extra 1% buffer so near-boundary accounts are filtered before they
   * start failing in active scheduling.
   */
  private readonly GOOGLE_QUOTA_EXHAUSTED_REMAINING_FRACTION = 0.21
  /**
   * When quota snapshots omit an explicit reset boundary, keep exhausted
   * models out of rotation for a conservative fallback window.
   */
  private readonly GOOGLE_QUOTA_EXHAUSTED_FALLBACK_COOLDOWN_MS =
    4.5 * 60 * 60 * 1000
  /** Timeout for non-streaming generation (deep thinking models may take long) */
  private readonly GENERATE_TIMEOUT_MS = 3_600_000 // 1 hour
  private antigravityGoBinary: string | null = null
  private antigravityGoBinaryOwned = false
  private accountsConfigPath: string | null = null
  private accountsWatcher: fs.FSWatcher | null = null
  private accountsReloadTimer: ReturnType<typeof setTimeout> | null = null
  private reloadAccountsPromise: Promise<number> | null = null
  private googleQuotaSnapshotCache: GoogleQuotaAccountSnapshot[] = []
  private googleQuotaSnapshotFetchedAt = 0
  /** Model to fallback to when all Claude workers are quota-exhausted (configured in antigravity-accounts.json) */
  private _quotaFallbackModel: string | null = null

  constructor(
    private readonly configService: ConfigService,
    private readonly usageStats: UsageStatsService
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log("Initializing native process pool...")

    const goBinary = await this.prepareGoWorkerBinary()
    if (!goBinary) {
      this.logger.warn("Go worker binary unavailable — native pool disabled")
      return
    }
    this.antigravityGoBinary = goBinary
    this.logger.log(`Using Go native worker backend: ${goBinary}`)

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

    // Start only local workers during bootstrap to avoid probing Google upstream
    // during cold start. Defer bootstrap / availability checks until the first
    // real request or an explicit health check.
    this.startAccountsWatcher()
  }

  private spawnAsync(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv }
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        ...options,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString()
      })
      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString()
      })
      child.on("error", (err) => reject(err))
      child.on("close", (code) => {
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(stderr.trim() || stdout.trim() || `exit ${code}`))
      })
    })
  }

  private isGoBinaryCached(binaryPath: string): boolean {
    try {
      const binaryStat = fs.statSync(binaryPath)
      const sourceFiles = [
        GO_WORKER_MODULE_FILE,
        GO_WORKER_SUM_FILE,
        GO_WORKER_ENTRY,
      ]
      const latestSourceMtime = Math.max(
        ...sourceFiles.map((f) => fs.statSync(f).mtimeMs)
      )
      return binaryStat.mtimeMs > latestSourceMtime
    } catch {
      return false
    }
  }

  private hasBundledGoWorkerBinary(): boolean {
    try {
      return fs.statSync(GO_WORKER_BUNDLED_BINARY).isFile()
    } catch {
      return false
    }
  }

  private async prepareGoWorkerBinary(): Promise<string | null> {
    const sourceFiles = [
      GO_WORKER_MODULE_FILE,
      GO_WORKER_SUM_FILE,
      GO_WORKER_ENTRY,
    ]
    const hasBundledBinary = this.hasBundledGoWorkerBinary()
    for (const file of sourceFiles) {
      if (!fs.existsSync(file)) {
        if (hasBundledBinary) {
          this.antigravityGoBinaryOwned = false
          this.logger.warn(
            `Go worker source not found: ${file}; using bundled Go worker binary`
          )
          return GO_WORKER_BUNDLED_BINARY
        }
        this.logger.error(`Go worker source not found: ${file}`)
        return null
      }
    }

    const goCommand =
      pickFirstNonEmptyString(
        this.configService?.get<string>("GO_BINARY", ""),
        process.env.GO_BINARY
      ) || "go"

    try {
      await this.spawnAsync(goCommand, ["version"])
    } catch {
      if (hasBundledBinary) {
        this.antigravityGoBinaryOwned = false
        this.logger.warn(
          `Go toolchain not available (tried: ${goCommand}). Using bundled Go worker binary.`
        )
        return GO_WORKER_BUNDLED_BINARY
      }
      this.logger.warn(
        `Go toolchain not available (tried: ${goCommand}). Install Go or set GO_BINARY.`
      )
      return null
    }

    const outputDir = path.join(os.tmpdir(), "agent-vibes", "native-workers")
    fs.mkdirSync(outputDir, { recursive: true })
    const outputBinary = path.join(outputDir, GO_WORKER_BINARY_NAME)

    if (this.isGoBinaryCached(outputBinary)) {
      this.antigravityGoBinaryOwned = true
      this.logger.log(`Using cached Go worker binary: ${outputBinary}`)
      return outputBinary
    }

    try {
      await this.spawnAsync(goCommand, ["build", "-o", outputBinary, "."], {
        cwd: GO_WORKER_DIR,
        env: {
          ...process.env,
          // Use BoringCrypto (BoringSSL) for TLS to match the official LS
          // binary's TLS fingerprint (JA3/JA4).  The LS is compiled with
          // go1.27+boringcrypto which produces a distinct cipher suite list
          // and TLS extension order.  Without this, Google's frontend (GFE)
          // can distinguish our worker from the official IDE client.
          GOEXPERIMENT: "boringcrypto",
          CGO_ENABLED: "1",
        },
      })
    } catch (err) {
      this.logger.error(
        `Failed to build Go native worker: ${(err as Error).message}`
      )
      if (hasBundledBinary) {
        this.antigravityGoBinaryOwned = false
        this.logger.warn(
          `Falling back to bundled Go worker binary: ${GO_WORKER_BUNDLED_BINARY}`
        )
        return GO_WORKER_BUNDLED_BINARY
      }
      return null
    }

    try {
      fs.chmodSync(outputBinary, 0o755)
    } catch {
      // chmod best-effort
    }

    this.antigravityGoBinaryOwned = true
    return outputBinary
  }

  /**
   * Pre-flight quota check: probe each worker with a minimal request.
   * This is observability-only and must not write pessimistic pool state.
   */
  private async preflightQuotaCheck(): Promise<void> {
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
            this.logger.warn(
              `[Worker ${worker.account.email}] quota check: ✗ rate-limited (${msg.slice(0, 120)})`
            )
          } else if (
            msg.includes("Worker request timeout") ||
            msg.includes("Worker stream timeout")
          ) {
            this.logger.warn(
              `[Worker ${worker.account.email}] quota check: ✗ temporarily unavailable (${msg.slice(0, 120)})`
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
    this.stopAccountsWatcher()
    for (const worker of this.workers) {
      this.killWorker(worker)
    }
    this.workers.length = 0
    if (this.antigravityGoBinary && this.antigravityGoBinaryOwned) {
      try {
        fs.unlinkSync(this.antigravityGoBinary)
      } catch {
        /* best-effort */
      }
    }
    this.antigravityGoBinary = null
    this.antigravityGoBinaryOwned = false
  }

  private getDefaultProxyUrl(): string | undefined {
    return pickFirstNonEmptyString(
      this.configService?.get<string>("ANTIGRAVITY_PROXY_URL", ""),
      this.configService?.get<string>("HTTPS_PROXY", ""),
      this.configService?.get<string>("HTTP_PROXY", ""),
      process.env.ANTIGRAVITY_PROXY_URL,
      process.env.HTTPS_PROXY,
      process.env.HTTP_PROXY
    )
  }

  private normalizeNativeAccount(
    account: NativeAccount,
    defaultProxyUrl: string | undefined = this.getDefaultProxyUrl()
  ): NativeAccount {
    const rawProjectId =
      typeof account.projectId === "string" &&
      account.projectId.trim().length > 0
        ? account.projectId.trim()
        : undefined
    const rawQuotaProjectId =
      typeof account.quotaProjectId === "string" &&
      account.quotaProjectId.trim().length > 0
        ? account.quotaProjectId.trim()
        : undefined
    const proxyUrl =
      pickFirstNonEmptyString(account.proxyUrl) ?? defaultProxyUrl

    return {
      ...account,
      email: account.email?.trim() || account.email,
      projectId: rawQuotaProjectId ? rawProjectId : undefined,
      quotaProjectId: rawQuotaProjectId ?? rawProjectId,
      ...(proxyUrl ? { proxyUrl } : {}),
    }
  }

  /**
   * Load accounts from config file.
   * Canonical location: apps/protocol-bridge/data/antigravity-accounts.json
   * (generated by: npm run antigravity:sync -- --ide)
   */
  private loadAccounts(): NativeAccount[] {
    const configPaths = getAntigravityAccountsConfigPathCandidates()
    const defaultProxyUrl = this.getDefaultProxyUrl()

    for (const configPath of configPaths) {
      if (fs.existsSync(configPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
            accounts?: NativeAccount[]
            quotaFallbackModel?: string
          }
          if (Array.isArray(data.accounts) && data.accounts.length > 0) {
            this.accountsConfigPath = configPath
            this.logger.log(
              `Loaded ${data.accounts.length} account(s) from ${configPath}`
            )
            if (
              typeof data.quotaFallbackModel === "string" &&
              data.quotaFallbackModel.trim()
            ) {
              this._quotaFallbackModel = data.quotaFallbackModel.trim()
              this.logger.log(
                `Quota fallback model configured: ${this._quotaFallbackModel}`
              )
            }
            return data.accounts.map((account) =>
              this.normalizeNativeAccount(account, defaultProxyUrl)
            )
          }
        } catch (err) {
          this.logger.warn(
            `Failed to parse ${configPath}: ${(err as Error).message}`
          )
        }
      }
    }

    this.accountsConfigPath = null
    this.logger.warn(
      "No Antigravity accounts configured — run: npm run antigravity:sync -- --ide"
    )
    return []
  }

  private stopAccountsWatcher(): void {
    if (this.accountsReloadTimer) {
      clearTimeout(this.accountsReloadTimer)
      this.accountsReloadTimer = null
    }
    if (this.accountsWatcher) {
      this.accountsWatcher.close()
      this.accountsWatcher = null
    }
  }

  private startAccountsWatcher(): void {
    this.stopAccountsWatcher()
    if (!this.accountsConfigPath) return

    const watchedFile = this.accountsConfigPath
    const watchedDir = path.dirname(watchedFile)
    const watchedBase = path.basename(watchedFile)

    try {
      this.accountsWatcher = fs.watch(watchedDir, (_eventType, filename) => {
        if (filename && filename.toString() !== watchedBase) {
          return
        }
        if (this.accountsReloadTimer) {
          clearTimeout(this.accountsReloadTimer)
        }
        this.accountsReloadTimer = setTimeout(() => {
          void this.reloadAccounts()
            .then((changes) => {
              if (changes > 0) {
                this.logger.log(
                  `[Hot-reload] Antigravity accounts file changed: ${watchedBase}`
                )
              }
            })
            .catch((error) => {
              this.logger.warn(
                `[Hot-reload] Failed to reload Antigravity accounts from watcher: ${(error as Error).message}`
              )
            })
        }, 400)
      })
      this.logger.log(
        `[Hot-reload] Watching Antigravity accounts: ${watchedFile}`
      )
    } catch (error) {
      this.logger.warn(
        `[Hot-reload] Failed to watch Antigravity accounts file ${watchedFile}: ${(error as Error).message}`
      )
    }
  }

  /**
   * Get the configured quota fallback model.
   * When all Claude workers are quota-exhausted, the system can fallback to this model
   * instead of returning 429 to the client.
   */
  get quotaFallbackModel(): string | null {
    return this._quotaFallbackModel
  }

  /**
   * Spawn a native worker process for the given account
   */
  private async spawnWorker(account: NativeAccount): Promise<void> {
    const child = this.spawnGoWorker()

    const normalizedAccount = {
      ...account,
      email: account.email?.trim() || account.email,
    }
    const handle: WorkerHandle = {
      process: child,
      account: normalizedAccount,
      stableKey: getNativeAccountStableKey(normalizedAccount),
      configSignature: getNativeAccountConfigSignature(normalizedAccount),
      cloudCodeSessionId: generateCloudCodeSessionId(),
      conversationSessions: new Map(),
      fallbackConversationSession: { uuid: crypto.randomUUID(), seq: 0 },
      ready: false,
      draining: false,
      pending: new Map(),
      requestCount: 0,
      activeGenerationRequests: 0,
      cooldownUntil: 0,
      cooldownReason: undefined,
      modelStates: new Map(),
      disabledAt: undefined,
      disabledReason: undefined,
      bootstrapComplete: false,
      stderrBuffer: "",
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
      this.logWorkerStderr(handle, data.toString())
    })

    child.on("exit", (code: number | null) => {
      this.flushWorkerStderr(handle)
      this.logger.warn(`[Worker ${account.email}] exited with code ${code}`)
      handle.ready = false
      // Reject all pending requests
      for (const [, pending] of handle.pending) {
        clearTimeout(pending.timeout)
        pending.reject(new Error(`Worker process exited (code ${code})`))
      }
      handle.pending.clear()
      if (handle.intentionalShutdown) {
        return
      }
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
        quotaProjectId: account.quotaProjectId,
        isGcpTos: account.isGcpTos ?? false,
        cloudCodeUrlOverride: account.cloudCodeUrlOverride,
        proxyUrl: account.proxyUrl,
      },
    })

    handle.ready = true
    this.logger.log(`[Worker ${account.email}] initialized and ready`)
  }

  private spawnGoWorker(): ChildProcess {
    if (!this.antigravityGoBinary) {
      throw new Error("Go worker binary not initialized")
    }

    const workerEnv: Record<string, string | undefined> = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      HTTP_PROXY: process.env.HTTP_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      ANTIGRAVITY_PROXY_URL: process.env.ANTIGRAVITY_PROXY_URL,
      SSL_CERT_FILE: process.env.SSL_CERT_FILE,
      SSL_CERT_DIR: process.env.SSL_CERT_DIR,
    }

    return spawn(this.antigravityGoBinary, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: workerEnv,
    })
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
  private killWorker(handle: WorkerHandle, intentional: boolean = false): void {
    handle.intentionalShutdown = intentional
    try {
      handle.process.kill("SIGTERM")
    } catch {
      // Process may already be dead
    }
    for (const [, pending] of handle.pending) {
      clearTimeout(pending.timeout)
      pending.abortCleanup?.()
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
          pending.abortCleanup?.()
          handle.pending.delete(id)
          pending.resolve(undefined)
          if (handle.draining && handle.pending.size === 0) {
            this.scheduleWorkerRetirement(handle)
          }
        } else if (pending.streamCallback) {
          if (pending.timeoutMs) {
            clearTimeout(pending.timeout)
            pending.timeout = setTimeout(() => {
              handle.pending.delete(id)
              pending.reject(
                new Error(pending.timeoutMessage || "Worker stream timeout")
              )
            }, pending.timeoutMs)
          }
          pending.streamCallback(msg.stream)
        }
        return
      }

      // Regular response
      clearTimeout(pending.timeout)
      pending.abortCleanup?.()
      handle.pending.delete(id)

      if (msg.error) {
        pending.reject(new Error(msg.error.message))
      } else {
        pending.resolve(msg.result)
      }

      if (handle.draining && handle.pending.size === 0) {
        this.scheduleWorkerRetirement(handle)
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

  private applyWorkerCloudCodeIdentity(
    handle: WorkerHandle,
    payload: Record<string, unknown>
  ): void {
    const request =
      payload.request && typeof payload.request === "object"
        ? (payload.request as Record<string, unknown>)
        : null
    if (!request) return

    request.sessionId = handle.cloudCodeSessionId

    const requestType =
      typeof payload.requestType === "string" ? payload.requestType.trim() : ""
    if (requestType !== "agent") {
      return
    }

    const conversationSession = resolveWorkerConversationSession(
      handle,
      payload
    )
    payload.requestId = `agent/${Date.now()}/${conversationSession.uuid}/${++conversationSession.seq}`
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
    this.applyWorkerCloudCodeIdentity(handle, payload)
  }

  private summarizeCloudCodePayload(payload: Record<string, unknown>): string {
    const request =
      payload.request && typeof payload.request === "object"
        ? (payload.request as Record<string, unknown>)
        : {}
    const generationConfig =
      request.generationConfig && typeof request.generationConfig === "object"
        ? (request.generationConfig as Record<string, unknown>)
        : {}
    const contentsCount = Array.isArray(request.contents)
      ? request.contents.length
      : 0
    const toolNames = Array.isArray(request.tools)
      ? request.tools
          .flatMap((tool) =>
            tool && typeof tool === "object"
              ? (((tool as Record<string, unknown>).functionDeclarations as
                  | Array<Record<string, unknown>>
                  | undefined) ?? [])
              : []
          )
          .map((declaration) =>
            typeof declaration.name === "string" ? declaration.name : ""
          )
          .filter(Boolean)
      : []
    const thinkingConfig =
      generationConfig.thinkingConfig &&
      typeof generationConfig.thinkingConfig === "object"
        ? JSON.stringify(generationConfig.thinkingConfig)
        : "none"

    return (
      `project=${typeof payload.project === "string" ? payload.project : ""} ` +
      `model=${typeof payload.model === "string" ? payload.model : ""} ` +
      `requestType=${typeof payload.requestType === "string" ? payload.requestType : ""} ` +
      `requestId=${typeof payload.requestId === "string" ? payload.requestId : ""} ` +
      `sessionId=${typeof request.sessionId === "string" || typeof request.sessionId === "number" ? String(request.sessionId) : ""} ` +
      `contents=${contentsCount} ` +
      `maxOutputTokens=${typeof generationConfig.maxOutputTokens === "number" ? generationConfig.maxOutputTokens : ""} ` +
      `thinkingConfig=${thinkingConfig} ` +
      `tools=${toolNames.join(",") || "none"}`
    )
  }

  private logPreparedCloudCodePayload(
    handle: WorkerHandle,
    payload: Record<string, unknown>,
    method: string
  ): void {
    this.logger.debug(
      `[Worker ${handle.account.email}] prepared ${method} payload: ${this.summarizeCloudCodePayload(payload)}`
    )
  }

  private createOutboundWorkerPayload(
    payload: Record<string, unknown>
  ): Record<string, unknown> {
    const outboundPayload = { ...payload }
    delete outboundPayload.__workerConversationKey
    return outboundPayload
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
    timeoutMs: number = 300000,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const id = `req-${++this.requestCounter}`

    return new Promise((resolve, reject) => {
      if (abortSignal?.aborted) {
        reject(
          new UpstreamRequestAbortedError(this.describeAbortReason(abortSignal))
        )
        return
      }

      const timeout = setTimeout(() => {
        cleanupAbort()
        handle.pending.delete(id)
        this.cancelWorkerRequest(handle, id, `Worker stream timeout: ${method}`)
        reject(new Error(`Worker stream timeout: ${method}`))
      }, timeoutMs)
      let cleanupAbort: () => void = () => undefined

      if (abortSignal) {
        const onAbort = () => {
          handle.pending.delete(id)
          clearTimeout(timeout)
          this.cancelWorkerRequest(
            handle,
            id,
            this.describeAbortReason(abortSignal)
          )
          reject(
            new UpstreamRequestAbortedError(
              this.describeAbortReason(abortSignal)
            )
          )
        }

        if (abortSignal.aborted) {
          clearTimeout(timeout)
          reject(
            new UpstreamRequestAbortedError(
              this.describeAbortReason(abortSignal)
            )
          )
          return
        }

        abortSignal.addEventListener("abort", onAbort, { once: true })
        cleanupAbort = () => {
          abortSignal.removeEventListener("abort", onAbort)
        }
      }

      handle.pending.set(id, {
        resolve: () => resolve(),
        reject,
        streamCallback: onChunk,
        timeout,
        timeoutMs,
        timeoutMessage: `Worker stream timeout: ${method}`,
        abortCleanup: cleanupAbort,
      })

      const request: WorkerRequest = { id, method, params }
      handle.process.stdin!.write(JSON.stringify(request) + "\n")
    })
  }

  private describeAbortReason(abortSignal: AbortSignal): string {
    const reason: unknown = abortSignal.reason
    if (typeof reason === "string" && reason.trim()) {
      return reason.trim()
    }
    if (reason instanceof Error && reason.message.trim()) {
      return reason.message.trim()
    }
    return "Worker stream aborted"
  }

  private cancelWorkerRequest(
    handle: WorkerHandle,
    requestId: string,
    reason: string
  ): void {
    try {
      const controlRequest: WorkerRequest = {
        id: `req-${++this.requestCounter}`,
        method: "cancelRequest",
        params: {
          requestId,
          reason,
        },
      }
      handle.process.stdin!.write(JSON.stringify(controlRequest) + "\n")
    } catch {
      // Worker may already be unavailable.
    }
  }

  // =========================================================================
  // Public API
  // =========================================================================

  private normalizeWorkerIndex(workerCount: number, index: number): number {
    if (workerCount <= 0) return 0
    const normalized = index % workerCount
    return normalized < 0 ? normalized + workerCount : normalized
  }

  /**
   * Get or initialize the round-robin index for a given model.
   * Each model maintains its own index to prevent cross-model interference.
   * Falls back to defaultWorkerIndex for model-less calls.
   */
  private getWorkerIndex(model?: string): number {
    if (!model) return this.defaultWorkerIndex
    return this.workerIndexByModel.get(model) ?? this.defaultWorkerIndex
  }

  private setWorkerIndex(index: number, model?: string): void {
    if (model) {
      this.workerIndexByModel.set(model, index)
    }
    this.defaultWorkerIndex = index
  }

  private advanceWorkerIndexPastWorker(
    worker: WorkerHandle,
    model?: string
  ): void {
    const readyWorkers = this.workers.filter((candidate) =>
      this.shouldWorkerAcceptNewRequests(candidate)
    )
    if (readyWorkers.length === 0) return

    const workerIndex = readyWorkers.indexOf(worker)
    if (workerIndex < 0) return

    // Start the next round-robin scan after the worker that just failed so a
    // zero/near-zero cooldown does not cause an immediate self-selection loop.
    this.setWorkerIndex(workerIndex + 1, model)
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
  private getNextWorker(
    model?: string,
    allowCooldownFallback: boolean = true,
    options: WorkerSelectionOptions = {}
  ): WorkerHandle {
    const now = Date.now()
    const poolModelCooldown = model
      ? this.getActivePoolModelCooldown(model, now)
      : undefined
    if (poolModelCooldown) {
      throw new WorkerPoolCooldownError(
        poolModelCooldown.cooldownUntil - now,
        model,
        poolModelCooldown.reason
      )
    }
    const readyWorkers = this.workers.filter((worker) => {
      if (!this.shouldWorkerAcceptNewRequests(worker)) return false
      const email = worker.account.email?.trim() || ""
      return !options.excludedWorkerEmails?.has(email)
    })
    if (readyWorkers.length === 0) {
      throw new WorkerPoolCooldownError(
        options.requireGenerationCapacity ? this.WORKER_BUSY_RETRY_HINT_MS : 0,
        model,
        options.requireGenerationCapacity ? "transient" : undefined
      )
    }

    const selectableWorkers = options.requireGenerationCapacity
      ? readyWorkers.filter(
          (worker) =>
            worker.activeGenerationRequests <
            this.MAX_CONCURRENT_GENERATIONS_PER_WORKER
        )
      : readyWorkers
    if (selectableWorkers.length === 0) {
      throw new WorkerPoolCooldownError(
        this.WORKER_BUSY_RETRY_HINT_MS,
        model,
        "transient"
      )
    }

    // 1. Try preferred worker for this model (sticky affinity)
    if (model) {
      const preferred = this.preferredWorkerByModel.get(model)
      if (preferred) {
        const globalAvailable = preferred.cooldownUntil <= now
        const modelState = preferred.modelStates.get(model)
        const modelAvailable = !modelState || modelState.cooldownUntil <= now

        if (
          selectableWorkers.includes(preferred) &&
          globalAvailable &&
          modelAvailable
        ) {
          // Update worker index to match so round-robin stays coherent
          const preferredIdx = selectableWorkers.indexOf(preferred)
          if (preferredIdx >= 0) {
            this.setWorkerIndex(preferredIdx, model)
          }
          return preferred
        }

        // Clear sticky preference when the worker has become permanently
        // unschedulable for the model (disabled/draining/cooldown). Keep the
        // preference when this request merely excluded the worker or it is busy.
        if (
          !this.shouldWorkerAcceptNewRequests(preferred) ||
          !globalAvailable ||
          !modelAvailable
        ) {
          this.preferredWorkerByModel.delete(model)
        }
      }
    }

    // 2. Round-robin across all ready workers (offset from 0 to stay on
    //    the current index if it is still available, avoiding unnecessary skips)
    const currentIndex = this.getWorkerIndex(model)
    const startIndex = this.normalizeWorkerIndex(
      selectableWorkers.length,
      currentIndex
    )
    let fallbackIndex = startIndex
    let fallbackCooldown = Number.POSITIVE_INFINITY
    let fallbackReason: BackendPoolModelCooldownReason | undefined

    for (let offset = 0; offset < selectableWorkers.length; offset++) {
      const index = (startIndex + offset) % selectableWorkers.length
      const worker = selectableWorkers[index]
      if (!worker) continue

      const globalAvailable = worker.cooldownUntil <= now
      const modelState = model ? worker.modelStates.get(model) : undefined
      const modelAvailable = !modelState || modelState.cooldownUntil <= now

      if (globalAvailable && modelAvailable) {
        this.setWorkerIndex(index, model)
        return worker
      }

      // Track the worker whose effective cooldown expires soonest
      let effectiveCooldown = worker.cooldownUntil
      let effectiveReason = worker.cooldownReason
      const modelCooldownUntil = modelState?.cooldownUntil ?? 0
      if (modelCooldownUntil >= effectiveCooldown) {
        effectiveCooldown = modelCooldownUntil
        effectiveReason = modelState?.reason ?? effectiveReason
      }
      if (effectiveCooldown < fallbackCooldown) {
        fallbackCooldown = effectiveCooldown
        fallbackIndex = index
        fallbackReason = effectiveReason
      }
    }

    const fallbackWorker = selectableWorkers[fallbackIndex]
    const remainingMs = Number.isFinite(fallbackCooldown)
      ? Math.max(0, fallbackCooldown - now)
      : 0

    if (!allowCooldownFallback && remainingMs > 0) {
      throw new WorkerPoolCooldownError(remainingMs, model, fallbackReason)
    }

    this.setWorkerIndex(fallbackIndex, model)
    return fallbackWorker!
  }

  private findReadyWorkerByProjectId(projectId: string): WorkerHandle | null {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) return null

    const now = Date.now()
    const readyWorkers = this.workers.filter((worker) => {
      if (!this.shouldWorkerAcceptNewRequests(worker)) return false
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

  private shouldWorkerAcceptNewRequests(worker: WorkerHandle): boolean {
    return worker.ready && !worker.draining && !this.isWorkerDisabled(worker)
  }

  private isWorkerDisabled(worker: WorkerHandle): boolean {
    return (
      typeof worker.disabledAt === "number" &&
      Number.isFinite(worker.disabledAt)
    )
  }

  private clearWorkerPreference(worker: WorkerHandle): void {
    for (const [model, preferred] of this.preferredWorkerByModel.entries()) {
      if (preferred === worker) {
        this.preferredWorkerByModel.delete(model)
      }
    }
  }

  private findWorkerByStableKey(stableKey: string): WorkerHandle | null {
    return (
      [...this.workers]
        .reverse()
        .find((worker) => worker.stableKey === stableKey && !worker.draining) ??
      null
    )
  }

  private async replaceWorkerWithAccount(
    worker: WorkerHandle,
    account: NativeAccount,
    reason: string
  ): Promise<void> {
    const normalized = this.normalizeNativeAccount(account)
    await this.spawnWorker(normalized)
    this.markWorkerDraining(worker, reason)
    this.scheduleWorkerRetirement(worker)
    this.logger.log(
      `[Hot-reload] Replaced Antigravity worker ${worker.account.email} (${reason})`
    )
  }

  private markWorkerDraining(handle: WorkerHandle, reason: string): void {
    if (handle.draining) return
    handle.draining = true
    handle.drainReason = reason
    handle.drainStartedAt = Date.now()
    if (this.lastUsedWorker === handle) {
      this.lastUsedWorker = null
    }
    for (const [model, preferred] of this.preferredWorkerByModel.entries()) {
      if (preferred === handle) {
        this.preferredWorkerByModel.delete(model)
      }
    }
    this.logger.log(
      `[Hot-reload] Draining Antigravity worker ${handle.account.email} (${reason})`
    )
  }

  private scheduleWorkerRetirement(handle: WorkerHandle): void {
    const retire = () => {
      if (!handle.draining) return
      if (handle.pending.size > 0) {
        setTimeout(retire, 250)
        return
      }
      const idx = this.workers.indexOf(handle)
      if (idx >= 0) {
        this.workers.splice(idx, 1)
      }
      this.killWorker(handle, true)
      this.logger.log(
        `[Hot-reload] Retired drained Antigravity worker: ${handle.account.email}`
      )
    }
    setTimeout(retire, 0)
  }

  /**
   * Switch to next worker (on error/quota exhaustion)
   */
  switchToNextWorker(): void {
    this.defaultWorkerIndex++
    this.logger.log(
      `[pool-rotate] Switched to worker index ${this.defaultWorkerIndex % Math.max(this.workers.length, 1)}`
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

  private logWorkerStderr(handle: WorkerHandle, chunk: string): void {
    const combined = `${handle.stderrBuffer || ""}${chunk}`
    const lines = combined.split(/\r?\n/)
    handle.stderrBuffer = lines.pop() ?? ""

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      this.logger.debug(`[Worker ${handle.account.email}] ${line}`)
    }
  }

  private flushWorkerStderr(handle: WorkerHandle): void {
    const line = handle.stderrBuffer?.trim()
    handle.stderrBuffer = ""
    if (!line) return
    this.logger.debug(`[Worker ${handle.account.email}] ${line}`)
  }

  /**
   * Resolve the worker for the current async context.
   * Prefers the request-scoped workerContext (concurrency-safe),
   * falls back to lastUsedWorker for legacy code paths.
   */
  private resolveContextWorker(): WorkerHandle | null {
    return this.workerContext.getStore() ?? this.lastUsedWorker
  }

  /**
   * Bind a worker to the current async context so that subsequent
   * setCooldownForLastWorker() / markSuccessForModel() calls in the
   * same async chain (e.g. catch blocks in google.service.ts) target
   * the correct worker — even under concurrent requests.
   */
  private bindWorkerToContext(worker: WorkerHandle): void {
    this.workerContext.enterWith(worker)
    // Keep legacy fallback in sync for code paths that don't go through
    // generate/generateStream (e.g. direct pool API calls)
    this.lastUsedWorker = worker
  }

  /**
   * @deprecated Use setCooldownForLastWorker() for accurate targeting.
   * Legacy: marks the last-used worker as rate-limited.
   */
  setCooldown(delayMs: number): void {
    this.setCooldownForLastWorker(delayMs)
  }

  /**
   * Mark the worker bound to the current async context as globally
   * rate-limited for `delayMs` milliseconds.
   *
   * Uses AsyncLocalStorage to resolve the correct worker even when
   * multiple requests are in-flight concurrently.
   */
  setCooldownForLastWorker(
    delayMs: number,
    reason: BackendPoolModelCooldownReason = "rate_limited"
  ): void {
    const worker = this.resolveContextWorker()
    if (!worker) return
    const now = Date.now()
    worker.cooldownUntil = now + delayMs
    worker.cooldownReason = reason
    this.advanceWorkerIndexPastWorker(worker)
    this.logger.warn(
      `[pool-cooldown] [Worker ${worker.account.email}] ${this.describeModelCooldownReason(
        reason
      )}, cooldown ${this.formatDuration(delayMs)}`
    )
  }

  disableLastWorker(reason: string = "authentication failed"): void {
    const worker = this.resolveContextWorker()
    if (!worker || this.isWorkerDisabled(worker)) return

    const disabledAt = Date.now()
    worker.disabledAt = disabledAt
    worker.disabledReason = reason
    worker.cooldownUntil = 0
    worker.cooldownReason = undefined
    worker.modelStates.clear()
    this.clearWorkerPreference(worker)
    if (this.lastUsedWorker === worker) {
      this.lastUsedWorker = null
    }

    this.logger.warn(
      `[pool-disable] [Worker ${worker.account.email}] ${reason}, removed from scheduling`
    )
  }

  recycleLastOfficialClient(_reason: string): Promise<void> {
    return Promise.resolve()
  }

  /**
   * Mark the context worker as rate-limited for a specific model.
   * Inspired by CLIProxyAPI's MarkResult per-model state tracking.
   *
   * The worker may still be available for other models.
   * Also clears sticky preference so getNextWorker falls through to round-robin.
   */
  setModelCooldownForLastWorker(
    model: string,
    delayMs: number,
    reason: BackendPoolModelCooldownReason = "rate_limited",
    advanceIndex: boolean = true
  ): void {
    const worker = this.resolveContextWorker()
    if (!worker || !model) return
    const now = Date.now()
    const quotaExhausted = reason === "quota_exhausted"
    worker.modelStates.set(model, {
      cooldownUntil: now + delayMs,
      quotaExhausted,
      reason,
    })
    if (advanceIndex) {
      this.advanceWorkerIndexPastWorker(worker, model)
    }
    // Clear sticky preference — this worker is no longer suitable for this model
    if (this.preferredWorkerByModel.get(model) === worker) {
      this.preferredWorkerByModel.delete(model)
    }
    this.logger.warn(
      `[pool-cooldown] [Worker ${worker.account.email}] model ${model} ${this.describeModelCooldownReason(
        reason
      )}, cooldown ${this.formatDuration(delayMs)}`
    )
  }

  private describeModelCooldownReason(
    reason: BackendPoolModelCooldownReason
  ): string {
    switch (reason) {
      case "quota_exhausted":
        return "quota exhausted"
      case "capacity_exhausted":
        return "capacity exhausted"
      case "transient":
        return "temporarily unavailable"
      case "rate_limited":
      default:
        return "rate-limited"
    }
  }

  /**
   * Clear per-model cooldown for the context worker (on success).
   */
  clearModelCooldownForLastWorker(model: string): void {
    const worker = this.resolveContextWorker()
    if (!worker || !model) return
    worker.modelStates.delete(model)
  }

  setPoolModelCooldown(
    model: string,
    delayMs: number,
    reason: BackendPoolModelCooldownReason = "capacity_exhausted"
  ): void {
    if (!model || delayMs <= 0) return
    const now = Date.now()
    const cooldownUntil = now + delayMs
    const existing = this.poolModelCooldowns.get(model)
    if (!existing || existing.cooldownUntil < cooldownUntil) {
      this.poolModelCooldowns.set(model, {
        cooldownUntil,
        reason,
      })
    }
    this.logger.warn(
      `[pool-gate] model ${model} ${this.describeModelCooldownReason(reason)}, gate ${this.formatDuration(delayMs)}`
    )
  }

  clearPoolModelCooldown(model: string): void {
    if (!model) return
    this.poolModelCooldowns.delete(model)
  }

  private getActivePoolModelCooldown(
    model: string,
    now: number = Date.now()
  ):
    | { cooldownUntil: number; reason?: BackendPoolModelCooldownReason }
    | undefined {
    const state = this.poolModelCooldowns.get(model)
    if (!state) return undefined
    if (state.cooldownUntil <= now) {
      this.poolModelCooldowns.delete(model)
      return undefined
    }
    return state
  }

  /**
   * Mark the context worker as the preferred (sticky) worker for a model.
   * Called on successful request completion so subsequent requests reuse the
   * same worker instead of rotating through all accounts unnecessarily.
   */
  markSuccessForModel(model: string): void {
    const worker = this.resolveContextWorker()
    if (!worker || !model) return
    this.preferredWorkerByModel.set(model, worker)
    // Also clear any lingering model cooldown (recovery)
    worker.modelStates.delete(model)
    this.clearPoolModelCooldown(model)
  }

  /**
   * Returns true if at least one ready worker is NOT in cooldown.
   */
  hasAvailableWorker(): boolean {
    const now = Date.now()
    return this.workers.some(
      (w) => this.shouldWorkerAcceptNewRequests(w) && w.cooldownUntil <= now
    )
  }

  /**
   * Returns true if at least one ready worker is available for a specific model.
   * Checks both global cooldown and per-model cooldown.
   */
  hasAvailableWorkerForModel(
    model: string,
    options: WorkerSelectionOptions = {}
  ): boolean {
    const now = Date.now()
    if (this.getActivePoolModelCooldown(model, now)) {
      return false
    }
    return this.workers.some((w) => {
      const email = w.account.email?.trim() || ""
      if (
        !this.shouldWorkerAcceptNewRequests(w) ||
        options.excludedWorkerEmails?.has(email) ||
        w.cooldownUntil > now
      ) {
        return false
      }
      if (
        options.requireGenerationCapacity &&
        w.activeGenerationRequests >= this.MAX_CONCURRENT_GENERATIONS_PER_WORKER
      ) {
        return false
      }
      const modelState = model ? w.modelStates.get(model) : undefined
      return !modelState || modelState.cooldownUntil <= now
    })
  }

  hasEligibleWorker(options: WorkerSelectionOptions = {}): boolean {
    return this.workers.some((worker) => {
      const email = worker.account.email?.trim() || ""
      return (
        this.shouldWorkerAcceptNewRequests(worker) &&
        !options.excludedWorkerEmails?.has(email)
      )
    })
  }

  hasOnlyDisabledWorkers(): boolean {
    if (this.workers.length === 0) {
      return false
    }
    let sawDisabledWorker = false
    for (const worker of this.workers) {
      if (this.isWorkerDisabled(worker)) {
        sawDisabledWorker = true
        continue
      }
      return false
    }
    return sawDisabledWorker
  }

  /**
   * Returns the shortest remaining cooldown (ms) across all ready workers.
   * Returns 0 if a worker is already available.
   */
  getMinCooldownMs(): number {
    const now = Date.now()
    let min = Infinity
    for (const w of this.workers) {
      if (!this.shouldWorkerAcceptNewRequests(w)) continue
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
    const poolModelCooldown = this.getActivePoolModelCooldown(model, now)
    let min = Infinity
    for (const w of this.workers) {
      if (!this.shouldWorkerAcceptNewRequests(w)) continue
      const globalRemaining = Math.max(0, w.cooldownUntil - now)
      const modelState = model ? w.modelStates.get(model) : undefined
      const modelRemaining = modelState
        ? Math.max(0, modelState.cooldownUntil - now)
        : 0
      const poolRemaining = poolModelCooldown
        ? Math.max(0, poolModelCooldown.cooldownUntil - now)
        : 0
      const remaining = Math.max(globalRemaining, modelRemaining, poolRemaining)
      if (remaining < min) min = remaining
    }
    if (min === Infinity && poolModelCooldown) {
      return Math.max(0, poolModelCooldown.cooldownUntil - now)
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
    model?: string,
    options: WorkerSelectionOptions = {}
  ): Promise<unknown> {
    const requestStartedAt = Date.now()
    const worker = this.getNextWorker(model, false, {
      ...options,
      requireGenerationCapacity: true,
    })
    this.bindWorkerToContext(worker)
    worker.requestCount++
    worker.activeGenerationRequests++
    try {
      await this.preparePayloadForWorker(worker, payload)
      this.logPreparedCloudCodePayload(worker, payload, "generate")
      const outboundPayload = this.createOutboundWorkerPayload(payload)
      // Use long timeout for non-streaming generation, especially for deep thinking models
      const result = await this.sendRequest(
        worker,
        "generate",
        {
          payload: outboundPayload,
          retryPolicy: {
            preferPoolRotation: true,
          },
        },
        this.GENERATE_TIMEOUT_MS
      )
      this.recordGoogleUsage(worker, payload, model, result, requestStartedAt)
      return result
    } finally {
      worker.activeGenerationRequests = Math.max(
        0,
        worker.activeGenerationRequests - 1
      )
    }
  }

  /**
   * Send streaming generate request.
   * If `model` is provided, per-model cooldown is checked during worker selection.
   */
  async generateStream(
    payload: Record<string, unknown>,
    onChunk: (chunk: unknown) => void,
    model?: string,
    abortSignal?: AbortSignal,
    options: WorkerSelectionOptions = {}
  ): Promise<void> {
    const requestStartedAt = Date.now()
    const worker = this.getNextWorker(model, false, {
      ...options,
      requireGenerationCapacity: true,
    })
    this.bindWorkerToContext(worker)
    worker.requestCount++
    worker.activeGenerationRequests++
    try {
      await this.preparePayloadForWorker(worker, payload)
      this.logPreparedCloudCodePayload(worker, payload, "generateStream")
      const outboundPayload = this.createOutboundWorkerPayload(payload)
      let lastUsageMetadata: Record<string, unknown> | null = null

      await this.sendStreamRequest(
        worker,
        "generateStream",
        {
          payload: outboundPayload,
          retryPolicy: {
            preferPoolRotation: true,
          },
        },
        (chunk) => {
          const usageMetadata = this.extractGoogleUsageMetadata(chunk)
          if (usageMetadata) {
            lastUsageMetadata = usageMetadata
          }
          onChunk(chunk)
        },
        300000,
        abortSignal
      )

      this.recordGoogleUsage(
        worker,
        payload,
        model,
        {
          usageMetadata: lastUsageMetadata ?? undefined,
        },
        requestStartedAt
      )
    } finally {
      worker.activeGenerationRequests = Math.max(
        0,
        worker.activeGenerationRequests - 1
      )
    }
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

  private parseGoogleQuotaResetAt(resetTime?: string): number | null {
    if (!resetTime) return null
    const resetAt = Date.parse(resetTime)
    if (Number.isNaN(resetAt)) return null
    return resetAt
  }

  private syncWorkerQuotaStateFromSnapshot(
    worker: WorkerHandle,
    models: GoogleQuotaModelSnapshot[],
    now: number = Date.now()
  ): void {
    const snapshotByModel = new Map(models.map((model) => [model.name, model]))

    for (const [modelName, snapshot] of snapshotByModel.entries()) {
      const remainingFraction = snapshot.remainingFraction
      const resetAt = this.parseGoogleQuotaResetAt(snapshot.resetTime)
      const exhaustedBySnapshot =
        typeof remainingFraction === "number" &&
        remainingFraction <= this.GOOGLE_QUOTA_EXHAUSTED_REMAINING_FRACTION

      if (exhaustedBySnapshot) {
        worker.modelStates.set(modelName, {
          cooldownUntil:
            resetAt != null && resetAt > now
              ? resetAt
              : now + this.GOOGLE_QUOTA_EXHAUSTED_FALLBACK_COOLDOWN_MS,
          quotaExhausted: true,
          reason: "quota_exhausted",
        })
        if (this.preferredWorkerByModel.get(modelName) === worker) {
          this.preferredWorkerByModel.delete(modelName)
        }
        continue
      }

      const existing = worker.modelStates.get(modelName)
      if (existing?.reason !== "quota_exhausted") {
        continue
      }

      worker.modelStates.delete(modelName)
    }

    for (const [modelName, state] of Array.from(worker.modelStates.entries())) {
      if (state.reason !== "quota_exhausted") continue
      if (snapshotByModel.has(modelName)) continue
      if (state.cooldownUntil <= now) {
        worker.modelStates.delete(modelName)
      }
    }
  }

  async fetchGoogleQuotaSnapshots(
    forceRefresh: boolean = false
  ): Promise<GoogleQuotaAccountSnapshot[]> {
    if (!forceRefresh) {
      return this.getCachedGoogleQuotaSnapshots()
    }

    const snapshots = await this.collectGoogleQuotaSnapshots()
    this.googleQuotaSnapshotCache = snapshots
    this.googleQuotaSnapshotFetchedAt = Date.now()
    return this.getCachedGoogleQuotaSnapshots()
  }

  getCachedGoogleQuotaSnapshots(): GoogleQuotaAccountSnapshot[] {
    return this.googleQuotaSnapshotCache.map((snapshot) => ({
      ...snapshot,
      models: snapshot.models.map((model) => ({ ...model })),
    }))
  }

  getGoogleQuotaSnapshotCacheMetadata(now: number = Date.now()): {
    hasCache: boolean
    fetchedAt: number | null
    cacheAgeMs: number | null
  } {
    const hasCache = this.googleQuotaSnapshotCache.length > 0
    const fetchedAt =
      hasCache && this.googleQuotaSnapshotFetchedAt > 0
        ? this.googleQuotaSnapshotFetchedAt
        : null

    return {
      hasCache,
      fetchedAt,
      cacheAgeMs: fetchedAt != null ? Math.max(0, now - fetchedAt) : null,
    }
  }

  private async collectGoogleQuotaSnapshots(): Promise<
    GoogleQuotaAccountSnapshot[]
  > {
    const now = Date.now()
    const snapshots = await Promise.all(
      this.workers.map(async (worker) => {
        let state: BackendPoolEntryState
        const activeModelCooldowns = Array.from(
          worker.modelStates.values()
        ).some((modelState) => modelState.cooldownUntil > now)

        if (!worker.ready || worker.draining) {
          state = "unavailable"
        } else if (this.isWorkerDisabled(worker)) {
          state = "disabled"
        } else if (worker.cooldownUntil > now) {
          state = "cooldown"
        } else if (activeModelCooldowns) {
          state = "degraded"
        } else {
          state = "ready"
        }

        if (!worker.ready || worker.draining || this.isWorkerDisabled(worker)) {
          return {
            email: worker.account.email,
            ready: worker.ready,
            requestCount: worker.requestCount,
            cooldownUntil: worker.cooldownUntil,
            state,
            projectId: worker.account.projectId,
            tier: undefined,
            models: [],
            fetchedAt: Date.now(),
          } satisfies GoogleQuotaAccountSnapshot
        }

        try {
          await this.primeWorkerBootstrap(worker)
          const loadResult = (await this.sendRequest(
            worker,
            "loadCodeAssist",
            {
              metadata: {
                ideType: "ANTIGRAVITY",
              },
              projectId: worker.account.projectId,
            },
            15000
          )) as {
            currentTier?: { id?: string; name?: string }
            paidTier?: { id?: string; name?: string }
            allowedTiers?: Array<{
              id?: string
              name?: string
              isDefault?: boolean
            }>
            ineligibleTiers?: Array<{ reasonCode?: string }>
            cloudaicompanionProject?: string
          }

          // Multi-level tier fallback (aligned with Antigravity-Manager quota.rs)
          // 1. paidTier (Google One AI Premium → "PRO"/"ULTRA")
          // 2. currentTier (if not ineligible)
          // 3. allowedTiers default (if ineligible → append "(Restricted)")
          let tier = ""
          const paidName =
            loadResult?.paidTier?.name?.trim() ||
            loadResult?.paidTier?.id?.trim() ||
            ""
          if (paidName) {
            tier = paidName
          } else {
            const isIneligible =
              Array.isArray(loadResult?.ineligibleTiers) &&
              loadResult.ineligibleTiers.length > 0
            if (!isIneligible) {
              tier =
                loadResult?.currentTier?.name?.trim() ||
                loadResult?.currentTier?.id?.trim() ||
                ""
            } else if (Array.isArray(loadResult?.allowedTiers)) {
              const defaultTier = loadResult.allowedTiers.find(
                (t) => t.isDefault === true
              )
              if (defaultTier) {
                const label =
                  defaultTier.name?.trim() || defaultTier.id?.trim() || ""
                tier = label ? `${label} (Restricted)` : ""
              }
            }
          }
          const resolvedProjectId = this.extractCloudCodeProjectId(loadResult)
          if (resolvedProjectId) {
            worker.account.projectId = resolvedProjectId
          }

          const modelsResult = (await this.sendRequest(
            worker,
            "fetchAvailableModels",
            undefined,
            20000
          )) as {
            models?: Record<
              string,
              {
                displayName?: string
                quotaInfo?: { remainingFraction?: number; resetTime?: string }
              }
            >
          }

          const models = Object.entries(modelsResult?.models || {})
            .map(([name, data]) => {
              const remainingFraction =
                typeof data?.quotaInfo?.remainingFraction === "number"
                  ? data.quotaInfo.remainingFraction
                  : undefined
              return {
                name,
                displayName: data?.displayName,
                remainingFraction,
                percentage:
                  typeof remainingFraction === "number"
                    ? Math.max(
                        0,
                        Math.min(100, Math.round(remainingFraction * 100))
                      )
                    : undefined,
                resetTime:
                  typeof data?.quotaInfo?.resetTime === "string"
                    ? data.quotaInfo.resetTime
                    : undefined,
              }
            })
            .sort((left, right) => {
              const leftPct =
                typeof left.percentage === "number" ? left.percentage : -1
              const rightPct =
                typeof right.percentage === "number" ? right.percentage : -1
              return rightPct - leftPct || left.name.localeCompare(right.name)
            })

          this.syncWorkerQuotaStateFromSnapshot(worker, models, now)
          const snapshotState =
            worker.cooldownUntil > now
              ? "cooldown"
              : Array.from(worker.modelStates.values()).some(
                    (modelState) => modelState.cooldownUntil > now
                  )
                ? "degraded"
                : "ready"

          return {
            email: worker.account.email,
            ready: worker.ready,
            requestCount: worker.requestCount,
            cooldownUntil: worker.cooldownUntil,
            state: snapshotState,
            projectId: worker.account.projectId,
            tier: tier || undefined,
            models,
            fetchedAt: Date.now(),
          } satisfies GoogleQuotaAccountSnapshot
        } catch (error) {
          this.logger.warn(
            `[Worker ${worker.account.email}] failed to fetch quota snapshot: ${(error as Error).message}`
          )
          return {
            email: worker.account.email,
            ready: worker.ready,
            requestCount: worker.requestCount,
            cooldownUntil: worker.cooldownUntil,
            state,
            projectId: worker.account.projectId,
            tier: undefined,
            models: [],
            fetchedAt: Date.now(),
          } satisfies GoogleQuotaAccountSnapshot
        }
      })
    )

    return snapshots.sort((left, right) =>
      left.email.localeCompare(right.email)
    )
  }

  async reloadAccounts(): Promise<number> {
    if (this.reloadAccountsPromise) {
      return this.reloadAccountsPromise
    }

    this.reloadAccountsPromise = (async () => {
      const previousConfigPath = this.accountsConfigPath
      const freshAccounts = this.loadAccounts().map((account) =>
        this.normalizeNativeAccount(account)
      )
      const freshByStableKey = new Map(
        freshAccounts.map((account) => [
          getNativeAccountStableKey(account),
          account,
        ])
      )

      let added = 0
      let updated = 0
      let drained = 0

      for (const account of freshAccounts) {
        const stableKey = getNativeAccountStableKey(account)
        const configSignature = getNativeAccountConfigSignature(account)
        const existing = this.findWorkerByStableKey(stableKey)
        if (!existing) {
          await this.spawnWorker(account)
          added += 1
          this.logger.log(
            `[Hot-reload] Added Antigravity account: ${account.email}`
          )
          continue
        }
        if (existing.configSignature !== configSignature) {
          await this.replaceWorkerWithAccount(
            existing,
            account,
            "config-changed"
          )
          updated += 1
        }
      }

      const staleWorkers = this.workers.filter(
        (worker) => !freshByStableKey.has(worker.stableKey)
      )
      for (const worker of staleWorkers) {
        this.markWorkerDraining(worker, "removed-from-config")
        this.scheduleWorkerRetirement(worker)
        drained += 1
      }

      this.defaultWorkerIndex = Math.min(
        this.defaultWorkerIndex,
        Math.max(this.workers.length - 1, 0)
      )

      if (previousConfigPath !== this.accountsConfigPath) {
        this.startAccountsWatcher()
      }

      const changes = added + updated + drained
      if (changes > 0) {
        this.logger.log(
          `[Hot-reload] Antigravity reconcile: +${added} ~${updated} -${drained}, total=${this.workers.length}`
        )
      }

      return changes
    })()

    try {
      return await this.reloadAccountsPromise
    } finally {
      this.reloadAccountsPromise = null
    }
  }

  /**
   * Get current worker account email
   */
  getCurrentEmail(): string | null {
    const readyWorkers = this.workers.filter((w) =>
      this.shouldWorkerAcceptNewRequests(w)
    )
    if (readyWorkers.length === 0) return null
    const idx = this.normalizeWorkerIndex(
      readyWorkers.length,
      this.defaultWorkerIndex
    )
    const worker = readyWorkers[idx]
    return worker?.account.email ?? null
  }

  /**
   * Get the email of the worker that last executed a request.
   * Uses AsyncLocalStorage context first, falls back to legacy lastUsedWorker.
   * Useful for logging which worker encountered an error.
   */
  getLastWorkerEmail(): string | null {
    return this.resolveContextWorker()?.account.email ?? null
  }

  private extractGoogleUsageMetadata(
    result: unknown
  ): Record<string, unknown> | null {
    if (!result || typeof result !== "object") {
      return null
    }

    const usageMetadata = (result as { usageMetadata?: unknown }).usageMetadata
    return usageMetadata && typeof usageMetadata === "object"
      ? (usageMetadata as Record<string, unknown>)
      : null
  }

  private recordGoogleUsage(
    worker: WorkerHandle,
    payload: Record<string, unknown>,
    model: string | undefined,
    result: unknown,
    requestStartedAt?: number
  ): void {
    const usageMetadata = this.extractGoogleUsageMetadata(result)
    const requestedModel =
      (typeof model === "string" && model.trim()) ||
      (typeof payload.model === "string" && payload.model.trim()) ||
      "(unknown)"
    const accountLabel = worker.account.email?.trim() || "Antigravity account"
    const accountKey =
      worker.account.email?.trim() ||
      worker.account.projectId?.trim() ||
      "(unknown)"

    const totalInputTokens = this.toWholeNumber(usageMetadata?.promptTokenCount)
    const cachedInputTokens = this.toWholeNumber(
      usageMetadata?.cachedContentTokenCount
    )
    this.usageStats.recordGoogleUsage({
      transport: "native",
      modelName: requestedModel,
      accountKey,
      accountLabel,
      inputTokens: Math.max(0, totalInputTokens - cachedInputTokens),
      cachedInputTokens,
      outputTokens: this.toWholeNumber(usageMetadata?.candidatesTokenCount),
      durationMs:
        typeof requestStartedAt === "number"
          ? Math.max(0, Date.now() - requestStartedAt)
          : 0,
    })
  }

  private toWholeNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.round(value))
      : 0
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
      draining: boolean
      cooldownUntil: number
      requestCount: number
      pid: number | undefined
    }>
  } {
    const now = Date.now()
    return {
      total: this.workers.length,
      ready: this.workers.filter((w) => this.shouldWorkerAcceptNewRequests(w))
        .length,
      available: this.workers.filter(
        (w) => this.shouldWorkerAcceptNewRequests(w) && w.cooldownUntil <= now
      ).length,
      workers: this.workers.map((w) => ({
        email: w.account.email,
        ready: w.ready,
        draining: w.draining,
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
          reason: state.reason,
        }))
        .sort((left, right) => left.cooldownUntil - right.cooldownUntil)

      let state: BackendPoolEntryState
      if (!worker.ready || worker.draining) {
        state = "unavailable"
      } else if (this.isWorkerDisabled(worker)) {
        state = "disabled"
      } else if (worker.cooldownUntil > now) {
        state = "cooldown"
      } else if (modelCooldowns.length > 0) {
        state = "model_cooldown"
      } else {
        state = "ready"
      }

      return {
        id: worker.account.email,
        label: worker.account.email,
        state,
        cooldownUntil: worker.cooldownUntil,
        disabledAt: worker.disabledAt,
        disabledReason: worker.disabledReason,
        email: worker.account.email,
        proxyUrl: worker.account.proxyUrl,
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
        (entry) => entry.state === "ready" || entry.state === "model_cooldown"
      ).length,
      ready: entries.filter((entry) => entry.state === "ready").length,
      degraded: 0,
      modelCooldown: entries.filter((entry) => entry.state === "model_cooldown")
        .length,
      cooling: entries.filter((entry) => entry.state === "cooldown").length,
      disabled: entries.filter((entry) => entry.state === "disabled").length,
      unavailable: entries.filter((entry) => entry.state === "unavailable")
        .length,
      entries,
    }
  }
}
