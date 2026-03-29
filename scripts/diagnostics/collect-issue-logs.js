#!/usr/bin/env node
/**
 * Issue Diagnostics Collector for Agent Vibes
 *
 * Collects environment info, configuration status, and sanitized logs
 * into a Markdown report ready for GitHub Issues.
 *
 * Usage:
 *   node scripts/diagnostics/collect-issue-logs.js [--lines N] [--no-copy]
 *
 * Options:
 *   --lines N    Number of log tail lines to include (default: 200)
 *   --no-copy    Skip clipboard copy
 */

const os = require("os")
const fs = require("fs")
const path = require("path")
const { execSync } = require("child_process")

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..", "..")
const LOG_DIR = path.join(ROOT, ".log")
const OUTPUT_FILE = path.join(LOG_DIR, "issue-report.md")

const args = process.argv.slice(2)
const linesIndex = args.indexOf("--lines")
const TAIL_LINES =
  linesIndex !== -1 ? parseInt(args[linesIndex + 1], 10) || 200 : 200
const NO_COPY = args.includes("--no-copy")
const IMPORTANT_LOG_LIMIT = 25
const MAX_LOG_LINE_LENGTH = 400

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely execute a command and return trimmed stdout, or fallback on error.
 */
function safeExec(cmd, fallback = "N/A") {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim()
  } catch {
    return fallback
  }
}

/**
 * Read the last N lines of a file. Returns null if file does not exist.
 */
function tailFile(filePath, lines) {
  if (!fs.existsSync(filePath)) return null
  try {
    const content = fs.readFileSync(filePath, "utf-8")
    const allLines = content.split("\n")
    const start = Math.max(0, allLines.length - lines)
    return allLines.slice(start).join("\n")
  } catch {
    return null
  }
}

function stripAnsi(text) {
  if (!text) return text
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;]*m/g,
    ""
  )
}

/**
 * Redact sensitive tokens and keys from log content.
 */
function redact(text) {
  if (!text) return text
  return (
    stripAnsi(text)
      // Google access tokens (ya29.xxx)
      .replace(/ya29[.\w-]+/g, "[REDACTED_ACCESS_TOKEN]")
      // Google refresh tokens (1//xxx)
      .replace(/1\/\/[\w-]+/g, "[REDACTED_REFRESH_TOKEN]")
      // JWT tokens (eyJxxx.eyJxxx.xxx)
      .replace(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g, "[REDACTED_JWT]")
      // Bearer tokens
      .replace(/(Bearer\s+)[\w.-]+/gi, "$1[REDACTED]")
      // API key values in env-style
      .replace(
        /(PROXY_API_KEY|API_KEY|SECRET|PASSWORD|TOKEN)\s*[=:]\s*\S+/gi,
        "$1=[REDACTED]"
      )
      // Generic long hex/base64 secrets (40+ chars)
      .replace(
        /(?<=[:=]\s?)[A-Za-z0-9+/]{40,}={0,2}(?=\s|$)/g,
        "[REDACTED_SECRET]"
      )
      // Email addresses
      .replace(
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
        "[REDACTED_EMAIL]"
      )
      // macOS/Linux home paths
      .replace(/\/Users\/[^/\s]+/g, "/Users/[REDACTED_USER]")
      .replace(/\/home\/[^/\s]+/g, "/home/[REDACTED_USER]")
      // Common local hostnames
      .replace(/\b[\w.-]+@MacBook[-\w.]*\b/g, "[REDACTED_HOST]")
  )
}

function truncateLine(line) {
  if (line.length <= MAX_LOG_LINE_LENGTH) return line
  return `${line.slice(0, MAX_LOG_LINE_LENGTH - 3)}...`
}

function isImportantLogLine(line) {
  const patterns = [
    /\b(ERROR|WARN|FATAL)\b/i,
    /\b(fail|failed|failure|failing)\b/i,
    /\b(exception|traceback)\b/i,
    /\b(timeout|timed out|refused|denied|forbidden|unauthorized)\b/i,
    /\b(invalid|mismatch|unreachable|missing|not found)\b/i,
    /\b(429|403|404|500|502|503)\b/,
    /\bConnect error\b/i,
    /\bNo .* found\b/i,
    /\bCould not\b/i,
    /\bERR\b/i,
    /\[ROUTE\]/,
    /Thinking enabled:/,
  ]

  return patterns.some((pattern) => pattern.test(line))
}

function extractImportantLogLines(content, limit = IMPORTANT_LOG_LIMIT) {
  if (!content) return []

  const lines = redact(content)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)

  const selected = []
  const seen = new Set()

  for (const line of lines) {
    if (!isImportantLogLine(line)) continue
    const normalized = line.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    selected.push(truncateLine(normalized))
    if (selected.length >= limit) break
  }

  return selected
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

function collectEnvironment() {
  const pkg = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "apps", "protocol-bridge", "package.json"),
      "utf-8"
    )
  )

  // Try to detect Cursor version (cross-platform)
  let cursorVersion = "N/A"
  try {
    const platform = require(path.join(ROOT, "scripts", "lib", "platform"))
    const binaryPath = platform.cursorBinaryPath()

    if (process.platform === "darwin") {
      // macOS: read Info.plist CFBundleShortVersionString
      const plistPath = path.join(path.dirname(binaryPath), "..", "Info.plist")
      if (fs.existsSync(plistPath)) {
        const plist = fs.readFileSync(plistPath, "utf-8")
        const match = plist.match(
          /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/
        )
        if (match) cursorVersion = match[1]
      }
    }

    // Cross-platform fallback: try cursor --version CLI
    if (cursorVersion === "N/A" && binaryPath) {
      const ver = safeExec(`"${binaryPath}" --version`, "")
      if (ver) {
        // cursor --version returns multi-line: version on first line
        const firstLine = ver.split("\n")[0].trim()
        if (firstLine) cursorVersion = firstLine
      }
    }

    // Last resort: read package.json from resources/app/
    if (cursorVersion === "N/A" && binaryPath) {
      const resourcePkgCandidates =
        process.platform === "darwin"
          ? [
              path.join(
                path.dirname(binaryPath),
                "..",
                "Resources",
                "app",
                "package.json"
              ),
            ]
          : [
              path.join(
                path.dirname(binaryPath),
                "resources",
                "app",
                "package.json"
              ),
              path.join(
                path.dirname(binaryPath),
                "..",
                "resources",
                "app",
                "package.json"
              ),
            ]
      for (const pkgPath of resourcePkgCandidates) {
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
            if (pkg.version) {
              cursorVersion = pkg.version
              break
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch {
    // Cursor detection is best-effort
  }

  return {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    node: process.version,
    npm: safeExec("npm --version"),
    agentVibes: `v${pkg.version}`,
    cursor: cursorVersion,
  }
}

function collectConfigStatus() {
  const checks = {}

  // SSL certificates
  const certPath = path.join(
    ROOT,
    "apps",
    "protocol-bridge",
    "certs",
    "localhost.crt"
  )
  checks.sslCerts = fs.existsSync(certPath) ? "✅ Found" : "❌ Not found"

  const bridgeEnv = path.join(ROOT, "apps", "protocol-bridge", ".env.local")
  checks.bridgeEnvLocal = fs.existsSync(bridgeEnv) ? "✅ Found" : "❌ Not found"
  if (fs.existsSync(bridgeEnv)) {
    const envText = fs.readFileSync(bridgeEnv, "utf-8")
    checks.codexCredentials = /^(CODEX_API_KEY|CODEX_ACCESS_TOKEN)=/m.test(
      envText
    )
      ? "✅ Found"
      : "⚠️ Not found"
  } else {
    checks.codexCredentials = "⚠️ Not found"
  }

  // accounts.json
  const accountsPath = path.join(
    ROOT,
    "apps",
    "protocol-bridge",
    "data",
    "accounts.json"
  )
  if (fs.existsSync(accountsPath)) {
    try {
      const accounts = JSON.parse(fs.readFileSync(accountsPath, "utf-8"))
      const count = Array.isArray(accounts)
        ? accounts.length
        : Array.isArray(accounts.accounts)
          ? accounts.accounts.length
          : "?"
      checks.accounts = `✅ Found (${count} account${count !== 1 ? "s" : ""})`
    } catch {
      checks.accounts = "⚠️ Found but invalid JSON"
    }
  } else {
    checks.accounts = "❌ Not found"
  }

  // Port forwarding status (non-sudo check only)
  checks.forwarding = safeExec(
    `node ${path.join(ROOT, "scripts", "proxy", "setup-forwarding.js")} status`,
    "⚠️ Could not detect"
  )
  checks.forwarding = redact(checks.forwarding)

  // Build status
  const mainJs = path.join(ROOT, "apps", "protocol-bridge", "dist", "main.js")
  checks.build = fs.existsSync(mainJs) ? "✅ Built" : "❌ Not built"

  return checks
}

function collectLogs() {
  const logs = {}

  // Log files to check (latest aliases + timestamped runs)
  const discoveredLogFiles = []
  if (fs.existsSync(LOG_DIR)) {
    for (const entry of fs.readdirSync(LOG_DIR)) {
      if (
        /^protocol-bridge-.*\.log$/.test(entry) ||
        /^cursor_grpc-.*\.log$/.test(entry)
      ) {
        discoveredLogFiles.push({
          name: entry,
          path: path.join(LOG_DIR, entry),
        })
      }
    }
  }

  discoveredLogFiles.sort((a, b) => {
    try {
      return fs.statSync(b.path).mtimeMs - fs.statSync(a.path).mtimeMs
    } catch {
      return 0
    }
  })

  const logFiles = [
    {
      name: "protocol-bridge.log (latest)",
      path: path.join(LOG_DIR, "protocol-bridge.log"),
    },
    {
      name: "cursor_grpc.log (latest)",
      path: path.join(LOG_DIR, "cursor_grpc.log"),
    },
    ...discoveredLogFiles.slice(0, 6),
    { name: "agent.log (legacy)", path: path.join(ROOT, "agent.log") },
  ]

  for (const logFile of logFiles) {
    const content = tailFile(logFile.path, TAIL_LINES)
    if (content !== null) {
      const stat = fs.statSync(logFile.path)
      const importantLines = extractImportantLogLines(content)
      logs[logFile.name] = {
        importantLines,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      }
    }
  }

  return logs
}

// ---------------------------------------------------------------------------
// Report Generator
// ---------------------------------------------------------------------------

function generateReport() {
  const env = collectEnvironment()
  const config = collectConfigStatus()
  const logs = collectLogs()

  const timestamp = new Date().toISOString()

  let report = `# Agent Vibes Issue Report

> Generated by \`npm run issues\` at ${timestamp}

## Environment

| Item | Value |
|------|-------|
| OS | ${env.os} |
| Node.js | ${env.node} |
| npm | ${env.npm} |
| agent-vibes | ${env.agentVibes} |
| Cursor IDE | ${env.cursor} |

## Configuration Status

| Check | Status |
|-------|--------|
| SSL Certificates | ${config.sslCerts} |
| Bridge .env.local | ${config.bridgeEnvLocal} |
| Codex Credentials | ${config.codexCredentials} |
| Accounts | ${config.accounts} |
| Build | ${config.build} |

<details>
<summary>Port Forwarding Status</summary>

\`\`\`
${config.forwarding}
\`\`\`

</details>
`

  // Append log sections
  const logEntries = Object.entries(logs)
  if (logEntries.length > 0) {
    report += `\n## High-Signal Logs (scanned last ${TAIL_LINES} lines)\n`

    for (const [name, log] of logEntries) {
      const sizeMB = (log.size / 1024 / 1024).toFixed(2)
      report += `
### ${name}

- **Size**: ${sizeMB} MB
- **Last modified**: ${log.modified}

<details>
<summary>Click to expand important lines</summary>

\`\`\`
${log.importantLines.length > 0 ? log.importantLines.join("\n") : "No recent high-signal lines found in the scan window."}
\`\`\`

</details>
`
    }
  } else {
    report += `
## Logs

> No log files found. Logs are automatically generated when the server runs.
> Please reproduce the issue first, then run \`npm run issues\` again.
>
> \`\`\`bash
> npm run start    # logs auto-saved to .log/protocol-bridge.log
> \`\`\`
`
  }

  return report
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log("🔍 Collecting issue diagnostics...\n")

  // Ensure .log directory exists
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }

  const report = generateReport()

  // Write report file
  fs.writeFileSync(OUTPUT_FILE, report, "utf-8")
  console.log(`✅ Report saved to: ${path.relative(ROOT, OUTPUT_FILE)}`)

  // Copy to clipboard (macOS)
  if (!NO_COPY) {
    try {
      if (process.platform === "darwin") {
        execSync("pbcopy", { input: report, encoding: "utf-8" })
        console.log("📋 Report copied to clipboard!")
      } else if (process.platform === "linux") {
        // Try xclip or xsel
        try {
          execSync("xclip -selection clipboard", {
            input: report,
            encoding: "utf-8",
          })
          console.log("📋 Report copied to clipboard!")
        } catch {
          try {
            execSync("xsel --clipboard --input", {
              input: report,
              encoding: "utf-8",
            })
            console.log("📋 Report copied to clipboard!")
          } catch {
            console.log(
              "💡 Tip: Install xclip or xsel for automatic clipboard copy"
            )
          }
        }
      } else if (process.platform === "win32") {
        execSync("clip", { input: report, encoding: "utf-8" })
        console.log("📋 Report copied to clipboard!")
      }
    } catch {
      // Clipboard is best-effort
    }
  }

  console.log(
    "\n💡 Paste the report into your GitHub Issue:\n" +
      "   https://github.com/funny-vibes/agent-vibes/issues/new?template=bug_report.md\n"
  )
}

main()
