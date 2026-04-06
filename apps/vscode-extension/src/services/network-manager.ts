import * as path from "path"
import * as fs from "fs"
import { execSync } from "child_process"
import { logger } from "../utils/logger"

const LOOPBACK_IP = "127.0.0.2"
const HOSTS_BEGIN = "# BEGIN Cursor proxy forwarding"
const PID_FILE =
  process.platform === "win32"
    ? path.join(require("os").tmpdir(), "cursor-proxy-relay.pid")
    : "/tmp/cursor-proxy-relay.pid"

/**
 * TCP-relay based network manager.
 *
 * Delegates to the bundled `scripts/setup-forwarding.js` for the heavy lifting:
 *   - lo0 alias (127.0.0.2)
 *   - TCP relay (127.0.0.2:443 → 127.0.0.1:8000)
 *   - /etc/hosts entries
 *   - proxy bypass settings
 *
 * Requires sudo — uses `executePrivileged` to prompt in the terminal.
 */
export class NetworkManager {
  private extensionPath: string | null = null

  /**
   * Set the extension path so we can find the bundled scripts.
   * Called from extension.ts after context is available.
   */
  setExtensionPath(extPath: string): void {
    this.extensionPath = extPath
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

  /**
   * Build the sudo command string to enable forwarding.
   */
  getEnableCommand(): string {
    const script = this.forwardingScript
    return `node "${script}" on`
  }

  /**
   * Build the sudo command string to disable forwarding.
   */
  getDisableCommand(): string {
    const script = this.forwardingScript
    return `node "${script}" off`
  }

  /**
   * Build the command string to check status (no sudo needed).
   */
  getStatusCommand(): string {
    const script = this.forwardingScript
    return `node "${script}" status`
  }

  /**
   * Check if forwarding is already active by inspecting /etc/hosts + relay PID.
   * No sudo needed — purely read-only checks.
   */
  isForwardingActive(): boolean {
    return this.hasHostEntries() && this.isRelayRunning()
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

  /**
   * Stub for backward compat with Clash-based code.
   */
  async enableForwarding(_port?: number): Promise<void> {
    logger.info(
      "enableForwarding() called — use executePrivileged(network.getEnableCommand()) instead"
    )
  }

  /**
   * Stub for backward compat.
   */
  async disableForwarding(): Promise<void> {
    logger.info(
      "disableForwarding() called — use executePrivileged(network.getDisableCommand()) instead"
    )
  }

  dispose(): void {
    // Nothing to clean up — forwarding persists across Cursor restarts
  }
}
