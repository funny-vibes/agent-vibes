import { ChildProcess, spawn } from "child_process"
import { EventEmitter } from "events"
import * as fs from "fs"
import * as https from "https"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import type { ServerState } from "../constants"
import { CTX_SERVER_RUNNING } from "../constants"
import { logger } from "../utils/logger"
import { getExeExtension, getPlatformTarget } from "../utils/platform"
import { ConfigManager } from "./config-manager"

const PID_FILE = path.join(os.tmpdir(), "agent-vibes-bridge.pid")
const LOG_FILE = path.join(os.tmpdir(), "agent-vibes-bridge.log")
const PREVIOUS_LOG_FILE = path.join(
  os.tmpdir(),
  "agent-vibes-bridge.previous.log"
)
const STARTUP_HEALTH_TIMEOUT_MS = 45000

/**
 * Manages the Protocol Bridge process lifecycle (start / stop / restart).
 *
 * In production, spawns the pre-compiled SEA binary from bridge/<platform>/.
 * In development (source mode), falls back to running the dist/main.js directly.
 */
export class BridgeManager extends EventEmitter {
  private process: ChildProcess | null = null
  private _state: ServerState = "stopped"
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly config: ConfigManager,
    private readonly extensionPath: string
  ) {
    super()
  }

  get state(): ServerState {
    return this._state
  }

  get isRunning(): boolean {
    return this._state === "running"
  }

  async start(): Promise<void> {
    if (this._state === "running" || this._state === "starting") {
      logger.warn("Server is already running or starting")
      return
    }

    // Check if Bridge is already healthy on the port (regardless of PID file)
    // This handles the case where an old Bridge is still running without a PID file.
    this.setState("starting")
    const alreadyHealthy = await this.waitForHealth(2000)
    if (alreadyHealthy) {
      this.setState("running")
      this.startHealthCheck()
      logger.info(
        "Bridge already running on port — reconnected via health check"
      )
      return
    }

    // Check if an existing Bridge process is already running (from previous session)
    const existingPid = this.readPid()
    if (existingPid && this.isProcessAlive(existingPid)) {
      logger.info(
        `Found existing Bridge process (pid ${existingPid}), reconnecting...`
      )
      const healthy = await this.waitForHealth(5000)
      if (healthy) {
        this.setState("running")
        this.startHealthCheck()
        logger.info(`Reconnected to existing Bridge (pid ${existingPid})`)
        return
      } else {
        logger.warn(
          `Existing Bridge (pid ${existingPid}) not responding, starting new instance...`
        )
        this.killPid(existingPid)
      }
    }

    this.setState("starting")
    logger.info(`Starting Protocol Bridge on port ${this.config.port}...`)

    try {
      const { binary, args } = this.resolveBinary()
      logger.info(`Binary: ${binary}`)

      // Ensure executable permission on Unix
      if (process.platform !== "win32" && args.length === 0) {
        try {
          await fs.promises.chmod(binary, 0o755)
        } catch {
          // ignore — binary may already be executable
        }
      }

      const env: Record<string, string> = {
        ...process.env,
        PORT: String(this.config.port),
        AGENT_VIBES_DATA_DIR: this.config.dataDir,
        ...this.config.accountPathEnvOverrides,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      } as Record<string, string>

      if (this.config.hasCertificates()) {
        env.NODE_EXTRA_CA_CERTS = this.config.caCertPath
      }

      if (this.config.debugMode) {
        env.LOG_DEBUG = "true"
      }

      if (this.config.thinkingBudgetAuto) {
        env.THINKING_BUDGET_AUTO = "true"
      }

      if (!this.config.antigravitySystemPrompt) {
        env.ANTIGRAVITY_SYSTEM_PROMPT = "false"
      }

      if (!this.config.antigravityOfficialTools) {
        env.ANTIGRAVITY_OFFICIAL_TOOLS = "false"
      }

      this.rotateLogFile()

      // Spawn detached — Bridge survives Cursor restarts
      const logFd = fs.openSync(LOG_FILE, "a")
      this.process = spawn(binary, args, {
        env,
        stdio: ["ignore", logFd, logFd],
        detached: true,
      })

      // Write PID file for reconnection after Cursor restart
      if (this.process.pid) {
        fs.writeFileSync(PID_FILE, String(this.process.pid))
        logger.info(
          `Bridge spawned (pid ${this.process.pid}), detached for persistence`
        )
      }

      // Unref so Cursor can exit without waiting for Bridge
      this.process.unref()

      this.process.on("exit", (code, signal) => {
        logger.info(
          `Protocol Bridge exited (code=${code}, signal=${signal ?? "none"})`
        )
        this.process = null
        this.cleanupPidFile()
        this.stopHealthCheck()
        this.setState(code === 0 || signal === "SIGTERM" ? "stopped" : "error")
      })

      this.process.on("error", (err) => {
        logger.error("Failed to start Protocol Bridge", err)
        this.process = null
        this.cleanupPidFile()
        this.setState("error")
      })

      // Close the log fd in the parent process (child inherited it)
      fs.closeSync(logFd)

      // Wait for the server to be ready
      const healthy = await this.waitForHealth(STARTUP_HEALTH_TIMEOUT_MS)
      if (healthy) {
        this.setState("running")
        this.startHealthCheck()
        logger.info(`Protocol Bridge is running on port ${this.config.port}`)
      } else {
        logger.warn(
          `Protocol Bridge started but health check failed after ${STARTUP_HEALTH_TIMEOUT_MS}ms — check logs`
        )
        this.setState("running")
        this.startHealthCheck()
      }
    } catch (err) {
      logger.error("Failed to start Protocol Bridge", err)
      this.setState("error")
    }
  }

  async stop(): Promise<void> {
    this.stopHealthCheck()

    // If we have a direct process reference, use it
    if (this.process) {
      logger.info("Stopping Protocol Bridge (direct ref)...")
      return new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            logger.warn("Force killing Protocol Bridge...")
            this.process.kill("SIGKILL")
          }
          resolve()
        }, 5000)

        this.process!.once("exit", () => {
          clearTimeout(timeout)
          this.process = null
          this.cleanupPidFile()
          this.setState("stopped")
          logger.info("Protocol Bridge stopped")
          resolve()
        })

        this.process!.kill("SIGTERM")
      })
    }

    // Otherwise, try to stop via PID file (reconnected from previous session)
    const pid = this.readPid()
    if (pid && this.isProcessAlive(pid)) {
      logger.info(`Stopping Protocol Bridge (pid ${pid}) via PID file...`)
      this.killPid(pid)
      this.cleanupPidFile()
      this.setState("stopped")
      logger.info("Protocol Bridge stopped")
    } else {
      this.cleanupPidFile()
      this.setState("stopped")
    }
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  /**
   * Dispose — called when extension deactivates (Cursor closing).
   * Do NOT kill Bridge — it should persist across Cursor restarts.
   */
  dispose(): void {
    this.stopHealthCheck()
    // Intentionally NOT killing Bridge process — it's a persistent daemon
    this.process = null
  }

  // ── PID file management ──────────────────────────────────────────

  private readPid(): number | null {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim())
      return isNaN(pid) ? null : pid
    } catch {
      return null
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (e: unknown) {
      if (e && typeof e === "object" && "code" in e && e.code === "EPERM")
        return true
      return false
    }
  }

  private killPid(pid: number): void {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // already dead
    }
  }

  private cleanupPidFile(): void {
    try {
      fs.unlinkSync(PID_FILE)
    } catch {
      // ignore
    }
  }

  private rotateLogFile(): void {
    if (!fs.existsSync(LOG_FILE)) return

    try {
      fs.rmSync(PREVIOUS_LOG_FILE, { force: true })
    } catch {
      // ignore
    }

    try {
      fs.renameSync(LOG_FILE, PREVIOUS_LOG_FILE)
      logger.info(`Rotated bridge log to ${PREVIOUS_LOG_FILE}`)
      return
    } catch {
      // Fall back to truncation if rename is unavailable on this filesystem.
    }

    try {
      fs.truncateSync(LOG_FILE, 0)
      logger.info(`Truncated existing bridge log at ${LOG_FILE}`)
    } catch {
      // ignore
    }
  }

  /**
   * Resolve which binary to run.
   * Priority: SEA binary > source dist/main.js
   */
  private resolveBinary(): { binary: string; args: string[] } {
    // 1. Try SEA binary in bridge/<platform>/
    const target = getPlatformTarget()
    const ext = getExeExtension()
    const seaPath = path.join(
      this.extensionPath,
      "bridge",
      target,
      `agent-vibes-bridge${ext}`
    )

    if (fs.existsSync(seaPath)) {
      return { binary: seaPath, args: [] }
    }

    // 2. Fallback: check for source-mode dist/main.js (development)
    const sourceMain = path.join(
      this.extensionPath,
      "..",
      "protocol-bridge",
      "dist",
      "main.js"
    )
    if (fs.existsSync(sourceMain)) {
      logger.info("Using source-mode fallback (protocol-bridge/dist/main.js)")
      return { binary: process.execPath, args: [sourceMain] }
    }

    // 3. Check global install directory ~/.agent-vibes/bin/
    const globalBin = path.join(
      os.homedir(),
      ".agent-vibes",
      "bin",
      `agent-vibes-bridge${ext}`
    )
    if (fs.existsSync(globalBin)) {
      logger.info(`Using globally installed SEA binary: ${globalBin}`)
      return { binary: globalBin, args: [] }
    }

    throw new Error(
      `No Protocol Bridge binary found for ${target}. ` +
        `Expected at: ${seaPath} or ${globalBin}`
    )
  }

  private setState(state: ServerState): void {
    this._state = state
    vscode.commands.executeCommand(
      "setContext",
      CTX_SERVER_RUNNING,
      state === "running"
    )
    this.emit("stateChanged", state)
  }

  /**
   * Make an HTTPS request using the CA certificate, mirroring how Cursor
   * will connect to the Bridge. This validates the full TLS trust chain.
   */
  private httpsHealthCheck(): Promise<boolean> {
    return new Promise((resolve) => {
      const caPath = this.config.caCertPath
      let options: https.RequestOptions

      try {
        const ca = fs.readFileSync(caPath)
        options = {
          hostname: "localhost",
          port: this.config.port,
          path: "/health",
          method: "GET",
          ca,
        }
      } catch {
        // CA cert not available — cannot verify trust chain
        resolve(false)
        return
      }

      const req = https.get(options, (res) => {
        resolve(res.statusCode === 200)
        res.resume() // drain
      })
      req.on("error", () => resolve(false))
      req.setTimeout(3000, () => {
        req.destroy()
        resolve(false)
      })
    })
  }

  private async waitForHealth(timeoutMs: number): Promise<boolean> {
    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      if (await this.httpsHealthCheck()) return true
      await new Promise((r) => setTimeout(r, 500))
    }

    return false
  }

  private startHealthCheck(): void {
    const interval = this.config.healthCheckInterval
    if (interval <= 0) return

    this.healthCheckTimer = setInterval(() => {
      void (async () => {
        const ok = await this.httpsHealthCheck()
        if (!ok && this._state === "running") {
          logger.warn(
            "Health check failed: HTTPS connection failed (check TLS trust)"
          )
          this.setState("error")
        } else if (ok && this._state === "error") {
          logger.info("Health check recovered")
          this.setState("running")
        }
      })()
    }, interval * 1000)
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
  }
}
