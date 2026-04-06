import * as vscode from "vscode"
import { logger } from "./utils/logger"
import { ConfigManager } from "./services/config-manager"
import { BridgeManager } from "./services/bridge-manager"
import { NetworkManager } from "./services/network-manager"
import { CertManager } from "./services/cert-manager"
import { StatusIndicator } from "./views/status-indicator"
import { registerCommands } from "./commands"
import { executePrivileged } from "./utils/terminal"
import { CMD } from "./constants"

// Singleton references for cleanup
let bridge: BridgeManager | null = null
let network: NetworkManager | null = null
let statusIndicator: StatusIndicator | null = null

/**
 * Extension entry point — called on startup (onStartupFinished).
 */
export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  // Initialize logger
  logger.initialize()
  logger.info("Agent Vibes extension activating...")

  // Create core services
  const config = new ConfigManager()
  bridge = new BridgeManager(config, context.extensionPath)
  network = new NetworkManager()
  network.setExtensionPath(context.extensionPath)
  const cert = new CertManager(config)

  // Create UI
  statusIndicator = new StatusIndicator()

  // Update status bar when server state changes
  bridge.on("stateChanged", (state) => {
    statusIndicator?.update(state)
  })

  // Register all commands
  registerCommands(context, bridge, config, cert, network)

  // Push disposables
  context.subscriptions.push({
    dispose: () => {
      statusIndicator?.dispose()
      bridge?.dispose()
      network?.dispose()
      logger.dispose()
    },
  })

  // ── First-run onboarding ──────────────────────────────────────────
  const needsCerts = !config.hasCertificates()
  const hasAnyAccounts =
    config.getAccountCount(config.antigravityAccountsPath) > 0 ||
    config.getAccountCount(config.claudeApiAccountsPath) > 0 ||
    config.getAccountCount(config.codexAccountsPath) > 0 ||
    config.getAccountCount(config.openaiCompatAccountsPath) > 0

  if (needsCerts || !hasAnyAccounts) {
    const missing: string[] = []
    if (needsCerts) missing.push("SSL certificates")
    if (!hasAnyAccounts) missing.push("backend accounts")

    const action = await vscode.window.showInformationMessage(
      `Agent Vibes needs setup: ${missing.join(" and ")} not configured.`,
      "Setup Now",
      "Later"
    )

    if (action === "Setup Now") {
      if (needsCerts) {
        await vscode.commands.executeCommand(CMD.GENERATE_CERT)
      }
      if (!hasAnyAccounts) {
        await vscode.commands.executeCommand(CMD.OPEN_CONFIG)
        vscode.window.showInformationMessage(
          "Add your backend account files to the configured Agent Vibes account paths " +
            "(for example, antigravity-accounts.json or codex-accounts.json)."
        )
      }
    }
  }

  // Auto-start if configured
  if (config.autoStart) {
    logger.info("Auto-start enabled, starting server...")
    bridge
      .start()
      .then(async () => {
        if (bridge!.state === "running") {
          logger.info("Bridge auto-started successfully")
          // Check if forwarding is already active (from previous session)
          if (network!.isForwardingActive()) {
            logger.info("Forwarding already active from previous session")
          } else {
            // Prompt user to enable forwarding via sudo terminal
            const action = await vscode.window.showInformationMessage(
              "Bridge is running! Enable network forwarding? (requires sudo)",
              "Enable",
              "Later"
            )
            if (action === "Enable") {
              executePrivileged(
                network!.getEnableCommand(),
                "Agent Vibes — Enable Forwarding"
              )
            }
          }
        }
      })
      .catch((err) => {
        logger.warn(
          `Auto-start failed: ${err instanceof Error ? err.message : String(err)}`
        )
      })
  }

  logger.info("Agent Vibes extension activated")
}

/**
 * Extension deactivation — clean up all resources.
 */
export function deactivate(): void {
  bridge?.dispose()
  network?.dispose()
  statusIndicator?.dispose()
  logger.info("Agent Vibes extension deactivated")
  logger.dispose()
}
