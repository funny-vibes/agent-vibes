import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import { ensureDir, getDefaultDataDir } from "../utils/platform"

/**
 * Manages the extension's configuration and data directory (~/.agent-vibes/).
 */
export class ConfigManager {
  constructor() {
    this.ensureDirectories()
  }

  private getConfiguredDataDir(): string {
    const customDir =
      vscode.workspace.getConfiguration("agentVibes").get<string>("dataDir") ??
      ""
    return customDir.trim() || getDefaultDataDir()
  }

  get dataDir(): string {
    return this.getConfiguredDataDir()
  }

  get certsDir(): string {
    return path.join(this.dataDir, "certs")
  }

  get accountsDir(): string {
    return path.join(this.dataDir, "data")
  }

  get runtimeDir(): string {
    return path.join(this.dataDir, "runtime")
  }

  get logsDir(): string {
    return path.join(this.dataDir, "logs")
  }

  get configFilePath(): string {
    return path.join(this.dataDir, "config.json")
  }

  get port(): number {
    return (
      vscode.workspace.getConfiguration("agentVibes").get<number>("port") ??
      2026
    )
  }

  get autoStart(): boolean {
    return (
      vscode.workspace
        .getConfiguration("agentVibes")
        .get<boolean>("autoStart") ?? true
    )
  }

  get healthCheckInterval(): number {
    return (
      vscode.workspace
        .getConfiguration("agentVibes")
        .get<number>("healthCheckInterval") ?? 30
    )
  }

  get debugMode(): boolean {
    return (
      vscode.workspace
        .getConfiguration("agentVibes")
        .get<boolean>("debugMode") ?? false
    )
  }

  get thinkingBudgetAuto(): boolean {
    return (
      vscode.workspace
        .getConfiguration("agentVibes")
        .get<boolean>("thinkingBudgetAuto") ?? true
    )
  }

  get antigravitySystemPrompt(): boolean {
    return (
      vscode.workspace
        .getConfiguration("agentVibes")
        .get<boolean>("antigravitySystemPrompt") ?? true
    )
  }

  get antigravityOfficialTools(): boolean {
    return (
      vscode.workspace
        .getConfiguration("agentVibes")
        .get<boolean>("antigravityOfficialTools") ?? true
    )
  }

  private getConfiguredAccountPath(settingKey: string): string {
    return (
      vscode.workspace.getConfiguration("agentVibes").get<string>(settingKey) ??
      ""
    ).trim()
  }

  hasCustomAccountPath(settingKey: string): boolean {
    return this.getConfiguredAccountPath(settingKey).length > 0
  }

  private resolveAccountPath(settingKey: string, filename: string): string {
    const configuredPath = this.getConfiguredAccountPath(settingKey)
    return configuredPath
      ? path.resolve(configuredPath)
      : path.join(this.accountsDir, filename)
  }

  // --- Account file paths ---

  get antigravityAccountsPath(): string {
    return this.resolveAccountPath(
      "antigravityAccountsPath",
      "antigravity-accounts.json"
    )
  }

  get claudeApiAccountsPath(): string {
    return this.resolveAccountPath(
      "claudeApiAccountsPath",
      "claude-api-accounts.json"
    )
  }

  get codexAccountsPath(): string {
    return this.resolveAccountPath("codexAccountsPath", "codex-accounts.json")
  }

  get openaiCompatAccountsPath(): string {
    return this.resolveAccountPath(
      "openaiCompatAccountsPath",
      "openai-compat-accounts.json"
    )
  }

  get accountPathEnvOverrides(): Record<string, string> {
    const overrides: Record<string, string> = {}

    const antigravityPath = this.getConfiguredAccountPath(
      "antigravityAccountsPath"
    )
    if (antigravityPath) {
      overrides.AGENT_VIBES_ANTIGRAVITY_ACCOUNTS_PATH =
        path.resolve(antigravityPath)
    }

    const claudeApiPath = this.getConfiguredAccountPath("claudeApiAccountsPath")
    if (claudeApiPath) {
      overrides.AGENT_VIBES_CLAUDE_API_ACCOUNTS_PATH =
        path.resolve(claudeApiPath)
    }

    const codexPath = this.getConfiguredAccountPath("codexAccountsPath")
    if (codexPath) {
      overrides.AGENT_VIBES_CODEX_ACCOUNTS_PATH = path.resolve(codexPath)
    }

    const openaiCompatPath = this.getConfiguredAccountPath(
      "openaiCompatAccountsPath"
    )
    if (openaiCompatPath) {
      overrides.AGENT_VIBES_OPENAI_COMPAT_ACCOUNTS_PATH =
        path.resolve(openaiCompatPath)
    }

    return overrides
  }

  // --- Certificate paths ---

  get caCertPath(): string {
    return path.join(this.certsDir, "ca.pem")
  }

  get caKeyPath(): string {
    return path.join(this.certsDir, "ca-key.pem")
  }

  get serverCertPath(): string {
    return path.join(this.certsDir, "server.pem")
  }

  get serverKeyPath(): string {
    return path.join(this.certsDir, "server-key.pem")
  }

  /** Check if SSL certificates exist */
  hasCertificates(): boolean {
    return (
      fs.existsSync(this.serverCertPath) && fs.existsSync(this.serverKeyPath)
    )
  }

  /** Count accounts for a given backend */
  getAccountCount(filePath: string): number {
    try {
      if (!fs.existsSync(filePath)) return 0
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
        accounts?: Record<string, unknown>[]
      }
      return Array.isArray(data.accounts) ? data.accounts.length : 0
    } catch {
      return 0
    }
  }

  /** Read all accounts from a backend JSON file */
  readAccounts(filePath: string): Record<string, unknown>[] {
    try {
      if (!fs.existsSync(filePath)) return []
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
        accounts?: Record<string, unknown>[]
      }
      return Array.isArray(data.accounts) ? data.accounts : []
    } catch {
      return []
    }
  }

  /** Add an account to a backend JSON file */
  addAccount(filePath: string, account: Record<string, unknown>): void {
    const accounts = this.readAccounts(filePath)
    accounts.push(account)
    this.writeAccounts(filePath, accounts)
  }

  /** Remove an account by index */
  removeAccount(filePath: string, index: number): void {
    const accounts = this.readAccounts(filePath)
    if (index >= 0 && index < accounts.length) {
      accounts.splice(index, 1)
      this.writeAccounts(filePath, accounts)
    }
  }

  /** Remove a Codex account by accountId */
  removeCodexAccount(filePath: string, accountId: string): void {
    const normalizedAccountId = accountId.trim()
    if (!normalizedAccountId) {
      return
    }

    const accounts = this.readAccounts(filePath)
    const nextAccounts = accounts.filter((account) => {
      const rowAccountId = String(
        account.accountId || account.account_id || ""
      ).trim()
      return rowAccountId !== normalizedAccountId
    })

    if (nextAccounts.length !== accounts.length) {
      this.writeAccounts(filePath, nextAccounts)
    }
  }

  /** Update an account at a specific index */
  updateAccount(
    filePath: string,
    index: number,
    account: Record<string, unknown>
  ): void {
    const accounts = this.readAccounts(filePath)
    if (index >= 0 && index < accounts.length) {
      accounts[index] = account
      this.writeAccounts(filePath, accounts)
    }
  }

  /** Write accounts array to a backend JSON file */
  writeAccounts(filePath: string, accounts: Record<string, unknown>[]): void {
    ensureDir(path.dirname(filePath))
    fs.writeFileSync(filePath, JSON.stringify({ accounts }, null, 2))
  }

  readLocalConfig<T>(key: string, fallback: T): T {
    try {
      if (!fs.existsSync(this.configFilePath)) {
        return fallback
      }
      const parsed: Record<string, unknown> = JSON.parse(
        fs.readFileSync(this.configFilePath, "utf-8")
      ) as Record<string, unknown>
      if (parsed && typeof parsed === "object" && key in parsed) {
        return (parsed as Record<string, T>)[key] ?? fallback
      }
      return fallback
    } catch {
      return fallback
    }
  }

  writeLocalConfig(key: string, value: unknown): void {
    let parsed: Record<string, unknown> = {}
    try {
      if (fs.existsSync(this.configFilePath)) {
        const raw = JSON.parse(
          fs.readFileSync(this.configFilePath, "utf-8")
        ) as Record<string, unknown>
        if (raw && typeof raw === "object") {
          parsed = raw
        }
      }
    } catch {
      parsed = {}
    }

    parsed[key] = value
    ensureDir(path.dirname(this.configFilePath))
    fs.writeFileSync(this.configFilePath, JSON.stringify(parsed, null, 2))
  }

  ensureDirectories(): void {
    ensureDir(this.dataDir)
    ensureDir(this.certsDir)
    ensureDir(this.accountsDir)
    ensureDir(this.runtimeDir)
    ensureDir(this.logsDir)
    ensureDir(path.dirname(this.antigravityAccountsPath))
    ensureDir(path.dirname(this.claudeApiAccountsPath))
    ensureDir(path.dirname(this.codexAccountsPath))
    ensureDir(path.dirname(this.openaiCompatAccountsPath))
  }
}
