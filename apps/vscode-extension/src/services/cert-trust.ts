import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { logger } from "../utils/logger"

/**
 * Cross-platform certificate trust injection.
 *
 * Handles TWO layers of trust required for Cursor (Electron):
 * 1. System trust store (macOS Keychain / Linux ca-certificates / Windows CertStore)
 *    → Needed for Chromium's BoringSSL network layer
 * 2. NODE_EXTRA_CA_CERTS environment variable
 *    → Needed for Node.js/OpenSSL gRPC connections (Electron Extension Host)
 *
 * Both layers run in a SINGLE sudo script to minimize password prompts.
 */
export class CertTrustService {
  /**
   * Generate a platform-specific shell script that:
   * 1. Adds CA to system trust store (requires sudo)
   * 2. Injects NODE_EXTRA_CA_CERTS into shell profile (no sudo needed)
   *
   * Returns the path to the generated script.
   */
  static generateTrustScript(caCertPath: string): string {
    const platform = process.platform
    const home = os.homedir()

    if (platform === "darwin") {
      return CertTrustService.generateDarwinScript(caCertPath, home)
    } else if (platform === "linux") {
      return CertTrustService.generateLinuxScript(caCertPath, home)
    } else {
      return CertTrustService.generateWindowsScript(caCertPath)
    }
  }

  /**
   * Check if NODE_EXTRA_CA_CERTS is already configured in shell profiles.
   */
  static isNodeCaConfigured(caCertPath: string): boolean {
    const home = os.homedir()
    const profiles = [
      path.join(home, ".zshrc"),
      path.join(home, ".bashrc"),
      path.join(home, ".bash_profile"),
    ]

    for (const profile of profiles) {
      try {
        if (!fs.existsSync(profile)) continue
        const content = fs.readFileSync(profile, "utf-8")
        if (
          content.includes("NODE_EXTRA_CA_CERTS") &&
          content.includes(caCertPath)
        ) {
          return true
        }
      } catch {
        continue
      }
    }
    return false
  }

  /**
   * Check if the CA certificate is trusted by macOS System Keychain.
   */
  static isCaTrustedMacOS(caCertPath: string): boolean {
    if (process.platform !== "darwin") return false
    try {
      const { execSync } = require("child_process")
      const result = execSync(`security verify-cert -c "${caCertPath}" 2>&1`, {
        encoding: "utf-8",
        stdio: "pipe",
      })
      return result.includes("valid")
    } catch {
      return false
    }
  }

  // ── macOS ──────────────────────────────────────────────────────────

  private static generateDarwinScript(
    caCertPath: string,
    home: string
  ): string {
    const scriptPath = path.join(os.tmpdir(), "agent-vibes-trust-ca.sh")
    const marker = "# Added by Agent Vibes (Electron/Node.js CA trust)"
    const exportLine = `export NODE_EXTRA_CA_CERTS="${caCertPath}"`

    let script = `#!/bin/bash
set -e

echo "🔐 Agent Vibes — Certificate Trust Setup"
echo ""

# ── Step 1: Add CA to macOS System Keychain ───────────────────────────
# Remove any existing Agent Vibes CA to avoid stale certificate conflicts
echo "▸ Cleaning up old CA certificates from System Keychain..."
while security find-certificate -c "Agent Vibes Local CA" /Library/Keychains/System.keychain >/dev/null 2>&1; do
  security delete-certificate -c "Agent Vibes Local CA" /Library/Keychains/System.keychain 2>/dev/null && \\
    echo "  ✓ Removed old CA entry" || break
done

echo "▸ Adding new CA to System Keychain..."
security add-trusted-cert -d -r trustRoot \\
  -k /Library/Keychains/System.keychain \\
  "${caCertPath}" 2>/dev/null && \\
  echo "✓ CA added to System Keychain" || \\
  echo "⚠ Could not add to System Keychain (may need manual trust via Keychain Access)"

echo ""

`
    // Step 2: NODE_EXTRA_CA_CERTS injection (doesn't need sudo but easier in one script)
    script += CertTrustService.generateShellProfileInjection(
      caCertPath,
      home,
      marker,
      exportLine
    )

    script += `
echo ""
echo "✅ Certificate trust setup complete!"
echo "   Please restart Cursor (Cmd+Q → reopen) for changes to take effect."
echo ""
`

    fs.writeFileSync(scriptPath, script, { mode: 0o755 })
    logger.info(`Generated macOS trust script: ${scriptPath}`)
    return scriptPath
  }

  // ── Linux ──────────────────────────────────────────────────────────

  private static generateLinuxScript(caCertPath: string, home: string): string {
    const scriptPath = path.join(os.tmpdir(), "agent-vibes-trust-ca.sh")
    const marker = "# Added by Agent Vibes (Electron/Node.js CA trust)"
    const exportLine = `export NODE_EXTRA_CA_CERTS="${caCertPath}"`

    let script = `#!/bin/bash
set -e

echo "🔐 Agent Vibes — Certificate Trust Setup"
echo ""

# ── Step 1: Add CA to system trust store ──────────────────────────────
echo "▸ Adding CA to system trust store..."
if [ -d /usr/local/share/ca-certificates ]; then
  cp "${caCertPath}" /usr/local/share/ca-certificates/agent-vibes-ca.crt
  update-ca-certificates 2>/dev/null && echo "✓ CA added to trust store" || echo "⚠ update-ca-certificates failed"
elif [ -d /etc/pki/ca-trust/source/anchors ]; then
  cp "${caCertPath}" /etc/pki/ca-trust/source/anchors/agent-vibes-ca.pem
  update-ca-trust extract 2>/dev/null && echo "✓ CA added to trust store" || echo "⚠ update-ca-trust failed"
else
  echo "⚠ Could not find system CA directory"
fi

echo ""

`
    script += CertTrustService.generateShellProfileInjection(
      caCertPath,
      home,
      marker,
      exportLine
    )

    script += `
echo ""
echo "✅ Certificate trust setup complete!"
echo "   Please restart Cursor for changes to take effect."
echo ""
`

    fs.writeFileSync(scriptPath, script, { mode: 0o755 })
    logger.info(`Generated Linux trust script: ${scriptPath}`)
    return scriptPath
  }

  // ── Windows ────────────────────────────────────────────────────────

  private static generateWindowsScript(caCertPath: string): string {
    const scriptPath = path.join(os.tmpdir(), "agent-vibes-trust-ca.ps1")
    const script = `
Write-Host "🔐 Agent Vibes — Certificate Trust Setup" -ForegroundColor Cyan
Write-Host ""

# Step 1: Import CA to Trusted Root
Write-Host "▸ Adding CA to Windows Certificate Store..."
try {
    Import-Certificate -FilePath "${caCertPath.replace(/\\/g, "\\\\")}" -CertStoreLocation Cert:\\LocalMachine\\Root -ErrorAction Stop
    Write-Host "✓ CA added to Trusted Root Certification Authorities" -ForegroundColor Green
} catch {
    Write-Host "⚠ Failed to add CA: $_" -ForegroundColor Yellow
}

# Step 2: Set NODE_EXTRA_CA_CERTS as user environment variable
Write-Host ""
Write-Host "▸ Setting NODE_EXTRA_CA_CERTS environment variable..."
[Environment]::SetEnvironmentVariable("NODE_EXTRA_CA_CERTS", "${caCertPath.replace(/\\/g, "\\\\")}", "User")
Write-Host "✓ NODE_EXTRA_CA_CERTS set for current user" -ForegroundColor Green

Write-Host ""
Write-Host "✅ Certificate trust setup complete!" -ForegroundColor Green
Write-Host "   Please restart Cursor for changes to take effect."
`

    fs.writeFileSync(scriptPath, script, { mode: 0o755 })
    logger.info(`Generated Windows trust script: ${scriptPath}`)
    return scriptPath
  }

  // ── Shell Profile Injection ────────────────────────────────────────

  private static generateShellProfileInjection(
    caCertPath: string,
    home: string,
    marker: string,
    exportLine: string
  ): string {
    // Detect the user's shell profile
    const profiles = [
      { path: path.join(home, ".zshrc"), name: ".zshrc" },
      { path: path.join(home, ".bashrc"), name: ".bashrc" },
      { path: path.join(home, ".bash_profile"), name: ".bash_profile" },
    ]

    let script = `# ── Step 2: Inject NODE_EXTRA_CA_CERTS into shell profile ─────────────
echo "▸ Configuring NODE_EXTRA_CA_CERTS for Cursor (Electron/Node.js)..."
`

    for (const profile of profiles) {
      script += `
if [ -f "${profile.path}" ]; then
  if grep -q "NODE_EXTRA_CA_CERTS" "${profile.path}" 2>/dev/null; then
    # Check if it already points to the correct CA path
    if grep -q 'NODE_EXTRA_CA_CERTS="${caCertPath}"' "${profile.path}" 2>/dev/null || \\
       grep -q "NODE_EXTRA_CA_CERTS=\"\\\$HOME/.agent-vibes/certs/ca.pem\"" "${profile.path}" 2>/dev/null; then
      echo "✓ NODE_EXTRA_CA_CERTS already correctly configured in ${profile.name}"
    else
      # Replace existing NODE_EXTRA_CA_CERTS with the correct path
      grep -v 'NODE_EXTRA_CA_CERTS' "${profile.path}" > "${profile.path}.tmp" && mv "${profile.path}.tmp" "${profile.path}"
      echo "" >> "${profile.path}"
      echo "${marker}" >> "${profile.path}"
      echo '${exportLine}' >> "${profile.path}"
      echo "✓ Updated NODE_EXTRA_CA_CERTS in ${profile.name} to point to Agent Vibes CA"
    fi
  else
    echo "" >> "${profile.path}"
    echo "${marker}" >> "${profile.path}"
    echo '${exportLine}' >> "${profile.path}"
    echo "✓ Added NODE_EXTRA_CA_CERTS to ${profile.name}"
  fi
fi
`
    }

    return script
  }
}
