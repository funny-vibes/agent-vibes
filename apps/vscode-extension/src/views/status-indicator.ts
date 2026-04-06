import * as vscode from "vscode"
import type { ServerState } from "../constants"
import { EXTENSION_DISPLAY_NAME } from "../constants"

/**
 * Bottom status bar indicator showing server state at a glance.
 */
export class StatusIndicator {
  private item: vscode.StatusBarItem

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    )
    this.item.command = "agentVibes.openDashboard"
    this.update("stopped")
    this.item.show()
  }

  update(state: ServerState): void {
    // Always open Dashboard on click
    this.item.command = "agentVibes.openDashboard"

    switch (state) {
      case "running":
        this.item.text = `$(circle-filled) ${EXTENSION_DISPLAY_NAME}`
        this.item.tooltip = "Agent Vibes — Running (click to open dashboard)"
        this.item.backgroundColor = undefined
        break
      case "starting":
        this.item.text = `$(loading~spin) ${EXTENSION_DISPLAY_NAME}`
        this.item.tooltip = "Agent Vibes — Starting..."
        this.item.backgroundColor = undefined
        break
      case "error":
        this.item.text = `$(warning) ${EXTENSION_DISPLAY_NAME}`
        this.item.tooltip = "Agent Vibes — Error (click to open dashboard)"
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground"
        )
        break
      case "stopped":
      default:
        this.item.text = `$(circle-outline) ${EXTENSION_DISPLAY_NAME}`
        this.item.tooltip = "Agent Vibes — Stopped (click to open dashboard)"
        this.item.backgroundColor = undefined
        break
    }
  }

  dispose(): void {
    this.item.dispose()
  }
}
