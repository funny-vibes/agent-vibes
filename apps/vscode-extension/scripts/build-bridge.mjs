/**
 * Cross-platform wrapper for building the Protocol Bridge SEA binary.
 * Delegates to build-sea.sh on Unix or runs the equivalent PowerShell steps on Windows.
 */
import { execFileSync } from "child_process"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const bridgeDir = path.resolve(__dirname, "..", "..", "protocol-bridge")

if (process.platform === "win32") {
  // PowerShell equivalent of build-sea.sh
  const script = [
    `Set-Location "${bridgeDir}"`,
    "node sea/esbuild.js",
    '$srcMigrations = "src\\persistence\\migrations"',
    '$dstMigrations = "dist\\persistence\\migrations"',
    "New-Item -ItemType Directory -Force -Path $dstMigrations | Out-Null",
    'Copy-Item "$srcMigrations\\*.sql" $dstMigrations -Force',
    "node sea/generate-config.mjs",
    "node --experimental-sea-config dist/sea-config.generated.json",
    "$nodeBin = (Get-Command node).Source",
    '$binaryName = "agent-vibes-bridge-win32-x64.exe"',
    'Copy-Item $nodeBin "dist\\$binaryName"',
    'npx -y postject "dist\\$binaryName" NODE_SEA_BLOB dist\\sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    '$size = [math]::Round((Get-Item "dist\\$binaryName").Length / 1MB)',
    'Write-Host "SEA binary ready: dist\\$binaryName (${size}MB)"',
  ].join("; ")

  execFileSync("pwsh", ["-NoProfile", "-Command", script], {
    stdio: "inherit",
    cwd: bridgeDir,
  })
} else {
  execFileSync("bash", [path.join(bridgeDir, "sea", "build.sh"), "--clean"], {
    stdio: "inherit",
    cwd: bridgeDir,
  })
}
