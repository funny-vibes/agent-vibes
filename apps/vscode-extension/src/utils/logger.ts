import * as vscode from "vscode"
import { EXTENSION_DISPLAY_NAME } from "../constants"

/**
 * Centralized logging via VSCode OutputChannel.
 * All extension log output goes through this singleton.
 */
class Logger {
  private channel: vscode.OutputChannel | null = null

  initialize(): void {
    this.channel = vscode.window.createOutputChannel(EXTENSION_DISPLAY_NAME)
  }

  info(message: string): void {
    this.write("INFO", message)
  }

  warn(message: string): void {
    this.write("WARN", message)
  }

  error(message: string, err?: unknown): void {
    const suffix =
      err instanceof Error ? `: ${err.message}` : err ? `: ${String(err)}` : ""
    this.write("ERROR", `${message}${suffix}`)
  }

  debug(message: string): void {
    const config = vscode.workspace.getConfiguration("agentVibes")
    if (config.get<boolean>("debugMode")) {
      this.write("DEBUG", message)
    }
  }

  /** Append raw text (for streaming process output) */
  append(text: string): void {
    this.channel?.append(text)
  }

  show(): void {
    this.channel?.show(true)
  }

  dispose(): void {
    this.channel?.dispose()
    this.channel = null
  }

  private write(level: string, message: string): void {
    const ts = new Date().toISOString()
    this.channel?.appendLine(`[${ts}] [${level}] ${message}`)
  }
}

export const logger = new Logger()
