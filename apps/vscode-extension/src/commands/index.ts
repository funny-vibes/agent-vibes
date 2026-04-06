import * as vscode from "vscode"
import { BridgeManager } from "../services/bridge-manager"
import { ConfigManager } from "../services/config-manager"
import { CertManager } from "../services/cert-manager"
import { NetworkManager } from "../services/network-manager"
import { AccountSyncService } from "../services/account-sync"
import { CursorPatchService } from "../services/cursor-patch"
import { CertTrustService } from "../services/cert-trust"
import {
  syncClaudeAccount,
  syncCodexAccount,
} from "../services/backend-account-sync"
import { DashboardPanel } from "../views/dashboard-panel"
import { executePrivileged } from "../utils/terminal"
import { logger } from "../utils/logger"
import { CMD } from "../constants"
import * as path from "path"

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

/**
 * Register all extension commands.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  bridge: BridgeManager,
  config: ConfigManager,
  cert: CertManager,
  network: NetworkManager
): void {
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

        const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"))
        if (!Array.isArray(index.accounts) || index.accounts.length === 0) {
          vscode.window.showWarningMessage("No accounts in Antigravity Tools")
          return
        }

        const loaded: Record<string, unknown>[] = []

        for (const entry of index.accounts) {
          const accountPath = path.join(accountsDir, `${entry.id}.json`)
          if (!fs.existsSync(accountPath)) continue

          try {
            const file = JSON.parse(fs.readFileSync(accountPath, "utf-8"))
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
    vscode.commands.registerCommand(CMD.SYNC_CLAUDE, async () => {
      try {
        const result = await syncClaudeAccount(config)
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
    vscode.commands.registerCommand(CMD.SYNC_CODEX, async () => {
      try {
        const result = await syncCodexAccount(config)
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

  // ── SSL certificates ──────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.GENERATE_CERT, async () => {
      try {
        // Step 1: Generate certificates (pure JS, no sudo)
        await cert.generateCertificates()
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
    vscode.commands.registerCommand(CMD.ENABLE_FORWARDING, async () => {
      executePrivileged(
        network.getEnableCommand(),
        "Agent Vibes — Enable Forwarding"
      )
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.DISABLE_FORWARDING, async () => {
      executePrivileged(
        network.getDisableCommand(),
        "Agent Vibes — Disable Forwarding"
      )
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.FORWARDING_STATUS, () => {
      const active = network.isForwardingActive()
      const hosts = network.hasHostEntries()
      const relay = network.isRelayRunning()
      vscode.window.showInformationMessage(
        `Forwarding: ${active ? "✅ Active" : "❌ Inactive"} | Hosts: ${hosts ? "✓" : "✗"} | Relay: ${relay ? "✓" : "✗"}`
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
    vscode.commands.registerCommand(CMD.COLLECT_DIAGNOSTICS, async () => {
      vscode.window.showInformationMessage(
        "Diagnostics collection — coming soon"
      )
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
    vscode.commands.registerCommand(CMD.PATCH_CURSOR, async () => {
      const patcher = new CursorPatchService(logger)
      const status = patcher.getStatus()

      if (!status.fileExists) {
        vscode.window.showErrorMessage(
          "Cursor workbench file not found. Is Cursor installed?"
        )
        return
      }

      if (status.allApplied) {
        vscode.window.showInformationMessage(
          "All transport patches are already applied."
        )
        return
      }

      const confirm = await vscode.window.showWarningMessage(
        "This will patch Cursor's workbench to enable traffic capture. " +
          "A backup will be created automatically.",
        "Apply Patches",
        "Cancel"
      )

      if (confirm !== "Apply Patches") return

      const result = patcher.applyPatches()
      if (result.success) {
        vscode.window.showInformationMessage(
          `Applied ${result.applied} transport patch(es). Restart Cursor to activate.`
        )
      } else {
        vscode.window.showErrorMessage(
          `Patching issues: ${result.errors.join("; ")}`
        )
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.RESTORE_CURSOR, async () => {
      const patcher = new CursorPatchService(logger)
      const status = patcher.getStatus()

      if (!status.backupExists) {
        vscode.window.showWarningMessage("No backup found. Nothing to restore.")
        return
      }

      const confirm = await vscode.window.showWarningMessage(
        "This will restore Cursor's original workbench file from backup.",
        "Restore",
        "Cancel"
      )

      if (confirm !== "Restore") return

      const restored = patcher.restore()
      if (restored) {
        vscode.window.showInformationMessage(
          "Cursor workbench restored. Restart Cursor to apply."
        )
      } else {
        vscode.window.showErrorMessage("Failed to restore — check output logs.")
      }
    })
  )
}
