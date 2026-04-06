import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const extensionRoot = path.resolve(__dirname, "..")
const repoRoot = path.resolve(extensionRoot, "..", "..")
const protocolBridgeRoot = path.join(repoRoot, "apps", "protocol-bridge")
const verifyOnly = process.argv.includes("--verify-only")
const allPlatforms = process.argv.includes("--all-platforms")
const distDir = path.join(protocolBridgeRoot, "dist")
const sourceWorker = path.join(
  protocolBridgeRoot,
  "src",
  "llm",
  "native",
  "worker.js"
)

const supportedTargets = [
  {
    target: "darwin-arm64",
    exe: "",
    aliases: ["darwin-arm64"],
  },
  {
    target: "darwin-x64",
    exe: "",
    aliases: ["darwin-x64", "darwin-x86_64"],
  },
  {
    target: "linux-x64",
    exe: "",
    aliases: ["linux-x64", "linux-x86_64"],
  },
  {
    target: "win32-x64",
    exe: ".exe",
    aliases: ["win32-x64", "win32-x86_64", "windows-x64", "windows-x86_64"],
  },
]

if (!fs.existsSync(sourceWorker)) {
  throw new Error(`Native worker script not found: ${sourceWorker}`)
}

// Determine which platforms to check
const currentPlatform = `${process.platform}-${process.arch}`
const requiredTargets = allPlatforms
  ? supportedTargets
  : supportedTargets.filter((t) => t.target === currentPlatform)

function findSourceBinary(aliases) {
  for (const alias of aliases) {
    const candidates = [
      path.join(distDir, `agent-vibes-bridge-${alias}`),
      path.join(distDir, `agent-vibes-bridge-${alias}.exe`),
    ]

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
  }

  return null
}

const syncedTargets = []
const missingTargets = []

for (const entry of supportedTargets) {
  const bridgeDir = path.join(extensionRoot, "bridge", entry.target)
  const targetBinary = path.join(bridgeDir, `agent-vibes-bridge${entry.exe}`)
  const targetWorker = path.join(bridgeDir, "worker.js")
  const sourceBinary = findSourceBinary(entry.aliases)
  const hasExistingBinary = fs.existsSync(targetBinary)

  if (!verifyOnly && (sourceBinary || hasExistingBinary)) {
    fs.mkdirSync(bridgeDir, { recursive: true })

    if (sourceBinary) {
      fs.copyFileSync(sourceBinary, targetBinary)
    }
    fs.copyFileSync(sourceWorker, targetWorker)

    if (!entry.exe) {
      fs.chmodSync(targetBinary, 0o755)
    }

    syncedTargets.push({
      target: entry.target,
      sourceBinary: sourceBinary || targetBinary,
      targetBinary,
      targetWorker,
    })
  }

  // Only track missing for required targets
  const isRequired = requiredTargets.some((t) => t.target === entry.target)
  if (
    isRequired &&
    (!fs.existsSync(targetBinary) || !fs.existsSync(targetWorker))
  ) {
    missingTargets.push(entry.target)
  }
}

if (missingTargets.length > 0) {
  const hint = allPlatforms
    ? "CI builds must include every supported platform binary."
    : `Run 'npm run build:bridge && npm run sync:bridge' to build for ${currentPlatform}.`
  throw new Error(
    `Missing bridge assets for: ${missingTargets.join(", ")}. ${hint}`
  )
}

const platformLabel = allPlatforms
  ? "all supported platforms"
  : `current platform (${currentPlatform})`

console.log(
  [
    verifyOnly
      ? `Verified bridge assets for ${platformLabel}`
      : `Synced bridge assets for ${syncedTargets.length} platform(s)`,
    ...syncedTargets.map(
      ({ target, sourceBinary, targetBinary, targetWorker }) =>
        [
          `target=${target}`,
          `sourceBinary=${path.relative(repoRoot, sourceBinary)}`,
          `targetBinary=${path.relative(repoRoot, targetBinary)}`,
          `targetWorker=${path.relative(repoRoot, targetWorker)}`,
          `binarySize=${(fs.statSync(targetBinary).size / (1024 * 1024)).toFixed(2)} MB`,
        ].join("\n")
    ),
    `host=${os.hostname()}`,
  ].join("\n")
)
