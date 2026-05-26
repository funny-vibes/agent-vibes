import * as path from "path"
import * as vscode from "vscode"
import { CMD, STATE } from "../constants"
import { t, tFmt } from "../i18n/messages-i18n"
import { AccountSyncService } from "../services/account-sync"
import {
  importCodexCpaJsonDirectory,
  syncClaudeAccount,
  syncCodexAccount,
} from "../services/backend-account-sync"
import { BridgeManager } from "../services/bridge-manager"
import { CertManager } from "../services/cert-manager"
import { CertTrustService } from "../services/cert-trust"
import { ConfigManager } from "../services/config-manager"
import { CursorChecksumsService } from "../services/cursor-checksums"
import { CursorPatchManagerService } from "../services/cursor-patch-manager"
import { CursorPatchService } from "../services/cursor-patch"
import { ExtensionUpdateService } from "../services/extension-update"
import { NetworkManager } from "../services/network-manager"
import { logger } from "../utils/logger"
import { executePrivileged } from "../utils/terminal"
import { DashboardPanel } from "../views/dashboard-panel"

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

function findMatchingAntigravityAccount(
  existing: Record<string, unknown>[],
  incoming: Record<string, unknown>
): Record<string, unknown> | undefined {
  const email = pickFirstNonEmptyString(incoming.email)?.toLowerCase()
  const refreshToken = pickFirstNonEmptyString(incoming.refreshToken)
  const accessToken = pickFirstNonEmptyString(incoming.accessToken)

  return existing.find((candidate) => {
    const candidateEmail = pickFirstNonEmptyString(
      candidate.email
    )?.toLowerCase()
    const candidateRefreshToken = pickFirstNonEmptyString(
      candidate.refreshToken
    )
    const candidateAccessToken = pickFirstNonEmptyString(candidate.accessToken)
    return (
      (email && candidateEmail === email) ||
      (refreshToken && candidateRefreshToken === refreshToken) ||
      (accessToken && candidateAccessToken === accessToken)
    )
  })
}

function mergeAntigravityAccountWithExisting(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | undefined
): Record<string, unknown> {
  return {
    ...existing,
    ...incoming,
    ...(pickFirstNonEmptyString(incoming.projectId, existing?.projectId)
      ? {
          projectId: pickFirstNonEmptyString(
            incoming.projectId,
            existing?.projectId
          ),
        }
      : {}),
    ...(pickFirstNonEmptyString(
      incoming.cloudCodeUrlOverride,
      existing?.cloudCodeUrlOverride
    )
      ? {
          cloudCodeUrlOverride: pickFirstNonEmptyString(
            incoming.cloudCodeUrlOverride,
            existing?.cloudCodeUrlOverride
          ),
        }
      : {}),
    ...(pickFirstNonEmptyString(incoming.proxyUrl, existing?.proxyUrl)
      ? {
          proxyUrl: pickFirstNonEmptyString(
            incoming.proxyUrl,
            existing?.proxyUrl
          ),
        }
      : {}),
  }
}

const CURSOR_AGENT_SUBMIT_STRATEGIES = [
  "ccursor.debugNativeAgentSubmit",
  "glass.newAgentWithQuery",
  "composer.startComposerPrompt2",
  "composer.startComposerPrompt",
  "workbench.action.chat.open",
] as const
const DEFAULT_CURSOR_AGENT_AUTO_SUBMIT_DELAY_MS = 3000

type CursorAgentSubmitStrategy = (typeof CURSOR_AGENT_SUBMIT_STRATEGIES)[number]

function isCursorAgentSubmitStrategy(
  value: string | undefined
): value is CursorAgentSubmitStrategy {
  return CURSOR_AGENT_SUBMIT_STRATEGIES.includes(
    value as CursorAgentSubmitStrategy
  )
}

function normalizeCursorAgentSubmitStrategy(
  value: string | undefined
): CursorAgentSubmitStrategy {
  return isCursorAgentSubmitStrategy(value)
    ? value
    : "workbench.action.chat.open"
}

async function executeCursorAgentCommand(
  command: CursorAgentSubmitStrategy,
  prompt: string,
  autoSubmitDelayMs?: number
): Promise<unknown> {
  const submitDelayMs =
    autoSubmitDelayMs ?? DEFAULT_CURSOR_AGENT_AUTO_SUBMIT_DELAY_MS

  switch (command) {
    case "ccursor.debugNativeAgentSubmit":
      return vscode.commands.executeCommand(command, {
        query: prompt,
        mode: "agent",
      })
    case "glass.newAgentWithQuery":
      return vscode.commands.executeCommand(command, prompt)
    case "composer.startComposerPrompt2":
    case "composer.startComposerPrompt":
      return vscode.commands.executeCommand(command, prompt)
    case "workbench.action.chat.open":
      return vscode.commands.executeCommand(command, {
        query: prompt,
        ccursorAutoSubmit: true,
        ccursorAutoSubmitMode: "agent",
        ccursorAutoSubmitDelayMs: submitDelayMs,
      })
  }
}

export async function submitCursorAgentPrompt(
  input: string,
  strategy?: string,
  autoSubmitDelayMs?: number
): Promise<unknown> {
  const prompt = input.trim()
  if (prompt.length === 0) return
  const command = normalizeCursorAgentSubmitStrategy(strategy)

  logger.info(
    `Debug submitting prompt through Cursor Agent via ${command}` +
      ` (delay=${autoSubmitDelayMs ?? DEFAULT_CURSOR_AGENT_AUTO_SUBMIT_DELAY_MS}ms)`
  )

  return executeCursorAgentCommand(command, prompt, autoSubmitDelayMs)
}

async function openJsonFile(filePath: string): Promise<void> {
  const fs = await import("fs")
  const dirPath = path.dirname(filePath)

  fs.mkdirSync(dirPath, { recursive: true })
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify({ accounts: [] }, null, 2) + "\n")
  }

  const document = await vscode.workspace.openTextDocument(filePath)
  await vscode.window.showTextDocument(document)
}

/**
 * Register all extension commands.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  bridge: BridgeManager,
  config: ConfigManager,
  cert: CertManager,
  network: NetworkManager,
  updater: ExtensionUpdateService
): void {
  const cursorChecksums = new CursorChecksumsService()
  const cursorPatchManager = new CursorPatchManagerService()
  const cursorPatch = new CursorPatchService(logger)

  const promptReloadAfterForwardingEnabled = async (): Promise<void> => {
    if (context.globalState.get<boolean>(STATE.FORWARDING_RELOAD_PROMPTED)) {
      return
    }

    const becameActive = await network.waitForForwardingActive()
    if (!becameActive) return

    await context.globalState.update(STATE.FORWARDING_RELOAD_PROMPTED, true)

    const action = await vscode.window.showInformationMessage(
      t("forwarding.enabledRestart"),
      t("forwarding.action.quit"),
      t("setup.action.later")
    )

    if (action === t("forwarding.action.quit")) {
      await vscode.commands.executeCommand("workbench.action.quit")
    }
  }

  // ── Server lifecycle ──────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.START_SERVER, async () => {
      await bridge.start()

      // Auto-enable TCP relay forwarding once Bridge is healthy
      if (bridge.state === "running") {
        if (network.isForwardingActive()) {
          logger.info("Forwarding already active from previous session")
          vscode.window.showInformationMessage(
            t("forwarding.bridgeStartedAlready")
          )
          return
        }
        // Execute forwarding in terminal (requires sudo)
        executePrivileged(
          network.getEnableCommand(),
          t("terminal.enableForwarding")
        )
        void promptReloadAfterForwardingEnabled()
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.STOP_SERVER, async () => {
      // Disable forwarding before stopping Bridge
      if (network.isForwardingActive()) {
        executePrivileged(
          network.getDisableCommand(),
          t("terminal.disableForwarding")
        )
      }
      await bridge.stop()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.RESTART_SERVER, async () => {
      await bridge.restart()
    })
  )

  // ── Cursor patch helpers ─────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.APPLY_CURSOR_CHECKSUMS, async () => {
      const patchResult = cursorPatch.applyPatches()
      if (!patchResult.success) {
        const detail =
          patchResult.errors.join("; ") || t("checksums.unknownError")
        void vscode.window.showErrorMessage(
          tFmt("patches.applyFailed", { detail })
        )
        return
      }

      const result = cursorChecksums.apply()
      if (!result.success) {
        const detail = result.errors.join("; ") || t("checksums.unknownError")
        void vscode.window.showErrorMessage(
          tFmt("checksums.failed", { detail })
        )
        return
      }

      const message =
        result.updated > 0
          ? tFmt("checksums.updated", { count: result.updated })
          : t("checksums.alreadyMatched")
      const action = await vscode.window.showInformationMessage(
        message,
        t("forwarding.action.quit"),
        t("setup.action.later")
      )
      if (action === t("forwarding.action.quit")) {
        await vscode.commands.executeCommand("workbench.action.quit")
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.RESET_CURSOR_PATCHES, async () => {
      const result = cursorPatchManager.resetAllPatches()
      if (!result.success) {
        const detail = result.errors.join("; ") || t("checksums.unknownError")
        void vscode.window.showErrorMessage(
          tFmt("patches.resetFailed", { detail })
        )
        return
      }

      const action = await vscode.window.showInformationMessage(
        tFmt("patches.resetSummary", { count: result.restored }),
        t("forwarding.action.quit"),
        t("setup.action.later")
      )
      if (action === t("forwarding.action.quit")) {
        await vscode.commands.executeCommand("workbench.action.quit")
      }
    })
  )

  // ── Credential sync ───────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.SYNC_ANTIGRAVITY_IDE, async () => {
      const sync = new AccountSyncService(logger)
      try {
        if (!bridge.isRunning) {
          await bridge.start()
        }

        const result = await sync.syncToBridge(config)
        void vscode.window.showInformationMessage(
          tFmt("sync.antigravityIde.success", { email: result.email })
        )
      } catch (err) {
        logger.error("Failed to sync Antigravity IDE credentials", err)
        vscode.window.showErrorMessage(
          tFmt("sync.antigravityIde.failed", {
            message: err instanceof Error ? err.message : String(err),
          })
        )
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.SYNC_ANTIGRAVITY_TOOLS, async () => {
      try {
        const fs = await import("fs")
        const path = await import("path")
        const os = await import("os")

        const toolsDir = path.join(os.homedir(), ".antigravity_tools")
        const indexPath = path.join(toolsDir, "accounts.json")
        const accountsDir = path.join(toolsDir, "accounts")

        if (!fs.existsSync(indexPath)) {
          vscode.window.showErrorMessage(t("sync.antigravityTools.notFound"))
          return
        }

        const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as {
          accounts?: Array<{ id?: string }>
        }
        if (!Array.isArray(index.accounts) || index.accounts.length === 0) {
          vscode.window.showWarningMessage(t("sync.antigravityTools.empty"))
          return
        }

        const loaded: Record<string, unknown>[] = []

        for (const entry of index.accounts) {
          const accountPath = path.join(accountsDir, `${entry.id}.json`)
          if (!fs.existsSync(accountPath)) continue

          try {
            const file = JSON.parse(fs.readFileSync(accountPath, "utf-8")) as {
              email?: string
              token?: {
                access_token?: string
                refresh_token?: string
                expiry_timestamp?: number
                project_id?: string
              }
            }
            const token = file.token
            if (!token?.access_token || !token?.refresh_token) continue

            loaded.push({
              email: file.email,
              accessToken: token.access_token,
              refreshToken: token.refresh_token,
              expiresAt: token.expiry_timestamp
                ? new Date(token.expiry_timestamp * 1000).toISOString()
                : undefined,
              quotaProjectId: token.project_id,
            })
          } catch {
            // skip malformed account file
          }
        }

        if (loaded.length === 0) {
          vscode.window.showWarningMessage(t("sync.antigravityTools.invalid"))
          return
        }

        // Write to the configured local data directory.
        // Upsert imported accounts while preserving unmatched existing ones
        const destPath = config.antigravityAccountsPath
        const existing = config.readAccounts(destPath)
        const matchedIndices = new Set<number>()
        const merged = loaded.map((account) => {
          const matchIdx = existing.findIndex(
            (e) => e === findMatchingAntigravityAccount(existing, account)
          )
          if (matchIdx >= 0) matchedIndices.add(matchIdx)
          return mergeAntigravityAccountWithExisting(
            account,
            matchIdx >= 0 ? existing[matchIdx] : undefined
          )
        })
        // Append existing accounts that were not matched by any import
        for (let i = 0; i < existing.length; i++) {
          if (!matchedIndices.has(i)) {
            const unmatched = existing[i]
            if (unmatched) {
              merged.push(unmatched)
            }
          }
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.writeFileSync(
          destPath,
          JSON.stringify({ accounts: merged }, null, 2)
        )

        logger.info(`Synced ${loaded.length} account(s) from Antigravity Tools`)
        vscode.window.showInformationMessage(
          tFmt("sync.antigravityTools.success", { count: loaded.length })
        )
      } catch (err) {
        logger.error("Failed to sync Antigravity Tools", err)
        vscode.window.showErrorMessage(
          tFmt("sync.antigravityTools.failed", {
            message: err instanceof Error ? err.message : String(err),
          })
        )
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.SYNC_CLAUDE, () => {
      try {
        const result = syncClaudeAccount(config)
        logger.info(result.summary)
        vscode.window.showInformationMessage(
          tFmt("sync.summaryWithDest", {
            summary: result.summary,
            dest: path.basename(result.destinationPath),
          })
        )
      } catch (err) {
        logger.error("Failed to sync Claude credentials", err)
        vscode.window.showErrorMessage(
          tFmt("sync.claude.failed", {
            message: err instanceof Error ? err.message : String(err),
          })
        )
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.SYNC_CODEX, () => {
      try {
        const result = syncCodexAccount(config)
        logger.info(result.summary)
        vscode.window.showInformationMessage(
          tFmt("sync.summaryWithDest", {
            summary: result.summary,
            dest: path.basename(result.destinationPath),
          })
        )
      } catch (err) {
        logger.error("Failed to sync Codex credentials", err)
        vscode.window.showErrorMessage(
          tFmt("sync.codex.failed", {
            message: err instanceof Error ? err.message : String(err),
          })
        )
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.IMPORT_CODEX_CPA_JSONS, async () => {
      try {
        const fs = await import("fs")

        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: t("sync.cpa.openLabel"),
          filters: {
            JSON: ["json"],
          },
        })

        const selectedPath = selected?.[0]?.fsPath?.trim()
        if (!selectedPath) {
          return
        }

        const sourceStat = fs.statSync(selectedPath)
        const sourceDir = sourceStat.isDirectory()
          ? selectedPath
          : path.dirname(selectedPath)

        const result = importCodexCpaJsonDirectory(config, sourceDir)
        logger.info(result.summary)
        vscode.window.showInformationMessage(
          tFmt("sync.summaryWithDest", {
            summary: result.summary,
            dest: path.basename(result.destinationPath),
          })
        )
      } catch (err) {
        logger.error("Failed to import Codex CPA JSON directory", err)
        vscode.window.showErrorMessage(
          tFmt("sync.cpa.failed", {
            message: err instanceof Error ? err.message : String(err),
          })
        )
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(
      CMD.OPEN_OPENAI_COMPAT_ACCOUNTS,
      async () => {
        try {
          await openJsonFile(config.openaiCompatAccountsPath)
        } catch (err) {
          logger.error("Failed to open OpenAI-compatible accounts file", err)
          vscode.window.showErrorMessage(
            tFmt("file.openOpenAICompatFailed", {
              message: err instanceof Error ? err.message : String(err),
            })
          )
        }
      }
    )
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.OPEN_CLAUDE_API_ACCOUNTS, async () => {
      try {
        await openJsonFile(config.claudeApiAccountsPath)
      } catch (err) {
        logger.error("Failed to open Claude API accounts file", err)
        vscode.window.showErrorMessage(
          tFmt("file.openClaudeApiFailed", {
            message: err instanceof Error ? err.message : String(err),
          })
        )
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.OPEN_KIRO_ACCOUNTS, async () => {
      try {
        await openJsonFile(config.kiroAccountsPath)
      } catch (err) {
        logger.error("Failed to open Kiro accounts file", err)
        vscode.window.showErrorMessage(
          tFmt("file.openKiroFailed", {
            message: err instanceof Error ? err.message : String(err),
          })
        )
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.SYNC_KIRO_IDE, async () => {
      try {
        if (!bridge.isRunning) {
          await bridge.start()
        }
        const https = await import("https")
        const fs = await import("fs")
        const caPath = config.caCertPath
        const caData = fs.existsSync(caPath)
          ? fs.readFileSync(caPath)
          : undefined

        const body = await new Promise<string>((resolve, reject) => {
          const options: import("https").RequestOptions = {
            hostname: "localhost",
            port: config.port,
            path: "/api/kiro/sync-local",
            method: "POST",
            ca: caData,
            rejectUnauthorized: !!caData,
            timeout: 15000,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": "2",
            },
          }
          const req = https.request(options, (res) => {
            let responseBody = ""
            res.on("data", (chunk: Buffer) => {
              responseBody += chunk.toString()
            })
            res.on("end", () => {
              if ((res.statusCode ?? 500) >= 400) {
                reject(
                  new Error(
                    `Kiro sync failed (${res.statusCode}): ${responseBody.slice(0, 200)}`
                  )
                )
                return
              }
              resolve(responseBody)
            })
          })
          req.on("error", reject)
          req.setTimeout(15000, () => {
            req.destroy(new Error("Kiro sync request timed out"))
          })
          req.write("{}")
          req.end()
        })

        const result = JSON.parse(body) as {
          synced?: boolean
          imported?: number
          accountCount?: number
          error?: string
        }
        if (result.error) {
          vscode.window.showErrorMessage(`Kiro sync: ${result.error}`)
        } else if (result.synced && result.imported) {
          vscode.window.showInformationMessage(
            `Kiro: synced ${result.imported} account(s) from local cache (${result.accountCount} total)`
          )
        } else {
          vscode.window.showWarningMessage(
            "Kiro: no local credentials found. Configure a token manually or sync from an existing local Kiro cache."
          )
        }
      } catch (err) {
        logger.error("Failed to sync Kiro IDE credentials", err)
        vscode.window.showErrorMessage(
          tFmt("file.openKiroFailed", {
            message: err instanceof Error ? err.message : String(err),
          })
        )
      }
    })
  )

  // ── SSL certificates ──────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.GENERATE_CERT, async () => {
      try {
        // Step 1: Generate certificates (pure JS, no sudo)
        cert.generateCertificates()
        logger.info("SSL certificates generated")

        // Step 2: Check if trust is FULLY configured (both system + Node.js)
        const nodeCaOk = CertTrustService.isNodeCaConfigured(config.caCertPath)
        const systemTrustOk = CertTrustService.isCaTrustedMacOS(
          config.caCertPath
        )

        if (nodeCaOk && systemTrustOk) {
          vscode.window.showInformationMessage(t("cert.alreadyTrusted"))
          return
        }

        // Step 3: Offer one-click trust setup
        const action = await vscode.window.showInformationMessage(
          t("cert.generated.prompt"),
          t("cert.action.trust"),
          t("cert.action.skip")
        )

        if (action === t("cert.action.trust")) {
          const scriptPath = CertTrustService.generateTrustScript(
            config.caCertPath
          )
          if (process.platform === "win32") {
            // Windows: Run PowerShell script elevated
            executePrivileged(
              `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
              t("terminal.trustCa")
            )
          } else {
            executePrivileged(scriptPath, t("terminal.trustCa"))
          }
        }
      } catch (err) {
        logger.error("Failed to generate certificates", err)
        vscode.window.showErrorMessage(
          tFmt("cert.failed", {
            message: err instanceof Error ? err.message : String(err),
          })
        )
      }
    })
  )

  // ── TCP relay forwarding ─────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.ENABLE_FORWARDING, () => {
      if (network.isForwardingActive()) {
        vscode.window.showInformationMessage(t("forwarding.alreadyActive"))
        return
      }

      executePrivileged(
        network.getEnableCommand(),
        t("terminal.enableForwarding")
      )
      void promptReloadAfterForwardingEnabled()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.DISABLE_FORWARDING, () => {
      executePrivileged(
        network.getDisableCommand(),
        t("terminal.disableForwarding")
      )
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.FORWARDING_STATUS, () => {
      const forwarding = network.getForwardingStatus()
      const loopbackSummary =
        forwarding.hasLoopbackAlias === null
          ? ""
          : tFmt("forwarding.loopbackSuffix", {
              flag: forwarding.hasLoopbackAlias ? "✓" : "✗",
            })
      vscode.window.showInformationMessage(
        tFmt("forwarding.statusLine", {
          state: forwarding.active
            ? t("forwarding.state.active")
            : t("forwarding.state.inactive"),
          hosts: forwarding.hasHosts ? "✓" : "✗",
          loopback: loopbackSummary,
          backendLabel: forwarding.backendLabel,
          backend: forwarding.backendConfigured ? "✓" : "✗",
        })
      )
    })
  )

  // ── Utility commands ──────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.OPEN_DASHBOARD, () => {
      DashboardPanel.createOrShow(context.extensionUri, config, bridge, network)
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.CHECK_UPDATES, async () => {
      try {
        await updater.checkForUpdates({ userInitiated: true })
      } catch (err) {
        logger.error("Failed to check for extension updates", err)
        vscode.window.showErrorMessage(
          tFmt("update.checkFailed", {
            message: err instanceof Error ? err.message : String(err),
          })
        )
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.OPEN_CONFIG, () => {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "agentVibes"
      )
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(
      CMD.DEBUG_SUBMIT_CURSOR_AGENT,
      async (prompt?: unknown) => {
        const input =
          typeof prompt === "string" && prompt.trim().length > 0
            ? prompt
            : await vscode.window.showInputBox({
                prompt: "Prompt to submit through Cursor Agent",
                placeHolder: "Say OK from gpt-5.5",
              })

        if (!input || input.trim().length === 0) return

        await submitCursorAgentPrompt(input)
      }
    )
  )
}
