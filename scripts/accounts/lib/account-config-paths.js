const os = require("os")
const path = require("path")

const ACCOUNT_CONFIG_ENV_VARS = {
  "antigravity-accounts.json": "AGENT_VIBES_ANTIGRAVITY_ACCOUNTS_PATH",
  "claude-api-accounts.json": "AGENT_VIBES_CLAUDE_API_ACCOUNTS_PATH",
  "codex-accounts.json": "AGENT_VIBES_CODEX_ACCOUNTS_PATH",
  "openai-compat-accounts.json": "AGENT_VIBES_OPENAI_COMPAT_ACCOUNTS_PATH",
}

function getAgentVibesDataDir() {
  return (
    process.env.AGENT_VIBES_DATA_DIR || path.join(os.homedir(), ".agent-vibes")
  )
}

function getAccountConfigEnvVarName(filename) {
  return ACCOUNT_CONFIG_ENV_VARS[filename] || null
}

function readFlagValue(argv, flagName) {
  for (let idx = 0; idx < argv.length; idx++) {
    const arg = argv[idx]
    if (arg === flagName) {
      const next = argv[idx + 1]
      return typeof next === "string" && next.trim() ? next.trim() : ""
    }
    if (arg.startsWith(`${flagName}=`)) {
      return arg.slice(flagName.length + 1).trim()
    }
  }
  return ""
}

function resolveConfiguredAccountConfigPath(filename, argv = []) {
  const explicitArg = readFlagValue(argv, "--accounts-file")
  if (explicitArg) {
    return path.resolve(explicitArg)
  }

  const envVar = getAccountConfigEnvVarName(filename)
  const configuredPath = envVar ? process.env[envVar]?.trim() : ""
  if (configuredPath) {
    return path.resolve(configuredPath)
  }

  return null
}

function resolveDefaultAccountConfigPath(projectRoot, filename, argv = []) {
  return (
    resolveConfiguredAccountConfigPath(filename, argv) ||
    path.join(getAgentVibesDataDir(), "data", filename)
  )
}

function formatPathForDisplay(projectRoot, filePath) {
  const relativePath = path.relative(projectRoot, filePath)
  if (!relativePath || relativePath.startsWith("..")) {
    return filePath
  }
  return relativePath
}

module.exports = {
  formatPathForDisplay,
  getAccountConfigEnvVarName,
  getAgentVibesDataDir,
  resolveConfiguredAccountConfigPath,
  resolveDefaultAccountConfigPath,
}
