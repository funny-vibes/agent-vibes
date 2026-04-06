import * as vscode from "vscode"

/**
 * VSCode Terminal API wrapper for executing commands that require user interaction
 * (e.g. sudo authentication). Commands are visible in the integrated terminal.
 */
export function executeInTerminal(
  command: string,
  name: string = "Agent Vibes"
): vscode.Terminal {
  const terminal = vscode.window.createTerminal({ name })
  terminal.show()
  terminal.sendText(command)
  return terminal
}

/**
 * Execute a privileged command via terminal (shows sudo prompt to user).
 * On Windows, uses PowerShell UAC elevation.
 */
export function executePrivileged(
  command: string,
  name: string = "Agent Vibes (sudo)"
): vscode.Terminal {
  if (process.platform === "win32") {
    return executeInTerminal(
      `Start-Process -Verb RunAs -FilePath cmd -ArgumentList '/c ${command}'`,
      name
    )
  }
  return executeInTerminal(`sudo ${command}`, name)
}
