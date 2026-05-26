import * as vscode from "vscode"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { registerCommands, submitCursorAgentPrompt } from "./commands"
import { CMD, STATE, type ServerState } from "./constants"
import { t, tFmt } from "./i18n/messages-i18n"
import { BridgeManager } from "./services/bridge-manager"
import { CertManager } from "./services/cert-manager"
import { ConfigManager } from "./services/config-manager"
import { ExtensionUpdateService } from "./services/extension-update"
import { NetworkManager } from "./services/network-manager"
import { CursorChecksumsService } from "./services/cursor-checksums"
import { CursorPatchService } from "./services/cursor-patch"
import { logger } from "./utils/logger"
import { executePrivileged } from "./utils/terminal"
import { StatusIndicator } from "./views/status-indicator"

// Singleton references for cleanup
let bridge: BridgeManager | null = null
let network: NetworkManager | null = null
let statusIndicator: StatusIndicator | null = null

type DebugSubmitMarker = {
  action?: "submit" | "listCommands" | "applyPatches"
  autoSubmitDelayMs?: number
  command?: string
  outputPath?: string
  workspace?: string
  prompt?: string
}

const DEBUG_SUBMIT_MARKER_PATH = path.join(
  os.tmpdir(),
  "ccursor-debug-submit-agent.json"
)
const DEBUG_COMMANDS_OUTPUT_PATH = path.join(
  os.tmpdir(),
  "ccursor-debug-commands.json"
)

function parseDebugSubmitMarker(raw: string): DebugSubmitMarker {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object") {
    return {}
  }
  return parsed as DebugSubmitMarker
}

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value)) as unknown
}

function getWorkspaceFolderPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

function markerMatchesWorkspace(marker: DebugSubmitMarker): boolean {
  if (!marker.workspace) return true

  const workspace = getWorkspaceFolderPath()
  if (!workspace) return false

  return path.resolve(marker.workspace) === path.resolve(workspace)
}

async function tryRunDebugSubmitMarker(): Promise<void> {
  if (!fs.existsSync(DEBUG_SUBMIT_MARKER_PATH)) return

  let marker: DebugSubmitMarker
  try {
    marker = parseDebugSubmitMarker(
      fs.readFileSync(DEBUG_SUBMIT_MARKER_PATH, "utf8")
    )
  } catch (error) {
    logger.error("Failed to parse Cursor Agent debug marker", error)
    return
  }

  if (!markerMatchesWorkspace(marker)) {
    logger.info("Cursor Agent debug marker ignored for non-matching workspace")
    return
  }

  try {
    fs.unlinkSync(DEBUG_SUBMIT_MARKER_PATH)
  } catch (error) {
    logger.warn(
      `Failed to remove Cursor Agent debug marker: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (marker.action === "listCommands") {
    const commands = await vscode.commands.getCommands(true)
    const interesting = commands
      .filter((command) => /chat|composer|agent/i.test(command))
      .sort()
    const outputPath = marker.outputPath || DEBUG_COMMANDS_OUTPUT_PATH
    fs.writeFileSync(
      outputPath,
      JSON.stringify(
        {
          workspace: getWorkspaceFolderPath(),
          total: commands.length,
          commands: interesting,
        },
        null,
        2
      )
    )
    logger.info(`Wrote Cursor command list to ${outputPath}`)
    return
  }

  if (marker.action === "applyPatches") {
    const cursorPatch = new CursorPatchService(logger)
    const cursorChecksums = new CursorChecksumsService()
    const patchResult = cursorPatch.applyPatches()
    const checksumResult = patchResult.success
      ? cursorChecksums.apply()
      : { success: false, updated: 0, errors: [] }
    const outputPath = marker.outputPath || DEBUG_COMMANDS_OUTPUT_PATH
    fs.writeFileSync(
      outputPath,
      JSON.stringify(
        {
          workspace: getWorkspaceFolderPath(),
          patchResult,
          checksumResult,
        },
        null,
        2
      )
    )
    logger.info(`Applied Cursor patches via debug marker: ${outputPath}`)
    return
  }

  const prompt = typeof marker.prompt === "string" ? marker.prompt.trim() : ""
  if (prompt.length === 0) {
    logger.warn("Cursor Agent debug marker has no prompt")
    return
  }

  const autoSubmitDelayMs =
    typeof marker.autoSubmitDelayMs === "number" &&
    Number.isFinite(marker.autoSubmitDelayMs) &&
    marker.autoSubmitDelayMs >= 0
      ? marker.autoSubmitDelayMs
      : undefined
  const result = await submitCursorAgentPrompt(
    prompt,
    marker.command,
    autoSubmitDelayMs
  )
  if (marker.outputPath) {
    fs.writeFileSync(
      marker.outputPath,
      JSON.stringify(
        {
          workspace: getWorkspaceFolderPath(),
          command: marker.command || "workbench.action.chat.open",
          autoSubmitDelayMs,
          result: toJsonSafe(result),
        },
        null,
        2
      )
    )
  }
}

/**
 * Extension entry point — called on startup (onStartupFinished).
 */
export function activate(context: vscode.ExtensionContext): void {
  // Initialize logger
  logger.initialize()
  logger.info("CCursor extension activating...")

  // Create core services
  const config = new ConfigManager()
  bridge = new BridgeManager(config, context.extensionPath)
  network = new NetworkManager()
  network.setExtensionPath(context.extensionPath)
  network.setPort(config.port)
  const cert = new CertManager(config)
  const updater = new ExtensionUpdateService(context)

  // Create UI
  statusIndicator = new StatusIndicator()

  // Update status bar when server state changes
  bridge.on("stateChanged", (state: ServerState) => {
    statusIndicator?.update(state)
  })

  // Register all commands
  registerCommands(context, bridge, config, cert, network, updater)

  let currentPort = config.port
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      const portChanged = event.affectsConfiguration("agentVibes.port")
      if (!portChanged) return

      const nextPort = config.port
      if (nextPort === currentPort) return

      const previousPort = currentPort
      currentPort = nextPort
      network?.setPort(nextPort)

      logger.info(`CCursor port changed: ${previousPort} → ${nextPort}`)

      const bridgeRunning = bridge?.isRunning ?? false
      const forwardingActive = network?.isForwardingActive() ?? false

      try {
        if (bridgeRunning) {
          statusIndicator?.showBusy(
            t("bridge.restartingBusy"),
            tFmt("bridge.restartingTooltip", { port: nextPort })
          )
          await bridge?.restart()
          logger.info(`Bridge restarted on new port ${nextPort}`)
        }
      } catch (error) {
        statusIndicator?.clearBusy()
        const message = error instanceof Error ? error.message : String(error)
        logger.error(`Failed to restart bridge after port change`, error)
        void vscode.window.showErrorMessage(
          tFmt("bridge.failedRestart", { port: nextPort, message })
        )
        return
      }

      if (forwardingActive && network) {
        statusIndicator?.showBusy(
          t("bridge.reconfiguringBusy"),
          tFmt("bridge.reconfiguringTooltip", { port: nextPort })
        )
        executePrivileged(
          network.getReconfigureCommand(previousPort),
          t("terminal.reconfigureForwarding")
        )
        setTimeout(() => statusIndicator?.clearBusy(), 8000)
      } else {
        statusIndicator?.clearBusy()
      }
    })
  )

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
  const hasOpenAICompatAccounts =
    config.getAccountCount(config.openaiCompatAccountsPath) > 0
  const hasAnyAccounts =
    hasOpenAICompatAccounts ||
    config.getAccountCount(config.antigravityAccountsPath) > 0 ||
    config.getAccountCount(config.claudeApiAccountsPath) > 0 ||
    config.getAccountCount(config.codexAccountsPath) > 0 ||
    config.getAccountCount(config.kiroAccountsPath) > 0

  const runFirstRunOnboarding = async (): Promise<void> => {
    if (!needsCerts && hasAnyAccounts) {
      return
    }

    const missing: string[] = []
    if (needsCerts) missing.push(t("setup.missing.certs"))
    if (!hasAnyAccounts) missing.push(t("setup.missing.accounts"))

    const action = await vscode.window.showInformationMessage(
      tFmt("setup.needsSetup", { missing: missing.join(" / ") }),
      t("setup.action.now"),
      t("setup.action.later")
    )

    if (action === t("setup.action.now")) {
      if (needsCerts) {
        await vscode.commands.executeCommand(CMD.GENERATE_CERT)
      }
      if (!hasAnyAccounts) {
        await vscode.commands.executeCommand(CMD.OPEN_DASHBOARD)
        vscode.window.showInformationMessage(t("setup.addAccountHint"))
      }
    }
  }
  void runFirstRunOnboarding().catch((error) => {
    logger.warn(
      `First-run setup prompt failed: ${error instanceof Error ? error.message : String(error)}`
    )
  })

  const promptReloadAfterForwardingEnabled = async (): Promise<void> => {
    if (!network) return
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
              t("forwarding.promptEnable"),
              t("forwarding.action.enable"),
              t("setup.action.later")
            )
            if (action === t("forwarding.action.enable")) {
              executePrivileged(
                network!.getEnableCommand(),
                t("terminal.enableForwarding")
              )
              void promptReloadAfterForwardingEnabled()
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

  void updater.checkForUpdatesOnStartup()

  setTimeout(() => {
    void tryRunDebugSubmitMarker().catch((error) => {
      logger.error("Cursor Agent debug marker submission failed", error)
    })
  }, 1500)
  const debugMarkerPoller = setInterval(() => {
    void tryRunDebugSubmitMarker().catch((error) => {
      logger.error("Cursor Agent debug marker submission failed", error)
    })
  }, 1000)
  context.subscriptions.push({
    dispose: () => clearInterval(debugMarkerPoller),
  })

  logger.info("CCursor extension activated")
}

/**
 * Extension deactivation — clean up all resources.
 */
export function deactivate(): void {
  bridge?.dispose()
  network?.dispose()
  statusIndicator?.dispose()
  logger.info("CCursor extension deactivated")
  logger.dispose()
}
