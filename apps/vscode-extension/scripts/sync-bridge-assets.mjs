import { execFileSync } from "child_process"
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
const sourceGoWorkerDir = path.join(
  protocolBridgeRoot,
  "src",
  "llm",
  "google",
  "go-worker"
)

const supportedTargets = [
  {
    target: "darwin-arm64",
    exe: "",
    goos: "darwin",
    goarch: "arm64",
    aliases: ["darwin-arm64"],
  },
  {
    target: "darwin-x64",
    exe: "",
    goos: "darwin",
    goarch: "amd64",
    aliases: ["darwin-x64", "darwin-x86_64"],
  },
  {
    target: "linux-x64",
    exe: "",
    goos: "linux",
    goarch: "amd64",
    aliases: ["linux-x64", "linux-x86_64"],
  },
  {
    target: "win32-x64",
    exe: ".exe",
    goos: "windows",
    goarch: "amd64",
    aliases: ["win32-x64", "win32-x86_64", "windows-x64", "windows-x86_64"],
  },
]

if (!fs.existsSync(sourceGoWorkerDir)) {
  throw new Error(`Go worker assets not found: ${sourceGoWorkerDir}`)
}

const requiredGoWorkerFiles = ["go.mod", "go.sum", "main.go"]
for (const file of requiredGoWorkerFiles) {
  if (!fs.existsSync(path.join(sourceGoWorkerDir, file))) {
    throw new Error(
      `Go worker source missing: ${path.join(sourceGoWorkerDir, file)}`
    )
  }
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

function buildBundledGoWorker(targetDir, entry) {
  const outputBinary = path.join(
    targetDir,
    `agent-vibes-google-go-worker${entry.exe}`
  )
  execFileSync("go", ["build", "-o", outputBinary, "."], {
    cwd: targetDir,
    stdio: "pipe",
    env: {
      ...process.env,
      GOOS: entry.goos,
      GOARCH: entry.goarch,
      CGO_ENABLED: "0",
    },
  })
  if (!entry.exe) {
    fs.chmodSync(outputBinary, 0o755)
  }
  return outputBinary
}

const syncedTargets = []
const missingTargets = []

for (const entry of supportedTargets) {
  const bridgeDir = path.join(extensionRoot, "bridge", entry.target)
  const targetBinary = path.join(bridgeDir, `agent-vibes-bridge${entry.exe}`)
  const targetGoWorkerDir = path.join(bridgeDir, "go-worker")
  const sourceBinary = findSourceBinary(entry.aliases)
  const hasExistingBinary = fs.existsSync(targetBinary)

  if (!verifyOnly) {
    // Always sync go-worker for every supported target since Go can
    // cross-compile (CGO_ENABLED=0).  The bridge binary is only copied
    // when a source or pre-existing binary is available.
    const hasBridgeBinary = sourceBinary || hasExistingBinary

    if (hasBridgeBinary || allPlatforms) {
      fs.mkdirSync(bridgeDir, { recursive: true })

      if (sourceBinary) {
        fs.copyFileSync(sourceBinary, targetBinary)
      }
    }

    // Sync go-worker independently: the directory only needs the Go
    // source tree and a cross-compiled binary, both of which can be
    // produced on any host.
    if (hasBridgeBinary || allPlatforms) {
      fs.rmSync(targetGoWorkerDir, { recursive: true, force: true })
      fs.cpSync(sourceGoWorkerDir, targetGoWorkerDir, {
        recursive: true,
        filter: (src) =>
          !/^agent-vibes-google-go-worker(?:\.exe)?$/.test(path.basename(src)),
      })
      const bundledGoWorkerBinary = buildBundledGoWorker(
        targetGoWorkerDir,
        entry
      )

      if (hasBridgeBinary && !entry.exe) {
        fs.chmodSync(targetBinary, 0o755)
      }

      syncedTargets.push({
        target: entry.target,
        sourceBinary: sourceBinary || targetBinary,
        targetBinary,
        targetGoWorkerDir,
        bundledGoWorkerBinary,
      })
    }
  }

  // Only track missing for required targets
  const isRequired = requiredTargets.some((t) => t.target === entry.target)
  if (
    isRequired &&
    (!fs.existsSync(targetBinary) ||
      !fs.existsSync(path.join(targetGoWorkerDir, "go.mod")) ||
      !fs.existsSync(path.join(targetGoWorkerDir, "go.sum")) ||
      !fs.existsSync(path.join(targetGoWorkerDir, "main.go")))
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
      ({
        target,
        sourceBinary,
        targetBinary,
        targetGoWorkerDir,
        bundledGoWorkerBinary,
      }) =>
        [
          `target=${target}`,
          `sourceBinary=${path.relative(repoRoot, sourceBinary)}`,
          `targetBinary=${path.relative(repoRoot, targetBinary)}`,
          `targetGoWorker=${path.relative(repoRoot, targetGoWorkerDir)}`,
          `bundledGoWorkerBinary=${path.relative(repoRoot, bundledGoWorkerBinary)}`,
          `binarySize=${(fs.statSync(targetBinary).size / (1024 * 1024)).toFixed(2)} MB`,
        ].join("\n")
    ),
    `host=${os.hostname()}`,
  ].join("\n")
)
