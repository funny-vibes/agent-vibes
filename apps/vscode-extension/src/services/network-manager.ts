import { execSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { logger } from "../utils/logger"

const LOOPBACK_IP = "127.0.0.2"
const HOSTS_BEGIN = "# BEGIN Cursor proxy forwarding"
const PID_FILE =
  process.platform === "win32"
    ? path.join(os.tmpdir(), "cursor-proxy-relay.pid")
    : "/tmp/cursor-proxy-relay.pid"

export type ForwardingBackend = "relay" | "portproxy" | "iptables"

export interface ForwardingStatus {
  backend: ForwardingBackend
  backendLabel: string
  backendStatusLabel: string
  hasHosts: boolean
  hasLoopbackAlias: boolean | null
  backendConfigured: boolean
  active: boolean
  localProxyReachable?: boolean
  endToEndReachable?: boolean
}

interface ForwardingStatusScriptPayload {
  ok: boolean
  platform: NodeJS.Platform
  backend: "pf" | "iptables" | "netsh" | "unknown"
  backendStatusLabel?: string
  checks?: {
    hosts?: boolean
    loopbackAlias?: boolean | null
    backendConfigured?: boolean
    localProxyReachable?: boolean
    endToEndReachable?: boolean
  }
}

/**
 * 跨平台的 forwarding 状态管理器。
 *
 * 委托 bundled `scripts/setup-forwarding.js` 处理底层配置：
 *   - macOS: lo0 alias + TCP relay
 *   - Linux: iptables + loopback alias
 *   - Windows: portproxy + hosts/proxy settings
 *
 * 需要 sudo/admin；调用方通过 `executePrivileged` 触发提权。
 */
export class NetworkManager {
  private extensionPath: string | null = null
  private _port: number = 2026

  /**
   * Set the extension path so we can find the bundled scripts.
   * Called from extension.ts after context is available.
   */
  setExtensionPath(extPath: string): void {
    this.extensionPath = extPath
  }

  /**
   * Set the bridge port so forwarding targets the correct destination.
   * Called from extension.ts after config is available.
   */
  setPort(port: number): void {
    this._port = port
  }

  /**
   * Get path to the bundled setup-forwarding.js script.
   */
  private get forwardingScript(): string {
    if (!this.extensionPath) {
      throw new Error("Extension path not set — call setExtensionPath first")
    }
    return path.join(this.extensionPath, "scripts", "setup-forwarding.js")
  }

  private buildForwardingCommand(
    mode: "on" | "off" | "status",
    port: number,
    options: { json?: boolean } = {}
  ): string {
    const script = this.forwardingScript
    const jsonFlag = options.json ? " --json" : ""
    return `node "${script}" ${mode} --port=${port}${jsonFlag}`
  }

  /**
   * Build the sudo command string to enable forwarding.
   */
  getEnableCommand(): string {
    return this.buildForwardingCommand("on", this._port)
  }

  /**
   * Build the sudo command string to disable forwarding.
   */
  getDisableCommand(): string {
    return this.buildForwardingCommand("off", this._port)
  }

  /**
   * Build a command that reconfigures forwarding from a previous port to the
   * currently configured port in one elevated shell session.
   */
  getReconfigureCommand(previousPort: number): string {
    const disable = this.buildForwardingCommand("off", previousPort)
    const enable = this.buildForwardingCommand("on", this._port)

    if (process.platform === "win32") {
      return `${disable} && ${enable}`
    }

    const escapeSingleQuotes = (value: string): string =>
      value.replace(/'/g, `'\\''`)

    return `sh -c '${escapeSingleQuotes(disable)} && ${escapeSingleQuotes(enable)}'`
  }

  /**
   * Build the command string to check status (no sudo needed).
   */
  getStatusCommand(json: boolean = false): string {
    return this.buildForwardingCommand("status", this._port, { json })
  }

  private mapScriptBackend(
    backend: ForwardingStatusScriptPayload["backend"]
  ): ForwardingBackend {
    if (backend === "pf") return "relay"
    if (backend === "netsh") return "portproxy"
    return "iptables"
  }

  private getFallbackForwardingStatus(): ForwardingStatus {
    const backend = this.getForwardingBackend()
    const hasHosts = this.hasHostEntries()

    if (backend === "relay") {
      const hasLoopbackAlias = this.hasLoopbackAlias()
      const backendConfigured = this.isRelayRunning()
      return {
        backend,
        backendLabel: "TCP relay",
        backendStatusLabel: "TCP relay process",
        hasHosts,
        hasLoopbackAlias,
        backendConfigured,
        active: hasHosts && hasLoopbackAlias && backendConfigured,
      }
    }

    if (backend === "portproxy") {
      const backendConfigured = this.hasWindowsPortProxyRule()
      return {
        backend,
        backendLabel: "Port proxy",
        backendStatusLabel: "Port proxy rule",
        hasHosts,
        hasLoopbackAlias: null,
        backendConfigured,
        active: hasHosts && backendConfigured,
      }
    }

    const hasLoopbackAlias = this.hasLinuxLoopbackAlias()
    const backendConfigured = this.hasIptablesRule()
    return {
      backend,
      backendLabel: "iptables",
      backendStatusLabel: "iptables NAT rule",
      hasHosts,
      hasLoopbackAlias,
      backendConfigured,
      active: hasHosts && hasLoopbackAlias && backendConfigured,
    }
  }

  private getScriptForwardingStatus(): ForwardingStatus | null {
    try {
      const raw = execSync(this.getStatusCommand(true), {
        encoding: "utf-8",
        stdio: "pipe",
      })
      const payload = JSON.parse(raw) as ForwardingStatusScriptPayload
      const backend = this.mapScriptBackend(payload.backend)
      const backendLabel =
        backend === "relay"
          ? "TCP relay"
          : backend === "portproxy"
            ? "Port proxy"
            : "iptables"

      return {
        backend,
        backendLabel,
        backendStatusLabel:
          payload.backendStatusLabel ||
          (backend === "relay"
            ? "TCP relay process"
            : backend === "portproxy"
              ? "Port proxy rule"
              : "iptables NAT rule"),
        hasHosts: payload.checks?.hosts ?? false,
        hasLoopbackAlias:
          payload.checks?.loopbackAlias === undefined
            ? null
            : payload.checks.loopbackAlias,
        backendConfigured: payload.checks?.backendConfigured ?? false,
        active: Boolean(payload.ok),
        localProxyReachable: payload.checks?.localProxyReachable,
        endToEndReachable: payload.checks?.endToEndReachable,
      }
    } catch (error) {
      logger.debug(
        `Failed to read forwarding JSON status, falling back to local checks: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  getForwardingBackend(): ForwardingBackend {
    if (process.platform === "darwin") return "relay"
    if (process.platform === "win32") return "portproxy"
    return "iptables"
  }

  getForwardingStatus(): ForwardingStatus {
    return (
      this.getScriptForwardingStatus() || this.getFallbackForwardingStatus()
    )
  }

  /**
   * Quick local check — does NOT spawn a subprocess.
   * Used by hot paths (extension activation, dashboard refresh, status bar).
   */
  isForwardingActive(): boolean {
    const hasHosts = this.hasHostEntries()
    const backend = this.getForwardingBackend()
    if (backend === "relay") return hasHosts && this.isRelayRunning()
    if (backend === "portproxy")
      return hasHosts && this.hasWindowsPortProxyRule()
    return hasHosts && this.hasIptablesRule()
  }

  /**
   * Poll until forwarding becomes active or timeout elapses.
   */
  async waitForForwardingActive(
    timeoutMs: number = 30000,
    intervalMs: number = 2000
  ): Promise<boolean> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      if (this.isForwardingActive()) {
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }

    return this.isForwardingActive()
  }

  /**
   * Check if /etc/hosts has our managed entries.
   */
  hasHostEntries(): boolean {
    try {
      const hostsPath =
        process.platform === "win32"
          ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
          : "/etc/hosts"
      const content = fs.readFileSync(hostsPath, "utf-8")
      return content.includes(HOSTS_BEGIN)
    } catch {
      return false
    }
  }

  /**
   * Check if the TCP relay process is running.
   */
  isRelayRunning(): boolean {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim())
      if (isNaN(pid)) return false
      try {
        process.kill(pid, 0)
        return true
      } catch (e: unknown) {
        // EPERM = process exists but owned by another user (root)
        if (e && typeof e === "object" && "code" in e && e.code === "EPERM")
          return true
        return false
      }
    } catch {
      return false
    }
  }

  hasWindowsPortProxyRule(): boolean {
    if (process.platform !== "win32") return false
    try {
      const rules = execSync("netsh interface portproxy show v4tov4", {
        encoding: "utf-8",
        stdio: "pipe",
      })
      return rules.includes(LOOPBACK_IP)
    } catch {
      return false
    }
  }

  hasIptablesRule(): boolean {
    if (process.platform !== "linux") return false
    try {
      const rules = execSync("iptables -t nat -L OUTPUT -n", {
        encoding: "utf-8",
        stdio: "pipe",
      })
      return rules.includes(LOOPBACK_IP)
    } catch {
      return false
    }
  }

  /**
   * Check if the loopback alias exists (macOS only, no sudo needed).
   */
  hasLoopbackAlias(): boolean {
    if (process.platform !== "darwin") return true
    try {
      const lo0Info = execSync("ifconfig lo0", {
        encoding: "utf-8",
        stdio: "pipe",
      })
      return lo0Info.includes(LOOPBACK_IP)
    } catch {
      return false
    }
  }

  hasLinuxLoopbackAlias(): boolean {
    if (process.platform !== "linux") return false
    try {
      const loInfo = execSync("ip addr show lo", {
        encoding: "utf-8",
        stdio: "pipe",
      })
      return loInfo.includes(`${LOOPBACK_IP}/`)
    } catch {
      return false
    }
  }

  /**
   * Stub for backward compat with Clash-based code.
   */
  enableForwarding(_port?: number): void {
    logger.info(
      "enableForwarding() called — use executePrivileged(network.getEnableCommand()) instead"
    )
  }

  /**
   * Stub for backward compat.
   */
  disableForwarding(): void {
    logger.info(
      "disableForwarding() called — use executePrivileged(network.getDisableCommand()) instead"
    )
  }

  dispose(): void {
    // Nothing to clean up — forwarding persists across Cursor restarts
  }
}
