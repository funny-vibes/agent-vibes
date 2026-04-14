import * as path from "path"
import * as vscode from "vscode"
import { CMD } from "../constants"
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
  const FORWARDING_RELOAD_PROMPTED_KEY = "agentVibes.forwardingReloadPrompted"

  const promptReloadAfterForwardingEnabled = async (): Promise<void> => {
    if (context.globalState.get<boolean>(FORWARDING_RELOAD_PROMPTED_KEY)) {
      return
    }

    const becameActive = await network.waitForForwardingActive()
    if (!becameActive) return

    await context.globalState.update(FORWARDING_RELOAD_PROMPTED_KEY, true)

    const action = await vscode.window.showInformationMessage(
      "Forwarding is enabled. Fully restart Cursor to apply DNS/hosts changes.",
      "Quit Cursor Now",
      "Later"
    )

    if (action === "Quit Cursor Now") {
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
            "Bridge started! Forwarding already active."
          )
          return
        }
        // Execute forwarding in terminal (requires sudo)
        executePrivileged(
          network.getEnableCommand(),
          "Agent Vibes — Enable Forwarding"
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
          "Agent Vibes — Disable Forwarding"
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
          `Synced Antigravity IDE credentials for ${result.email}`
        )
      } catch (err) {
        logger.error("Failed to sync Antigravity IDE credentials", err)
        vscode.window.showErrorMessage(
          `Credential sync failed: ${err instanceof Error ? err.message : String(err)}`
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
          vscode.window.showErrorMessage(
            `Antigravity Tools not found (~/.antigravity_tools/accounts.json missing)`
          )
          return
        }

        const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as {
          accounts?: Array<{ id?: string }>
        }
        if (!Array.isArray(index.accounts) || index.accounts.length === 0) {
          vscode.window.showWarningMessage("No accounts in Antigravity Tools")
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
          vscode.window.showWarningMessage(
            "No valid accounts found in Antigravity Tools"
          )
          return
        }

        // Write to ~/.agent-vibes/data/antigravity-accounts.json
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
          `Synced ${loaded.length} account(s) from Antigravity Tools`
        )
      } catch (err) {
        logger.error("Failed to sync Antigravity Tools", err)
        vscode.window.showErrorMessage(
          `Sync failed: ${err instanceof Error ? err.message : String(err)}`
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
          `${result.summary} → ${path.basename(result.destinationPath)}`
        )
      } catch (err) {
        logger.error("Failed to sync Claude credentials", err)
        vscode.window.showErrorMessage(
          `Claude sync failed: ${err instanceof Error ? err.message : String(err)}`
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
          `${result.summary} → ${path.basename(result.destinationPath)}`
        )
      } catch (err) {
        logger.error("Failed to sync Codex credentials", err)
        vscode.window.showErrorMessage(
          `Codex sync failed: ${err instanceof Error ? err.message : String(err)}`
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
          openLabel: "Import CPA JSONs",
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
          `${result.summary} → ${path.basename(result.destinationPath)}`
        )
      } catch (err) {
        logger.error("Failed to import Codex CPA JSON directory", err)
        vscode.window.showErrorMessage(
          `Codex CPA import failed: ${err instanceof Error ? err.message : String(err)}`
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
            `Open OpenAI-compatible accounts file failed: ${err instanceof Error ? err.message : String(err)}`
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
          `Open Claude API accounts file failed: ${err instanceof Error ? err.message : String(err)}`
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
          vscode.window.showInformationMessage(
            "SSL certificates regenerated. CA is already trusted (system + Node.js)."
          )
          return
        }

        // Step 3: Offer one-click trust setup
        const action = await vscode.window.showInformationMessage(
          "SSL certificates generated. Trust the CA now? " +
            "(Requires password — configures system trust + Cursor environment)",
          "Trust CA Now",
          "Skip"
        )

        if (action === "Trust CA Now") {
          const scriptPath = CertTrustService.generateTrustScript(
            config.caCertPath
          )
          if (process.platform === "win32") {
            // Windows: Run PowerShell script elevated
            executePrivileged(
              `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
              "Agent Vibes — Trust CA"
            )
          } else {
            executePrivileged(scriptPath, "Agent Vibes — Trust CA")
          }
        }
      } catch (err) {
        logger.error("Failed to generate certificates", err)
        vscode.window.showErrorMessage(
          `Failed to generate SSL certificates: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    })
  )

  // ── TCP relay forwarding ─────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.ENABLE_FORWARDING, () => {
      if (network.isForwardingActive()) {
        vscode.window.showInformationMessage("Forwarding is already active.")
        return
      }

      executePrivileged(
        network.getEnableCommand(),
        "Agent Vibes — Enable Forwarding"
      )
      void promptReloadAfterForwardingEnabled()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.DISABLE_FORWARDING, () => {
      executePrivileged(
        network.getDisableCommand(),
        "Agent Vibes — Disable Forwarding"
      )
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.FORWARDING_STATUS, () => {
      const forwarding = network.getForwardingStatus()
      const loopbackSummary =
        forwarding.hasLoopbackAlias === null
          ? ""
          : ` | Loopback: ${forwarding.hasLoopbackAlias ? "✓" : "✗"}`
      vscode.window.showInformationMessage(
        `Forwarding: ${forwarding.active ? "✅ Active" : "❌ Inactive"} | Hosts: ${forwarding.hasHosts ? "✓" : "✗"}${loopbackSummary} | ${forwarding.backendLabel}: ${forwarding.backendConfigured ? "✓" : "✗"}`
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
          `Update check failed: ${err instanceof Error ? err.message : String(err)}`
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
}
