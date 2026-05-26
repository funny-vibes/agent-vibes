import { X509Certificate } from "crypto"
import * as fs from "fs"
import * as net from "net"
import * as path from "path"
import * as tls from "tls"
import * as vscode from "vscode"
import { CMD, CURSOR_DOMAINS } from "../constants"
import {
  type DashboardLocale,
  formatUi,
  getDashboardPanelTitle,
  getOverviewMessages,
  getSettingsCopy,
  getUiPack,
  readDashboardLocale,
  translateChecksumStatusDesc,
  translateCursorBuildUnknown,
  translateNotFound,
  translateOnOff,
  translatePatchResetHint,
} from "../i18n/dashboard-i18n"
import { t, tFmt } from "../i18n/messages-i18n"
import { BridgeManager } from "../services/bridge-manager"
import { startCodexOAuthFlow } from "../services/codex-oauth-service"
import { ConfigManager } from "../services/config-manager"
import { CursorChecksumsService } from "../services/cursor-checksums"
import { CursorPatchManagerService } from "../services/cursor-patch-manager"
import { NetworkManager } from "../services/network-manager"
import { startOAuthFlow } from "../services/oauth-service"
import { detectCurrentAntigravityVersion } from "../utils/antigravity-version"
import { detectCurrentCursorVersion } from "../utils/cursor-version"
import { logger } from "../utils/logger"
import { getCursorProductMetadata } from "../utils/platform"

type AccountChannel =
  | "antigravity"
  | "claude-api"
  | "codex"
  | "openai-compat"
  | "kiro"

type DashboardAccountChannelData = {
  accounts: Record<string, unknown>[]
  filePath: string
  exists: boolean
  source: "custom" | "default"
}

type DashboardOverviewStep = {
  id: string
  label: string
  description: string
  status: "done" | "action" | "pending"
  actionLabel?: string
  command?: string
  hint?: string
}

type DashboardOverviewPayload = {
  overallState: "ready" | "attention" | "setup"
  headline: string
  summary: string
  completedSteps: number
  totalSteps: number
  nextActionLabel: string
  nextActionCommand?: string
  steps: DashboardOverviewStep[]
}

type DashboardVersionPayload = {
  extensionVersion: string
  currentAntigravityVersion: string
  currentCursorVersion: string
  compatibleCursorVersion: string
}

/**
 * Webview Panel for the CCursor Dashboard.
 * Singleton — opening an existing panel brings it to focus.
 */
export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined
  private static readonly viewType = "agentVibes.dashboardPanel"

  private readonly panel: vscode.WebviewPanel
  private readonly extensionUri: vscode.Uri
  private readonly versionInfo: DashboardVersionPayload
  private disposables: vscode.Disposable[] = []
  private readonly handleBridgeStateChanged = () => {
    if (this.panel.visible) {
      this.sendAllData()
    }
  }

  private accountFileWatchers: vscode.FileSystemWatcher[] = []
  private accountFileDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private readonly cursorPatchManager = new CursorPatchManagerService()
  private readonly cursorChecksums = new CursorChecksumsService()

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly config: ConfigManager,
    private readonly bridge: BridgeManager,
    private readonly network: NetworkManager
  ) {
    this.panel = panel
    this.extensionUri = extensionUri
    this.versionInfo = this.getVersionInfo()

    // Set initial HTML
    this.panel.webview.html = this.getHtml()

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (msg: {
        type: string
        command?: string
        channel?: string
        index?: number
        accountId?: string
        raw?: string
        data?: Record<string, unknown>
        key?: string
        value?: unknown
        testId?: string
      }) => this.handleMessage(msg),
      null,
      this.disposables
    )

    // Cleanup on close
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)

    // Refresh when panel becomes visible
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible) {
          this.sendAllData()
        }
      },
      null,
      this.disposables
    )

    this.bridge.on("stateChanged", this.handleBridgeStateChanged)

    // Watch account config files for external changes
    this.watchAccountFiles()

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("agentVibes.language")) {
          this.panel.title = getDashboardPanelTitle(readDashboardLocale())
          this.panel.webview.html = this.getHtml()
          this.sendAllData()
        }
      })
    )
  }

  /**
   * Create or show the Dashboard panel (singleton).
   */
  static createOrShow(
    extensionUri: vscode.Uri,
    config: ConfigManager,
    bridge: BridgeManager,
    network: NetworkManager
  ): void {
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.title = getDashboardPanelTitle(
        readDashboardLocale()
      )
      DashboardPanel.currentPanel.panel.reveal(vscode.ViewColumn.One)
      DashboardPanel.currentPanel.sendAllData()
      return
    }

    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      getDashboardPanelTitle(readDashboardLocale()),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "resources")],
      }
    )

    panel.iconPath = vscode.Uri.joinPath(extensionUri, "resources", "icon.png")

    DashboardPanel.currentPanel = new DashboardPanel(
      panel,
      extensionUri,
      config,
      bridge,
      network
    )
  }

  /**
   * Handle messages from the Webview.
   */
  private async handleMessage(msg: {
    type: string
    command?: string
    channel?: string
    index?: number
    accountId?: string
    raw?: string
    data?: Record<string, unknown>
    key?: string
    value?: unknown
    testId?: string
  }): Promise<void> {
    switch (msg.type) {
      case "getAll":
        this.sendAllData()
        break

      case "addAccount":
        if (msg.channel && msg.data) {
          const filePath = this.getChannelPath(msg.channel)
          if (filePath) {
            this.config.addAccount(filePath, msg.data)
            this.sendAllData()
          }
        }
        break

      case "updateAccount":
        if (msg.channel !== undefined && msg.index !== undefined && msg.data) {
          const filePath = this.getChannelPath(msg.channel)
          if (filePath) {
            this.config.updateAccount(filePath, msg.index, msg.data)
            this.sendAllData()
          }
        }
        break

      case "addByToken":
        if (msg.channel && msg.raw) {
          this.handleAddByToken(msg.channel, msg.raw)
        }
        break

      case "runCommand":
        if (msg.command) {
          const fwdBefore = this.network.isForwardingActive()
          const commandPromise = vscode.commands.executeCommand(msg.command)
          // Push the changed state quickly so toggles/buttons can reflect
          // the command result before any follow-up notification is dismissed.
          setTimeout(() => this.sendAllData(), 50)
          try {
            await commandPromise
          } finally {
            setTimeout(() => this.sendAllData(), 1000)
            // For forwarding commands that run async in terminal (sudo),
            // poll until the state actually changes or timeout after 30s.
            if (
              msg.command.includes("Forwarding") ||
              msg.command.includes("forwarding")
            ) {
              let polls = 0
              const maxPolls = 15
              const pollInterval = setInterval(() => {
                polls++
                const fwdNow = this.network.isForwardingActive()
                this.sendAllData()
                if (fwdNow !== fwdBefore || polls >= maxPolls) {
                  clearInterval(pollInterval)
                }
              }, 2000)
            }
          }
        }
        break

      case "removeAccount":
        if (msg.channel !== undefined) {
          const filePath = this.getChannelPath(msg.channel)
          if (filePath) {
            if (msg.channel === "codex" && msg.accountId) {
              this.config.removeCodexAccount(filePath, msg.accountId)
            } else if (msg.index !== undefined) {
              this.config.removeAccount(filePath, msg.index)
            }
            this.sendAllData()
          }
        }
        break

      case "activateCodexCli":
        if (msg.index !== undefined) {
          this.activateCodexCliAccount(msg.index)
        }
        break

      case "openAccountFile":
        if (msg.channel) {
          await this.openAccountFile(msg.channel)
        }
        break

      case "getLogs":
        this.sendLogs()
        break

      case "copyLogPath":
        if (msg.raw) {
          await vscode.env.clipboard.writeText(msg.raw)
          void vscode.window.showInformationMessage(t("dash.logCopied"))
        }
        break

      case "getPoolStatus":
        void this.sendPoolStatus()
        break

      case "getGoogleQuota":
        void this.sendGoogleQuotaStatus(Boolean(msg.data?.force))
        break

      case "getCodexQuota":
        void this.sendCodexQuotaStatus(Boolean(msg.data?.force))
        break

      case "getKiroQuota":
        void this.sendKiroQuotaStatus()
        break

      case "getUsageSummary":
        void this.sendUsageSummary()
        break

      case "getDailyUsage":
        void this.sendDailyUsage()
        break

      case "updateSetting":
        if (msg.key !== undefined && msg.value !== undefined) {
          await this.handleUpdateSetting(msg.key, msg.value)
        }
        break

      case "runTest":
        if (msg.testId) {
          this.runDiagnosticTest(msg.testId)
        }
        break

      case "startOAuth":
        void this.handleStartOAuth()
        break

      case "startCodexOAuth":
        void this.handleStartCodexOAuth()
        break

      case "startKiroOAuth":
        void this.handleStartKiroOAuth()
        break

      case "importKiroToken":
        if (msg.raw) {
          this.handleImportKiroToken(msg.raw)
        }
        break
    }
  }

  /**
   * Read bridge log file and send last N lines to webview.
   */
  private sendLogs(): void {
    const os = require("os") as typeof import("os")
    const path = require("path") as typeof import("path")
    const fs = require("fs") as typeof import("fs")
    const logFile = path.join(os.tmpdir(), "agent-vibes-bridge.log")

    // Strip ANSI escape sequences (colors, bold, cursor, etc.)
    const stripAnsi = (s: string): string =>
      s.replace(
        // eslint-disable-next-line no-control-regex
        /\x1B(?:[@-Z\-_]|\[[0-?]*[ -/]*[@-~])/g,
        ""
      )

    let lines: string[] = []
    let exists = false
    try {
      exists = fs.existsSync(logFile)
      if (exists) {
        const content = fs.readFileSync(logFile, "utf-8")
        const all = content.split("\n")
        lines = all.slice(-300).map(stripAnsi)
      }
    } catch {
      lines = ["(Could not read log file)"]
    }

    this.panel.webview.postMessage({
      type: "logsUpdate",
      data: lines,
      debugMode: this.config.debugMode,
      logFilePath: logFile,
      logFileExists: exists,
    })
  }

  /**
   * Fetch pool status from the bridge API and send to webview.
   * Provides per-account runtime state (ready/cooldown/disabled), request counts, etc.
   */
  private async sendPoolStatus(): Promise<void> {
    if (this.bridge.state !== "running") {
      this.panel.webview.postMessage({
        type: "poolStatusUpdate",
        data: null,
      })
      return
    }

    try {
      const https = require("https") as typeof import("https")
      const caCert = this.config.caCertPath
      const caData = fs.existsSync(caCert) ? fs.readFileSync(caCert) : undefined

      const data = await new Promise<string>((resolve, reject) => {
        const options: import("https").RequestOptions = {
          hostname: "localhost",
          port: this.config.port,
          path: "/pool/status",
          method: "GET",
          ca: caData,
          rejectUnauthorized: !!caData,
          timeout: 120_000,
        }
        const req = https.get(options, (res) => {
          let body = ""
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString()
          })
          res.on("end", () => resolve(body))
        })
        req.on("error", reject)
        req.setTimeout(120_000, () => {
          req.destroy()
          reject(new Error("timeout"))
        })
      })

      const parsed = JSON.parse(data) as Record<string, unknown>
      this.panel.webview.postMessage({
        type: "poolStatusUpdate",
        data: parsed,
      })
    } catch (err) {
      logger.debug(
        `Pool status fetch failed: ${err instanceof Error ? err.message : String(err)}`
      )
      this.panel.webview.postMessage({
        type: "poolStatusUpdate",
        data: null,
      })
    }
  }

  private async sendGoogleQuotaStatus(force = false): Promise<void> {
    if (this.bridge.state !== "running") {
      this.panel.webview.postMessage({
        type: "googleQuotaUpdate",
        data: null,
      })
      return
    }

    try {
      const https = require("https") as typeof import("https")
      const caCert = this.config.caCertPath
      const caData = fs.existsSync(caCert) ? fs.readFileSync(caCert) : undefined
      const quotaPath = force ? "/quota/google?force=1" : "/quota/google"

      const data = await new Promise<string>((resolve, reject) => {
        const options: import("https").RequestOptions = {
          hostname: "localhost",
          port: this.config.port,
          path: quotaPath,
          method: "GET",
          ca: caData,
          rejectUnauthorized: !!caData,
          timeout: 15000,
        }
        const req = https.get(options, (res) => {
          let body = ""
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString()
          })
          res.on("end", () => resolve(body))
        })
        req.on("error", reject)
        req.setTimeout(15000, () => {
          req.destroy()
          reject(new Error("timeout"))
        })
      })

      const parsed = JSON.parse(data) as Record<string, unknown>
      this.panel.webview.postMessage({
        type: "googleQuotaUpdate",
        data: parsed,
      })
    } catch (err) {
      logger.debug(
        `Google quota fetch failed: ${err instanceof Error ? err.message : String(err)}`
      )
      this.panel.webview.postMessage({
        type: "googleQuotaUpdate",
        data: null,
      })
    }
  }

  private async sendCodexQuotaStatus(force = false): Promise<void> {
    if (this.bridge.state !== "running") {
      this.panel.webview.postMessage({
        type: "codexQuotaUpdate",
        data: null,
      })
      return
    }

    try {
      const https = require("https") as typeof import("https")
      const caCert = this.config.caCertPath
      const caData = fs.existsSync(caCert) ? fs.readFileSync(caCert) : undefined

      const data = await new Promise<string>((resolve, reject) => {
        const quotaPath = force ? "/quota/codex?force=1" : "/quota/codex"
        const options: import("https").RequestOptions = {
          hostname: "localhost",
          port: this.config.port,
          path: quotaPath,
          method: "GET",
          ca: caData,
          rejectUnauthorized: !!caData,
          timeout: 120_000,
        }
        const req = https.get(options, (res) => {
          let body = ""
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString()
          })
          res.on("end", () => resolve(body))
        })
        req.on("error", reject)
        req.setTimeout(120_000, () => {
          req.destroy()
          reject(new Error("timeout"))
        })
      })

      const parsed = JSON.parse(data) as Record<string, unknown>
      this.panel.webview.postMessage({
        type: "codexQuotaUpdate",
        data: parsed,
      })
    } catch (err) {
      logger.debug(
        `Codex quota fetch failed: ${err instanceof Error ? err.message : String(err)}`
      )
      this.panel.webview.postMessage({
        type: "codexQuotaUpdate",
        data: null,
      })
    }
  }

  private async sendKiroQuotaStatus(): Promise<void> {
    if (this.bridge.state !== "running") {
      this.panel.webview.postMessage({ type: "kiroQuotaUpdate", data: null })
      return
    }
    try {
      const data = await this.callBridgeApi<Record<string, unknown>>(
        "/quota/kiro",
        "GET"
      )
      this.panel.webview.postMessage({ type: "kiroQuotaUpdate", data })
    } catch (err) {
      logger.debug(
        `Kiro quota fetch failed: ${err instanceof Error ? err.message : String(err)}`
      )
      this.panel.webview.postMessage({ type: "kiroQuotaUpdate", data: null })
    }
  }

  private async sendUsageSummary(): Promise<void> {
    if (this.bridge.state !== "running") {
      this.panel.webview.postMessage({
        type: "usageSummaryUpdate",
        data: null,
      })
      return
    }

    try {
      const https = require("https") as typeof import("https")
      const caCert = this.config.caCertPath
      const caData = fs.existsSync(caCert) ? fs.readFileSync(caCert) : undefined

      const data = await new Promise<string>((resolve, reject) => {
        const options: import("https").RequestOptions = {
          hostname: "localhost",
          port: this.config.port,
          path: "/usage/summary",
          method: "GET",
          ca: caData,
          rejectUnauthorized: !!caData,
          timeout: 5000,
        }
        const req = https.get(options, (res) => {
          let body = ""
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString()
          })
          res.on("end", () => resolve(body))
        })
        req.on("error", reject)
        req.setTimeout(5000, () => {
          req.destroy()
          reject(new Error("timeout"))
        })
      })

      const parsed = JSON.parse(data) as Record<string, unknown>
      this.panel.webview.postMessage({
        type: "usageSummaryUpdate",
        data: parsed,
      })
    } catch (err) {
      logger.debug(
        `Usage summary fetch failed: ${err instanceof Error ? err.message : String(err)}`
      )
      this.panel.webview.postMessage({
        type: "usageSummaryUpdate",
        data: null,
      })
    }
  }

  private async sendDailyUsage(): Promise<void> {
    if (this.bridge.state !== "running") {
      this.panel.webview.postMessage({
        type: "dailyUsageUpdate",
        data: null,
      })
      return
    }

    try {
      const https = require("https") as typeof import("https")
      const caCert = this.config.caCertPath
      const caData = fs.existsSync(caCert) ? fs.readFileSync(caCert) : undefined

      const data = await new Promise<string>((resolve, reject) => {
        const options: import("https").RequestOptions = {
          hostname: "localhost",
          port: this.config.port,
          path: "/usage/daily",
          method: "GET",
          ca: caData,
          rejectUnauthorized: !!caData,
          timeout: 5000,
        }
        const req = https.get(options, (res) => {
          let body = ""
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString()
          })
          res.on("end", () => resolve(body))
        })
        req.on("error", reject)
        req.setTimeout(5000, () => {
          req.destroy()
          reject(new Error("timeout"))
        })
      })

      const parsed = JSON.parse(data) as Record<string, unknown>
      this.panel.webview.postMessage({
        type: "dailyUsageUpdate",
        data: parsed,
      })
    } catch (err) {
      logger.debug(
        `Daily usage fetch failed: ${err instanceof Error ? err.message : String(err)}`
      )
      this.panel.webview.postMessage({
        type: "dailyUsageUpdate",
        data: null,
      })
    }
  }

  /**
   * Persist a setting change from the webview to VS Code configuration.
   * Only whitelisted keys are accepted to prevent arbitrary config writes.
   */
  private async handleUpdateSetting(
    key: string,
    value: unknown
  ): Promise<void> {
    const allowedBooleans = new Set([
      "debugMode",
      "autoStart",
      "thinkingBudgetAuto",
      "antigravitySystemPrompt",
      "antigravityOfficialTools",
      "autoCheckUpdates",
    ])
    const allowedNumbers = new Set([
      "port",
      "healthCheckInterval",
      "updateCheckIntervalHours",
    ])
    const allowedStrings = new Set([
      "language",
      "dataDir",
      "antigravityAccountsPath",
      "codexAccountsPath",
      "openaiCompatAccountsPath",
      "claudeApiAccountsPath",
      "kiroAccountsPath",
    ])
    const config = vscode.workspace.getConfiguration("agentVibes")

    if (allowedBooleans.has(key)) {
      await config.update(
        key,
        Boolean(value),
        vscode.ConfigurationTarget.Global
      )

      if (key === "debugMode") {
        const action = await vscode.window.showInformationMessage(
          tFmt("dash.debugModeChanged", {
            state: value
              ? t("dash.debugMode.enabled")
              : t("dash.debugMode.disabled"),
          }),
          t("dash.action.restart"),
          t("dash.action.later")
        )
        if (action === t("dash.action.restart")) {
          await this.bridge.restart()
        }
      }

      this.sendAllData()
    } else if (allowedNumbers.has(key)) {
      const num = Number(value)
      if (!isNaN(num)) {
        await config.update(key, num, vscode.ConfigurationTarget.Global)
        this.sendAllData()
      }
    } else if (allowedStrings.has(key)) {
      const str = String(value ?? "").trim()
      await config.update(
        key,
        str || undefined,
        vscode.ConfigurationTarget.Global
      )

      if (
        key === "dataDir" ||
        key === "antigravityAccountsPath" ||
        key === "codexAccountsPath" ||
        key === "openaiCompatAccountsPath" ||
        key === "claudeApiAccountsPath" ||
        key === "kiroAccountsPath"
      ) {
        this.config.ensureDirectories()
        this.watchAccountFiles()
      }

      if (key !== "language") {
        vscode.window.showInformationMessage(
          str
            ? tFmt("dash.settingUpdated", { key })
            : tFmt("dash.settingReset", { key })
        )
      }
      this.sendAllData()
    }
  }

  /**
   * Handle batch token paste (Antigravity / Codex).
   * Supports: single token, JSON array, or multiple lines.
   */
  private handleAddByToken(channel: string, raw: string): void {
    const filePath = this.getChannelPath(channel)
    if (!filePath) return

    let tokenEntries: Array<{
      refreshToken: string
    }> = []
    const input = raw.trim()

    // Try JSON array: [{"refresh_token": "..."}, ...]
    try {
      if (input.startsWith("[") && input.endsWith("]")) {
        const parsed = JSON.parse(input) as Record<string, unknown>
        if (Array.isArray(parsed)) {
          tokenEntries = parsed
            .map((item: Record<string, unknown>) => ({
              refreshToken: String(
                item.refresh_token || item.refreshToken || ""
              ).trim(),
            }))
            .filter((item) => item.refreshToken.length > 5)
        }
      }
    } catch {
      // not JSON
    }

    // If no JSON matches, extract tokens by regex
    if (tokenEntries.length === 0) {
      // Google refresh tokens: 1//...
      // OpenAI refresh tokens: rt_...
      const regex = /(?:1\/\/[a-zA-Z0-9_-]+|rt_[a-zA-Z0-9_.+-]+)/g
      const matches = input.match(regex)
      if (matches) {
        tokenEntries = matches.map((refreshToken) => ({
          refreshToken,
        }))
      }
    }

    // Deduplicate
    tokenEntries = Array.from(
      new Map(
        tokenEntries.map((item) => [
          item.refreshToken,
          {
            refreshToken: item.refreshToken,
          },
        ])
      ).values()
    )

    if (tokenEntries.length === 0) {
      vscode.window.showWarningMessage(t("dash.token.invalid"))
      return
    }

    // Add each token as an account
    let added = 0
    for (const entry of tokenEntries) {
      const account: Record<string, string> = {
        refreshToken: entry.refreshToken,
      }
      this.config.addAccount(filePath, account)
      added++
    }

    vscode.window.showInformationMessage(
      tFmt("dash.token.added", { count: added, channel })
    )
    this.sendAllData()
  }

  /**
   * Send all dashboard data to the webview.
   */
  private sendAllData(): void {
    const locale = readDashboardLocale()
    const uiPack = getUiPack(locale)
    const st = getSettingsCopy(locale)

    const resetPatchState = this.cursorPatchManager.getResetState()
    const resetHintLocalized = translatePatchResetHint(
      locale,
      resetPatchState.hint
    )
    const cursorBuildInfo = getCursorProductMetadata()
    const forwardingActive = this.network.isForwardingActive()
    const cursorBuildRaw = cursorBuildInfo
      ? [
          cursorBuildInfo.version,
          cursorBuildInfo.commit ? cursorBuildInfo.commit.slice(0, 12) : null,
          cursorBuildInfo.date
            ? new Date(cursorBuildInfo.date).toISOString().slice(0, 10)
            : null,
        ]
          .filter((part): part is string => Boolean(part))
          .join(" • ")
      : "Unknown"
    const cursorBuildValue = translateCursorBuildUnknown(locale, cursorBuildRaw)
    const cursorChecksumsStatus = this.cursorChecksums.getStatus()
    const checksumToggleValue =
      cursorChecksumsStatus.differsFromBaseline === true
    const checksumStatusDescRaw = !cursorChecksumsStatus.productExists
      ? "Cursor product.json was not found in a supported install location."
      : cursorChecksumsStatus.differsFromBaseline === true
        ? "Core file checksums were updated from the original product.json backup."
        : cursorChecksumsStatus.allMatched
          ? "Core file checksums already match product.json."
          : `${cursorChecksumsStatus.mismatchCount} core file checksum(s) differ from product.json. This usually only needs manual repair after out-of-band core file changes.`
    const checksumStatusDesc = translateChecksumStatusDesc(
      locale,
      checksumStatusDescRaw
    )
    const channelAccountsData = {
      codex: this.getChannelData("codex"),
      "openai-compat": this.getChannelData("openai-compat"),
      "claude-api": this.getChannelData("claude-api"),
      antigravity: this.getChannelData("antigravity"),
      kiro: this.getChannelData("kiro"),
    }
    const accountsData = {
      ...channelAccountsData,
    }

    const totalAccounts = Object.values(channelAccountsData).reduce(
      (sum, channel) => sum + channel.accounts.length,
      0
    )

    const statusData = {
      locale,
      uiPack,
      bridge: this.bridge.state === "running" ? "Running" : this.bridge.state,
      port: this.config.port,
      forwarding: forwardingActive,
      routingActive: forwardingActive,
      hasCertificates: this.config.hasCertificates(),
      totalAccounts,
      defaultProxyUrl: this.getDefaultProxyUrl(),
      setup: this.getOverviewPayload(channelAccountsData, locale),
      versions: this.versionInfo,
    }

    // Status
    this.panel.webview.postMessage({
      type: "statusUpdate",
      data: statusData,
    })

    // Accounts
    this.panel.webview.postMessage({
      type: "accountsUpdate",
      data: accountsData,
    })

    const agentCfg = vscode.workspace.getConfiguration("agentVibes")
    const languageValue =
      agentCfg.get<string>("language") === "zh" ? "zh" : "en"

    // Settings — only configurable items, grouped by module
    this.panel.webview.postMessage({
      type: "settingsUpdate",
      data: {
        groups: [
          {
            id: "general",
            label: st.groups.general.label,
            desc: st.groups.general.desc,
            items: [
              {
                label: st.groups.general.items.language.label,
                desc: st.groups.general.items.language.desc,
                type: "select",
                key: "language",
                value: languageValue,
                options: [
                  { value: "en", label: st.general.langEn },
                  { value: "zh", label: st.general.langZh },
                ],
              },
            ],
          },
          {
            id: "bridge",
            label: st.groups.bridge.label,
            desc: st.groups.bridge.desc,
            items: [
              {
                label: st.groups.bridge.items.autoStart.label,
                desc: st.groups.bridge.items.autoStart.desc,
                type: "toggle",
                key: "autoStart",
                value: this.config.autoStart,
              },
              {
                label: st.groups.bridge.items.port.label,
                desc: st.groups.bridge.items.port.desc,
                type: "number",
                key: "port",
                value: this.config.port,
              },
              {
                label: st.groups.bridge.items.healthCheckInterval.label,
                desc: st.groups.bridge.items.healthCheckInterval.desc,
                type: "number",
                key: "healthCheckInterval",
                value: this.config.healthCheckInterval,
              },
            ],
          },
          {
            id: "antigravity",
            label: st.groups.antigravity.label,
            desc: st.groups.antigravity.desc,
            items: [
              {
                label:
                  st.groups.antigravity.items.antigravitySystemPrompt.label,
                desc: st.groups.antigravity.items.antigravitySystemPrompt.desc,
                type: "toggle",
                key: "antigravitySystemPrompt",
                value: this.config.antigravitySystemPrompt,
              },
              {
                label: st.groups.antigravity.items.thinkingBudgetAuto.label,
                desc: st.groups.antigravity.items.thinkingBudgetAuto.desc,
                type: "toggle",
                key: "thinkingBudgetAuto",
                value: this.config.thinkingBudgetAuto,
              },
              {
                label:
                  st.groups.antigravity.items.antigravityOfficialTools.label,
                desc: st.groups.antigravity.items.antigravityOfficialTools.desc,
                type: "toggle",
                key: "antigravityOfficialTools",
                value: this.config.antigravityOfficialTools,
              },
            ],
          },
          {
            id: "storage",
            label: st.groups.storage.label,
            desc: st.groups.storage.desc,
            items: [
              {
                label: st.groups.storage.items.dataDir.label,
                desc: st.groups.storage.items.dataDir.desc,
                type: "path",
                key: "dataDir",
                value: agentCfg.get<string>("dataDir") || "",
                placeholder: this.config.dataDir,
              },
              {
                label: st.groups.storage.items.antigravityAccountsPath.label,
                desc: st.groups.storage.items.antigravityAccountsPath.desc,
                type: "path",
                key: "antigravityAccountsPath",
                value: agentCfg.get<string>("antigravityAccountsPath") || "",
                placeholder: this.config.antigravityAccountsPath,
              },
              {
                label: st.groups.storage.items.codexAccountsPath.label,
                desc: st.groups.storage.items.codexAccountsPath.desc,
                type: "path",
                key: "codexAccountsPath",
                value: agentCfg.get<string>("codexAccountsPath") || "",
                placeholder: this.config.codexAccountsPath,
              },
              {
                label: st.groups.storage.items.openaiCompatAccountsPath.label,
                desc: st.groups.storage.items.openaiCompatAccountsPath.desc,
                type: "path",
                key: "openaiCompatAccountsPath",
                value: agentCfg.get<string>("openaiCompatAccountsPath") || "",
                placeholder: this.config.openaiCompatAccountsPath,
              },
              {
                label: st.groups.storage.items.claudeApiAccountsPath.label,
                desc: st.groups.storage.items.claudeApiAccountsPath.desc,
                type: "path",
                key: "claudeApiAccountsPath",
                value: agentCfg.get<string>("claudeApiAccountsPath") || "",
                placeholder: this.config.claudeApiAccountsPath,
              },
              {
                label: st.groups.storage.items.kiroAccountsPath.label,
                desc: st.groups.storage.items.kiroAccountsPath.desc,
                type: "path",
                key: "kiroAccountsPath",
                value: agentCfg.get<string>("kiroAccountsPath") || "",
                placeholder: this.config.kiroAccountsPath,
              },
            ],
          },
          {
            id: "patch",
            label: st.groups.patch.label,
            desc: st.groups.patch.desc,
            items: [
              {
                label: st.groups.patch.items.cursorAppRoot.label,
                desc: st.groups.patch.items.cursorAppRoot.desc,
                value: translateNotFound(
                  locale,
                  cursorChecksumsStatus.appRootPath || "Not found"
                ),
              },
              {
                label: st.groups.patch.items.cursorBuild.label,
                desc: st.groups.patch.items.cursorBuild.desc,
                value: cursorBuildValue,
              },
              {
                label: st.groups.patch.items.resetPatches.label,
                desc: st.groups.patch.items.resetPatches.desc,
                type: "actions",
                hint: resetHintLocalized,
                actions: [
                  {
                    label: st.patch.resetAll,
                    command: CMD.RESET_CURSOR_PATCHES,
                    tone: "secondary",
                    disabled: !resetPatchState.canReset,
                  },
                ],
              },
              {
                label: st.groups.patch.items.fixChecksums.label,
                desc: st.groups.patch.items.fixChecksums.desc,
                value: translateOnOff(
                  locale,
                  checksumToggleValue ? "On" : "Off"
                ),
                hint: checksumStatusDesc,
              },
            ],
          },
        ],
      },
    })

    void this.sendUsageSummary()
  }

  private getOverviewPayload(
    accountsData: Record<AccountChannel, DashboardAccountChannelData>,
    locale: DashboardLocale
  ): DashboardOverviewPayload {
    const o = getOverviewMessages(locale)
    const hasCertificates = this.config.hasCertificates()
    const bridgeRunning = this.bridge.state === "running"
    const forwardingActive = this.network.isForwardingActive()
    const totalAccounts = Object.values(accountsData).reduce(
      (sum, channel) => sum + channel.accounts.length,
      0
    )

    const fwd = this.network.getForwardingBackend()
    const forwardingActiveDesc =
      fwd === "relay"
        ? o.forwardingRelay
        : fwd === "portproxy"
          ? o.forwardingPortproxy
          : o.forwardingIptables

    const steps: DashboardOverviewStep[] = [
      {
        id: "certs",
        label: o.certsLabel,
        description: hasCertificates ? o.certsDone : o.certsTodo,
        status: hasCertificates ? "done" : "action",
        actionLabel: hasCertificates ? undefined : o.certsAction,
        command: hasCertificates ? undefined : CMD.GENERATE_CERT,
      },
      {
        id: "accounts",
        label: o.accountsLabel,
        description:
          totalAccounts > 0
            ? formatUi(o.accountsCount, { n: totalAccounts })
            : o.accountsTodo,
        status: totalAccounts > 0 ? "done" : "action",
        actionLabel: undefined,
      },
      {
        id: "bridge",
        label: o.bridgeLabel,
        description: bridgeRunning
          ? formatUi(o.bridgeRunning, { port: this.config.port })
          : o.bridgeTodo,
        status: bridgeRunning
          ? "done"
          : totalAccounts > 0 && hasCertificates
            ? "action"
            : "pending",
        actionLabel:
          bridgeRunning || !hasCertificates || totalAccounts === 0
            ? undefined
            : o.bridgeAction,
        command:
          bridgeRunning || !hasCertificates || totalAccounts === 0
            ? undefined
            : CMD.START_SERVER,
      },
      {
        id: "forwarding",
        label: o.forwardingLabel,
        description: forwardingActive ? forwardingActiveDesc : o.forwardingTodo,
        status: forwardingActive
          ? "done"
          : bridgeRunning
            ? "action"
            : "pending",
        actionLabel:
          forwardingActive || !bridgeRunning ? undefined : o.forwardingAction,
        command:
          forwardingActive || !bridgeRunning
            ? undefined
            : CMD.ENABLE_FORWARDING,
      },
    ]

    const completedSteps = steps.filter((step) => step.status === "done").length
    const nextAction = steps.find((step) => step.status === "action")

    let overallState: DashboardOverviewPayload["overallState"] = "setup"
    let headline = o.setupHeadline
    let summary = o.setupSummary

    if (
      completedSteps === steps.length ||
      (bridgeRunning &&
        forwardingActive &&
        totalAccounts > 0 &&
        hasCertificates)
    ) {
      overallState = "ready"
      headline = o.readyHeadline
      summary = o.readySummary
    } else if (completedSteps >= 2 || bridgeRunning || totalAccounts > 0) {
      overallState = "attention"
      headline = o.attentionHeadline
      summary = o.attentionSummary
    }

    return {
      overallState,
      headline,
      summary,
      completedSteps,
      totalSteps: steps.length,
      nextActionLabel:
        nextAction?.actionLabel ||
        (overallState === "ready" ? o.restartAction : o.reviewAction),
      nextActionCommand:
        nextAction?.command ||
        (overallState === "ready" ? CMD.RESTART_SERVER : undefined),
      steps,
    }
  }

  /**
   * Run a single diagnostic test and stream results to the webview.
   */
  private runDiagnosticTest(testId: string): void {
    const { execSync } =
      require("child_process") as typeof import("child_process")

    const emit = (line: string) => {
      this.panel.webview.postMessage({
        type: "testResult",
        data: { testId, line },
      })
    }
    const done = (status: "pass" | "fail" | "warn") => {
      this.panel.webview.postMessage({
        type: "testResult",
        data: { testId, status },
      })
    }

    try {
      switch (testId) {
        // ── 1. Proxy Bypass ──
        case "proxy": {
          if (process.platform === "darwin") {
            try {
              // 1) Check if any system proxy is enabled via scutil
              const scutil = execSync("scutil --proxy", {
                encoding: "utf-8",
                timeout: 3000,
                stdio: "pipe",
              })
              const httpEnabled = /\bHTTPEnable\s*:\s*1\b/.test(scutil)
              const httpsEnabled = /\bHTTPSEnable\s*:\s*1\b/.test(scutil)
              const socksEnabled = /\bSOCKSEnable\s*:\s*1\b/.test(scutil)
              if (!httpEnabled && !httpsEnabled && !socksEnabled) {
                emit("System proxy: not enabled (HTTP/HTTPS/SOCKS all off)")
                emit("✓ No proxy to bypass")
                done("pass")
                break
              }
              // Extract proxy URLs from scutil output
              const httpHost =
                scutil.match(/\bHTTPProxy\s*:\s*(\S+)/)?.[1] || ""
              const httpPort = scutil.match(/\bHTTPPort\s*:\s*(\d+)/)?.[1] || ""
              const httpsHost =
                scutil.match(/\bHTTPSProxy\s*:\s*(\S+)/)?.[1] || ""
              const httpsPort =
                scutil.match(/\bHTTPSPort\s*:\s*(\d+)/)?.[1] || ""
              const socksHost =
                scutil.match(/\bSOCKSProxy\s*:\s*(\S+)/)?.[1] || ""
              const socksPort =
                scutil.match(/\bSOCKSPort\s*:\s*(\d+)/)?.[1] || ""
              if (httpEnabled) emit(`HTTP proxy:  ${httpHost}:${httpPort}`)
              if (httpsEnabled) emit(`HTTPS proxy: ${httpsHost}:${httpsPort}`)
              if (socksEnabled) emit(`SOCKS proxy: ${socksHost}:${socksPort}`)

              // 2) Read bypass domains via networksetup (matches setup-forwarding.js)
              const svcList = execSync("networksetup -listallnetworkservices", {
                encoding: "utf-8",
                timeout: 3000,
                stdio: "pipe",
              })
              const services = svcList
                .split("\n")
                .filter(
                  (l: string) =>
                    l.trim() &&
                    !l.startsWith("An asterisk") &&
                    !l.startsWith("*")
                )
              const svc = services[0]
              if (!svc) {
                emit("No active network service found")
                done("warn")
                break
              }
              emit(`Network service: ${svc}`)
              const bypassRaw = execSync(
                `networksetup -getproxybypassdomains "${svc}"`,
                { encoding: "utf-8", timeout: 3000, stdio: "pipe" }
              )
              const bypassList = bypassRaw
                .split("\n")
                .map((l: string) => l.trim())
                .filter((l: string) => l && !/^There aren't any/.test(l))

              const checkEntries = [
                ...CURSOR_DOMAINS.map((d) => d),
                ...CURSOR_DOMAINS.map((d) => `*.${d}`),
                "127.0.0.2",
              ]
              const missingEntries: string[] = []
              for (const entry of checkEntries) {
                if (!bypassList.includes(entry)) {
                  missingEntries.push(entry)
                }
              }
              if (missingEntries.length === 0) {
                emit(`✓ All ${checkEntries.length} bypass entries present`)
              } else {
                emit(`Bypass entries: ${bypassList.length}`)
                for (const entry of missingEntries) {
                  emit(`  ${entry}: ✗ MISSING`)
                }
              }
              done(missingEntries.length === 0 ? "pass" : "warn")
            } catch (err) {
              emit(
                `Could not read proxy config: ${err instanceof Error ? err.message : String(err)}`
              )
              done("warn")
            }
          } else if (process.platform === "win32") {
            try {
              const reg = execSync(
                'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
                { encoding: "utf-8", timeout: 3000, stdio: "pipe" }
              )
              if (!reg.includes("0x1")) {
                emit("System proxy: disabled")
                emit("✓ No proxy to bypass")
                done("pass")
                break
              }
              emit("System proxy: enabled")
              const bypassRaw = execSync(
                'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride',
                { encoding: "utf-8", timeout: 3000, stdio: "pipe" }
              )
              const match = bypassRaw.match(/ProxyOverride\s+REG_SZ\s+(.+)/)
              const bypassList = match?.[1]
                ? match[1]
                    .split(";")
                    .map((e: string) => e.trim())
                    .filter(Boolean)
                : []
              emit(`Bypass entries: ${bypassList.length}`)

              const checkEntries = [...CURSOR_DOMAINS, "127.0.0.2"]
              let missing = 0
              for (const entry of checkEntries) {
                const found =
                  bypassList.includes(entry) ||
                  bypassList.some((b: string) => b === "*.cursor.sh")
                if (!found) {
                  emit(`  ${entry}: ✗ NOT bypassed`)
                  missing++
                }
              }
              if (missing === 0) emit("✓ All bypass entries present")
              done(missing === 0 ? "pass" : "warn")
            } catch {
              emit("Could not read proxy config")
              done("warn")
            }
          } else {
            try {
              const mode = execSync(
                "gsettings get org.gnome.system.proxy mode",
                { encoding: "utf-8", timeout: 3000, stdio: "pipe" }
              ).trim()
              if (mode !== "'manual'") {
                emit(`Proxy mode: ${mode} (not manual)`)
                emit("✓ No proxy to bypass")
                done("pass")
                break
              }
              emit("Proxy mode: manual")
              const ignore = execSync(
                "gsettings get org.gnome.system.proxy ignore-hosts",
                { encoding: "utf-8", timeout: 3000, stdio: "pipe" }
              ).trim()
              const checkEntries = [...CURSOR_DOMAINS, "127.0.0.2"]
              let missing = 0
              for (const entry of checkEntries) {
                const found =
                  ignore.includes(entry) || ignore.includes("*.cursor.sh")
                if (!found) {
                  emit(`  ${entry}: ✗ NOT bypassed`)
                  missing++
                }
              }
              if (missing === 0) emit("✓ All bypass entries present")
              done(missing === 0 ? "pass" : "warn")
            } catch {
              emit("gsettings not available, skipping")
              done("pass")
            }
          }
          break
        }

        // ── 2. SSL Certificates ──
        case "ssl": {
          const serverCert = this.config.serverCertPath
          const serverKey = this.config.serverKeyPath
          const caCert = this.config.caCertPath
          emit(`Checking ${serverCert}`)
          const hasCert = fs.existsSync(serverCert)
          emit(hasCert ? "✓ server.pem found" : "✗ server.pem missing")
          emit(`Checking ${serverKey}`)
          const hasKey = fs.existsSync(serverKey)
          emit(hasKey ? "✓ server-key.pem found" : "✗ server-key.pem missing")
          emit(`Checking ${caCert}`)
          const hasCa = fs.existsSync(caCert)
          emit(hasCa ? "✓ ca.pem found" : "✗ ca.pem missing")

          if (!hasCert || !hasKey || !hasCa) {
            done("fail")
            break
          }

          try {
            const stat = fs.statSync(serverCert)
            emit(
              `  server.pem size: ${stat.size} bytes, modified: ${stat.mtime.toISOString()}`
            )
          } catch {
            /* ignore */
          }

          try {
            const pem = fs.readFileSync(serverCert, "utf-8")
            const x509 = new X509Certificate(pem)
            emit(`Subject: ${x509.subject}`)
            emit(`Issuer: ${x509.issuer}`)
            emit(`Valid from: ${x509.validFrom}`)
            emit(`Valid to: ${x509.validTo}`)
            emit(`SAN: ${x509.subjectAltName || "(none)"}`)

            const requiredNames = [
              "localhost",
              "api2.cursor.sh",
              "api2geo.cursor.sh",
              "api2direct.cursor.sh",
              "api5.cursor.sh",
              "127.0.0.2",
            ]
            const missingNames = requiredNames.filter(
              (name) => !(x509.subjectAltName || "").includes(name)
            )

            if (missingNames.length === 0) {
              emit("✓ Certificate SAN covers required Cursor domains")
              done("pass")
            } else {
              emit("✗ Certificate SAN is missing required names:")
              for (const name of missingNames) {
                emit(`  ${name}`)
              }
              done("fail")
            }
          } catch (err) {
            emit(
              `✗ Failed to parse certificate: ${err instanceof Error ? err.message : String(err)}`
            )
            done("fail")
          }
          break
        }

        // ── 3. Bridge Health (HTTPS) ──
        case "bridge": {
          const port = this.config.port
          const caPath = this.config.caCertPath
          emit(`HTTPS health check → localhost:${port}/health`)
          try {
            const ca = fs.readFileSync(caPath)
            const https = require("https") as typeof import("https")
            const req = https.get(
              {
                hostname: "localhost",
                port,
                path: "/health",
                method: "GET",
                ca,
              },
              (res) => {
                emit(`Status: ${res.statusCode}`)
                if (res.statusCode === 200) {
                  emit("✓ Bridge is healthy")
                  done("pass")
                } else {
                  emit(`✗ Unexpected status ${res.statusCode}`)
                  done("fail")
                }
                res.resume()
              }
            )
            req.on("error", (err: Error) => {
              emit(`✗ ${err.message}`)
              done("fail")
            })
            req.setTimeout(3000, () => {
              emit("✗ Request timed out")
              req.destroy()
              done("fail")
            })
          } catch (err) {
            emit(`✗ ${err instanceof Error ? err.message : String(err)}`)
            emit("(Is the CA cert available?)")
            done("fail")
          }
          return // async
        }

        // ── 4. End-to-End Cursor TLS ──
        case "h2": {
          const targetHost = "api2.cursor.sh"
          const caPath = this.config.caCertPath
          emit(`TLS connect → ${targetHost}:443`)

          let ca: Buffer
          try {
            ca = fs.readFileSync(caPath)
          } catch (err) {
            emit(
              `✗ Failed to read CA certificate: ${err instanceof Error ? err.message : String(err)}`
            )
            done("fail")
            break
          }

          const socket = tls.connect({
            host: targetHost,
            port: 443,
            servername: targetHost,
            ca,
            rejectUnauthorized: true,
            ALPNProtocols: ["h2", "http/1.1"],
            timeout: 5000,
          })

          socket.once("secureConnect", () => {
            const peer = socket.getPeerCertificate(true)
            emit(
              `Remote address: ${socket.remoteAddress || "(unknown)"}:${socket.remotePort || ""}`
            )
            emit(`Authorized: ${socket.authorized ? "yes" : "no"}`)
            if (!socket.authorized && socket.authorizationError) {
              emit(`Authorization error: ${socket.authorizationError}`)
            }
            emit(`ALPN: ${socket.alpnProtocol || "(none)"}`)
            emit(`Certificate subject: ${JSON.stringify(peer.subject || {})}`)
            emit(`Certificate issuer: ${JSON.stringify(peer.issuer || {})}`)
            emit(`Certificate SAN: ${peer.subjectaltname || "(none)"}`)

            const san = peer.subjectaltname || ""
            const remote = socket.remoteAddress || ""
            const loopback =
              remote === "127.0.0.2" ||
              remote === "127.0.0.1" ||
              remote === "::1"
            const sanMatches = san.includes(`DNS:${targetHost}`)

            if (!sanMatches) {
              emit(`✗ Presented certificate does not cover ${targetHost}`)
              socket.end()
              done("fail")
              return
            }

            if (!loopback) {
              emit(
                "✗ Connection did not terminate on local forwarding IP (possible TUN/global proxy interception)"
              )
              socket.end()
              done("fail")
              return
            }

            emit("✓ End-to-end TLS looks correct for Cursor domain")
            socket.end()
            done("pass")
          })

          socket.once("timeout", () => {
            emit("✗ TLS connection timed out")
            socket.destroy()
            done("fail")
          })

          socket.once("error", (err: Error & { code?: string }) => {
            emit(`✗ TLS error: ${err.message}`)
            if (err.code) {
              emit(`Error code: ${err.code}`)
            }
            socket.destroy()
            done("fail")
          })
          return // async
        }

        // ── 5. Traffic Forwarding ──
        case "forwarding": {
          const forwarding = this.network.getForwardingStatus()
          emit(
            forwarding.hasHosts
              ? "✓ /etc/hosts entries found"
              : "✗ /etc/hosts entries missing"
          )

          if (forwarding.hasLoopbackAlias !== null) {
            emit(
              forwarding.hasLoopbackAlias
                ? "✓ Loopback alias (127.0.0.2) active"
                : "✗ Loopback alias missing"
            )
          }

          emit(
            forwarding.backendConfigured
              ? `✓ ${forwarding.backendStatusLabel} active`
              : `✗ ${forwarding.backendStatusLabel} missing`
          )

          // End-to-end: try connecting 127.0.0.2:443
          emit("Testing 127.0.0.2:443 → 127.0.0.1:" + this.config.port + "...")
          const sock = new net.Socket()
          sock.setTimeout(2000)
          sock.once("connect", () => {
            emit("✓ End-to-end forwarding OK")
            sock.destroy()
            done(forwarding.active ? "pass" : "warn")
          })
          sock.once("timeout", () => {
            emit("✗ 127.0.0.2:443 timed out")
            sock.destroy()
            done(
              forwarding.hasHosts || forwarding.backendConfigured
                ? "warn"
                : "fail"
            )
          })
          sock.once("error", (err: Error) => {
            emit(`✗ 127.0.0.2:443: ${err.message}`)
            sock.destroy()
            done(
              forwarding.hasHosts || forwarding.backendConfigured
                ? "warn"
                : "fail"
            )
          })
          sock.connect(443, "127.0.0.2")
          return // async
        }

        // ── 6. DNS Resolution ──
        case "dns": {
          const domains = [...CURSOR_DOMAINS]
          emit("Checking /etc/hosts for Cursor domain entries...")
          let allFound = true
          try {
            const hostsPath =
              process.platform === "win32"
                ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
                : "/etc/hosts"
            const hosts = fs.readFileSync(hostsPath, "utf-8")
            for (const domain of domains) {
              const found = hosts.includes(domain)
              emit(
                `  ${domain}: ${found ? "✓ mapped to 127.0.0.2" : "✗ not found"}`
              )
              if (!found) allFound = false
            }
          } catch (err) {
            emit(
              `Could not read hosts file: ${err instanceof Error ? err.message : String(err)}`
            )
            allFound = false
          }
          done(allFound ? "pass" : "warn")
          break
        }

        // ── 7. Backend Accounts ──
        case "accounts": {
          const channels: AccountChannel[] = [
            "antigravity",
            "codex",
            "openai-compat",
            "claude-api",
            "kiro",
          ]
          let total = 0
          for (const ch of channels) {
            const fp = this.getChannelPath(ch)
            const count = fp ? this.config.getAccountCount(fp) : 0
            emit(`${ch}: ${count} account(s)`)
            total += count
          }
          emit(
            total > 0
              ? `✓ Total: ${total} account(s)`
              : "✗ No accounts configured"
          )
          done(total > 0 ? "pass" : "fail")
          break
        }

        default:
          emit(`Unknown test: ${testId}`)
          done("fail")
      }
    } catch (err) {
      emit(`Error: ${err instanceof Error ? err.message : String(err)}`)
      done("fail")
    }
  }

  /**
   * Handle OAuth authorization flow for Antigravity accounts.
   */
  private async handleStartOAuth(): Promise<void> {
    try {
      // Notify frontend: loading
      this.panel.webview.postMessage({
        type: "oauthStatus",
        data: { status: "loading", message: "Starting OAuth flow..." },
      })

      const flow = await startOAuthFlow()

      // Open browser
      await vscode.env.openExternal(vscode.Uri.parse(flow.authUrl))

      // Notify frontend: waiting for authorization
      this.panel.webview.postMessage({
        type: "oauthStatus",
        data: { status: "loading", message: "Waiting for authorization..." },
      })

      // Wait for callback
      const result = await flow.waitForResult()

      // Save to antigravity-accounts.json
      const account: Record<string, string> = {
        email: result.email,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
      }
      this.upsertAntigravityAccount(account)

      // Notify frontend: success
      this.panel.webview.postMessage({
        type: "oauthStatus",
        data: {
          status: "success",
          message: `Account saved: ${result.email}`,
        },
      })

      // Refresh all data
      this.sendAllData()
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error("OAuth flow failed", err)

      this.panel.webview.postMessage({
        type: "oauthStatus",
        data: { status: "error", message: errorMsg },
      })
    }
  }

  /**
   * Codex OAuth2 PKCE flow — opens browser for OpenAI authorization.
   */
  private async handleStartCodexOAuth(): Promise<void> {
    try {
      this.panel.webview.postMessage({
        type: "codexOAuthStatus",
        data: { status: "loading", message: "Starting Codex OAuth flow..." },
      })

      const flow = await startCodexOAuthFlow()

      // Open browser
      await vscode.env.openExternal(vscode.Uri.parse(flow.authUrl))

      this.panel.webview.postMessage({
        type: "codexOAuthStatus",
        data: {
          status: "loading",
          message: "Waiting for OpenAI authorization...",
        },
      })

      // Wait for callback
      const result = await flow.waitForResult()

      // Save to codex-accounts.json
      const account: Record<string, string> = {
        email: result.email,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        idToken: result.idToken,
        accountId: result.accountId,
        workspaceId: result.workspaceId,
        planType: result.planType,
        expire: result.expire,
      }

      // Remove empty values
      for (const key of Object.keys(account)) {
        if (!account[key]) delete account[key]
      }

      this.upsertCodexAccount(account)

      this.panel.webview.postMessage({
        type: "codexOAuthStatus",
        data: {
          status: "success",
          message: `Codex account added: ${result.email || result.accountId || "unknown"}${result.planType ? ` (${result.planType})` : ""}`,
        },
      })

      this.sendAllData()

      // Refresh pool status and force a Codex quota fetch after a short delay
      // so the new account's rate-limit / plan info is displayed immediately.
      setTimeout(() => {
        void this.sendPoolStatus()
        void this.sendCodexQuotaStatus(true)
      }, 2000)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error("Codex OAuth flow failed", err)

      this.panel.webview.postMessage({
        type: "codexOAuthStatus",
        data: { status: "error", message: errorMsg },
      })
    }
  }

  /**
   * Kiro Builder ID device-flow OAuth — calls bridge endpoints.
   */
  private async handleStartKiroOAuth(): Promise<void> {
    try {
      this.panel.webview.postMessage({
        type: "kiroOAuthStatus",
        data: { status: "loading", message: "Starting Builder ID flow..." },
      })

      const startResult = await this.callBridgeApi<{
        sessionId: string
        verificationUriComplete: string
        userCode: string
        intervalMs: number
        expiresAt: number
      }>("/api/kiro/login/start", "POST", {})

      if (!startResult?.sessionId) {
        throw new Error("Bridge returned invalid Kiro login session")
      }

      // Open browser
      await vscode.env.openExternal(
        vscode.Uri.parse(startResult.verificationUriComplete)
      )

      this.panel.webview.postMessage({
        type: "kiroOAuthStatus",
        data: {
          status: "loading",
          message: `Waiting for approval... (code: ${startResult.userCode})`,
        },
      })

      // Poll until completed or expired
      let intervalMs = startResult.intervalMs || 5000
      const deadline = startResult.expiresAt || Date.now() + 600_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs))

        const poll = await this.callBridgeApi<{
          status: string
          intervalMs?: number
          accountCount?: number
          path?: string
        }>("/api/kiro/login/poll", "POST", {
          sessionId: startResult.sessionId,
        })

        if (!poll) {
          throw new Error("Bridge poll returned empty response")
        }

        if (poll.status === "completed") {
          this.panel.webview.postMessage({
            type: "kiroOAuthStatus",
            data: {
              status: "success",
              message: `Kiro account added (${poll.accountCount} total)`,
            },
          })
          this.sendAllData()
          return
        }

        if (poll.status === "expired") {
          throw new Error("Builder ID device code expired")
        }

        if (poll.status === "slow_down" && poll.intervalMs) {
          intervalMs = poll.intervalMs
        }
      }

      throw new Error("Builder ID authorization timed out")
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error("Kiro OAuth flow failed", err)

      this.panel.webview.postMessage({
        type: "kiroOAuthStatus",
        data: { status: "error", message: errorMsg },
      })
    }
  }

  /**
   * Kiro manual token paste — calls bridge /api/kiro/import.
   */
  private handleImportKiroToken(raw: string): void {
    this.callBridgeApi<{
      imported: number
      accountCount: number
      error?: string
    }>("/api/kiro/import", "POST", { raw })
      .then((result) => {
        if (result?.error) {
          vscode.window.showErrorMessage(`Kiro import: ${result.error}`)
        } else if (result && result.imported > 0) {
          vscode.window.showInformationMessage(
            `Kiro: imported ${result.imported} account(s)`
          )
        } else {
          vscode.window.showWarningMessage(
            "Kiro: no valid tokens found in the pasted JSON"
          )
        }
        this.sendAllData()
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`Kiro import failed: ${msg}`)
      })
  }

  /**
   * Generic bridge API caller for Kiro endpoints.
   */
  private async callBridgeApi<T>(
    apiPath: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>
  ): Promise<T | null> {
    const https = require("https") as typeof import("https")
    const caCert = this.config.caCertPath
    const caData = fs.existsSync(caCert) ? fs.readFileSync(caCert) : undefined
    const payload = body ? JSON.stringify(body) : ""

    return new Promise<T | null>((resolve, reject) => {
      const options: import("https").RequestOptions = {
        hostname: "localhost",
        port: this.config.port,
        path: apiPath,
        method,
        ca: caData,
        rejectUnauthorized: !!caData,
        timeout: 30_000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      }
      const req = https.request(options, (res) => {
        let responseBody = ""
        res.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString()
        })
        res.on("end", () => {
          try {
            resolve(responseBody ? (JSON.parse(responseBody) as T) : null)
          } catch {
            resolve(null)
          }
        })
      })
      req.on("error", reject)
      req.setTimeout(30_000, () => {
        req.destroy(new Error("Bridge API request timed out"))
      })
      if (payload) req.write(payload)
      req.end()
    })
  }

  private upsertAntigravityAccount(account: Record<string, unknown>): void {
    const filePath = this.config.antigravityAccountsPath
    const accounts = this.config.readAccounts(filePath)
    const email = String(account.email || "")
      .trim()
      .toLowerCase()

    const findIndex = accounts.findIndex((candidate) => {
      const rowEmail = String(candidate.email || "")
        .trim()
        .toLowerCase()
      return email.length > 0 && rowEmail === email
    })

    const nextAccounts = [...accounts]
    if (findIndex >= 0) {
      nextAccounts[findIndex] = {
        ...nextAccounts[findIndex],
        ...account,
      }
    } else {
      nextAccounts.push(account)
    }

    this.config.writeAccounts(filePath, nextAccounts)
  }

  private upsertCodexAccount(account: Record<string, unknown>): void {
    const filePath = this.config.codexAccountsPath
    const accounts = this.config.readAccounts(filePath)
    const email = String(account.email || "")
      .trim()
      .toLowerCase()
    const accountId = String(account.accountId || "").trim()
    const refreshToken = String(account.refreshToken || "").trim()
    const accessToken = String(account.accessToken || "").trim()

    const findIndex = accounts.findIndex((candidate) => {
      const row = candidate
      const rowRefreshToken = String(row.refreshToken || "").trim()
      const rowAccessToken = String(row.accessToken || "").trim()
      const rowEmail = String(row.email || "")
        .trim()
        .toLowerCase()
      const rowAccountId = String(row.accountId || "").trim()

      if (refreshToken && rowRefreshToken === refreshToken) return true
      if (accessToken && rowAccessToken === accessToken) return true
      if (email && accountId) {
        return rowEmail === email && rowAccountId === accountId
      }
      if (email) return rowEmail === email
      return false
    })

    const nextAccounts = [...accounts]
    if (findIndex >= 0) {
      nextAccounts[findIndex] = {
        ...nextAccounts[findIndex],
        ...account,
      }
    } else {
      nextAccounts.push(account)
    }

    this.config.writeAccounts(filePath, nextAccounts)
  }

  /**
   * Write the selected Codex account's tokens into ~/.codex/auth.json
   * so that the official Codex CLI picks up this identity.
   */
  private activateCodexCliAccount(accountIndex: number): void {
    const accounts = this.config.readAccounts(this.config.codexAccountsPath)
    const account = accounts[accountIndex]
    if (!account) {
      void vscode.window.showWarningMessage(
        tFmt("dash.codex.invalidIndex", { index: accountIndex })
      )
      return
    }

    const idToken = String(account.idToken || account.id_token || "")
    const accessToken = String(
      account.accessToken || account.access_token || ""
    )
    const refreshToken = String(
      account.refreshToken || account.refresh_token || ""
    )
    const accountId = String(account.accountId || account.account_id || "")
    const email = String(account.email || "")

    if (!refreshToken) {
      void vscode.window.showWarningMessage(t("dash.codex.noRefreshToken"))
      return
    }

    const codexDir = path.join(
      process.env.HOME || process.env.USERPROFILE || "~",
      ".codex"
    )
    const authFilePath = path.join(codexDir, "auth.json")

    const authPayload = {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken || null,
        access_token: accessToken || null,
        refresh_token: refreshToken,
        account_id: accountId || null,
      },
      last_refresh: new Date().toISOString(),
    }

    try {
      if (!fs.existsSync(codexDir)) {
        fs.mkdirSync(codexDir, { recursive: true, mode: 0o700 })
      }

      // Back up existing auth.json
      if (fs.existsSync(authFilePath)) {
        const backupPath = authFilePath + ".bak"
        fs.copyFileSync(authFilePath, backupPath)
      }

      fs.writeFileSync(
        authFilePath,
        JSON.stringify(authPayload, null, 2) + "\n",
        { mode: 0o600 }
      )

      const label = email || accountId || "unknown"
      logger.info(`Codex CLI activated for ${label}`)
      void vscode.window.showInformationMessage(
        tFmt("dash.codex.switched", { label })
      )
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error("Failed to write Codex CLI auth file", err)
      void vscode.window.showErrorMessage(
        tFmt("dash.codex.activateFailed", { message: errMsg })
      )
    }
  }

  private getChannelData(channel: AccountChannel): DashboardAccountChannelData {
    const filePath = this.getChannelPath(channel)
    if (!filePath) {
      return {
        accounts: [],
        filePath: "",
        exists: false,
        source: "default",
      }
    }

    return {
      accounts: this.config.readAccounts(filePath),
      filePath,
      exists: fs.existsSync(filePath),
      source: this.getChannelPathSource(channel),
    }
  }

  private getChannelPathSource(channel: AccountChannel): "custom" | "default" {
    switch (channel) {
      case "antigravity":
        return this.config.hasCustomAccountPath("antigravityAccountsPath")
          ? "custom"
          : "default"
      case "claude-api":
        return this.config.hasCustomAccountPath("claudeApiAccountsPath")
          ? "custom"
          : "default"
      case "codex":
        return this.config.hasCustomAccountPath("codexAccountsPath")
          ? "custom"
          : "default"
      case "openai-compat":
        return this.config.hasCustomAccountPath("openaiCompatAccountsPath")
          ? "custom"
          : "default"
      case "kiro":
        return this.config.hasCustomAccountPath("kiroAccountsPath")
          ? "custom"
          : "default"
    }
  }

  private getDefaultProxyUrl(): string {
    const httpProxy = vscode.workspace
      .getConfiguration("http")
      .get<string>("proxy", "")
      .trim()

    if (httpProxy) {
      return httpProxy
    }

    const envCandidates = [
      process.env.HTTPS_PROXY,
      process.env.HTTP_PROXY,
      process.env.https_proxy,
      process.env.http_proxy,
    ]

    for (const candidate of envCandidates) {
      const value = String(candidate || "").trim()
      if (value) {
        return value
      }
    }

    return ""
  }

  private async openAccountFile(channel: string): Promise<void> {
    const filePath = this.getChannelPath(channel)
    if (!filePath) return

    try {
      if (!fs.existsSync(filePath)) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(
          filePath,
          JSON.stringify({ accounts: [] }, null, 2),
          "utf-8"
        )
      }

      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(filePath)
      )
      await vscode.window.showTextDocument(document, { preview: false })
      this.sendAllData()
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("file.openAccountFailed")
      vscode.window.showErrorMessage(message)
    }
  }

  /**
   * Map channel key to file path.
   */
  private getChannelPath(channel: string): string | null {
    switch (channel) {
      case "codex":
        return this.config.codexAccountsPath
      case "openai-compat":
        return this.config.openaiCompatAccountsPath
      case "claude-api":
        return this.config.claudeApiAccountsPath
      case "antigravity":
        return this.config.antigravityAccountsPath
      case "kiro":
        return this.config.kiroAccountsPath
      default:
        return null
    }
  }

  /**
   * Load the dashboard HTML from resources/.
   */
  private getHtml(): string {
    const htmlPath = path.join(
      this.extensionUri.fsPath,
      "resources",
      "dashboard.html"
    )
    let html = fs.readFileSync(htmlPath, "utf-8")

    const locale = readDashboardLocale()
    const uiPack = getUiPack(locale)
    const localeScript = `<script>window.__AV_UI__=${JSON.stringify(uiPack)};window.__AV_LOCALE__=${JSON.stringify(locale)};</script>`
    html = html.replace("</head>", `${localeScript}</head>`)

    // Inject icon URI for branding
    const iconUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "resources", "icon.png")
    )
    html = html.replace(
      /id="overview-logo"\s+src=""/,
      `id="overview-logo" src="${iconUri}"`
    )

    // Update CSP to allow webview images
    html = html.replace(
      "default-src 'none';",
      `default-src 'none'; img-src ${this.panel.webview.cspSource};`
    )

    return html
  }

  private getVersionInfo(): DashboardVersionPayload {
    const packageJsonPath = path.join(this.extensionUri.fsPath, "package.json")

    try {
      const raw = fs.readFileSync(packageJsonPath, "utf-8")
      const parsed = JSON.parse(raw) as {
        version?: unknown
        agentVibes?: {
          cursorVersion?: unknown
        }
      }

      const extensionVersion =
        typeof parsed.version === "string" && parsed.version.trim().length > 0
          ? parsed.version.trim()
          : "unknown"
      const compatibleCursorVersion =
        typeof parsed.agentVibes?.cursorVersion === "string" &&
        parsed.agentVibes.cursorVersion.trim().length > 0
          ? parsed.agentVibes.cursorVersion.trim()
          : "unknown"
      const currentAntigravityVersion =
        detectCurrentAntigravityVersion() || "unknown"
      const currentCursorVersion =
        detectCurrentCursorVersion() || compatibleCursorVersion

      return {
        extensionVersion,
        currentAntigravityVersion,
        currentCursorVersion,
        compatibleCursorVersion,
      }
    } catch (error) {
      logger.warn(
        `Failed to read extension version metadata: ${error instanceof Error ? error.message : String(error)}`
      )
      return {
        extensionVersion: "unknown",
        currentAntigravityVersion: "unknown",
        currentCursorVersion: "unknown",
        compatibleCursorVersion: "unknown",
      }
    }
  }

  /**
   * Watch all account config files for external changes and auto-refresh the panel.
   */
  private watchAccountFiles(): void {
    for (const watcher of this.accountFileWatchers) {
      watcher.dispose()
    }
    this.accountFileWatchers = []

    const channels: AccountChannel[] = [
      "antigravity",
      "codex",
      "openai-compat",
      "claude-api",
      "kiro",
    ]
    const watchedFiles = new Set<string>()

    const queueRefresh = () => {
      if (this.accountFileDebounceTimer) {
        clearTimeout(this.accountFileDebounceTimer)
      }
      this.accountFileDebounceTimer = setTimeout(() => {
        this.accountFileDebounceTimer = null
        if (this.panel.visible) {
          this.sendAllData()
        }
      }, 300)
    }

    for (const channel of channels) {
      const filePath = this.getChannelPath(channel)
      if (!filePath) continue

      const normalizedFilePath = path.resolve(filePath)
      if (watchedFiles.has(normalizedFilePath)) continue
      watchedFiles.add(normalizedFilePath)

      try {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            path.dirname(normalizedFilePath),
            path.basename(normalizedFilePath)
          )
        )

        watcher.onDidChange(queueRefresh, null, this.disposables)
        watcher.onDidCreate(queueRefresh, null, this.disposables)
        watcher.onDidDelete(queueRefresh, null, this.disposables)

        this.accountFileWatchers.push(watcher)
      } catch (err) {
        logger.debug(
          `Failed to watch ${normalizedFilePath}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  dispose(): void {
    this.bridge.off("stateChanged", this.handleBridgeStateChanged)
    for (const watcher of this.accountFileWatchers) {
      watcher.dispose()
    }
    this.accountFileWatchers = []
    if (this.accountFileDebounceTimer) {
      clearTimeout(this.accountFileDebounceTimer)
      this.accountFileDebounceTimer = null
    }
    DashboardPanel.currentPanel = undefined
    this.panel.dispose()
    while (this.disposables.length) {
      const d = this.disposables.pop()
      if (d) d.dispose()
    }
  }
}
