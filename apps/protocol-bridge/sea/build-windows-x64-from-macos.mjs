#!/usr/bin/env node
import { execFileSync } from "child_process"
import fs from "fs"
import https from "https"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { createHash } from "crypto"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectDir = path.resolve(__dirname, "..")
const repoRoot = path.resolve(projectDir, "..", "..")
const distDir = path.join(projectDir, "dist")
const sourceMigrationsDir = path.join(
  projectDir,
  "src",
  "persistence",
  "migrations"
)
const distMigrationsDir = path.join(distDir, "persistence", "migrations")
const target = "win32-x64"
const binaryName = `agent-vibes-bridge-${target}.exe`
const outputBinary = path.join(distDir, binaryName)
const nodeVersion = process.env.CCURSOR_WINDOWS_NODE_VERSION || "v24.11.1"
const nodeArchive = `node-${nodeVersion}-win-x64`
const nodeZipName = `${nodeArchive}.zip`
const nodeDownloadUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeZipName}`
const cacheDir = path.join(repoRoot, ".cache", "node-windows")
const cacheZipPath = path.join(cacheDir, nodeZipName)
const extractDir = path.join(cacheDir, nodeArchive)
const nodeExe = path.join(extractDir, "node.exe")

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: projectDir,
    stdio: "inherit",
    ...options,
  })
}

function download(url, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })

  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume()
        download(
          new URL(response.headers.location, url).toString(),
          destination
        )
          .then(resolve)
          .catch(reject)
        return
      }

      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`Download failed: HTTP ${response.statusCode}`))
        return
      }

      const file = fs.createWriteStream(destination)
      response.pipe(file)
      file.on("finish", () => {
        file.close(resolve)
      })
      file.on("error", reject)
    })

    request.on("error", reject)
  })
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

async function ensureWindowsNode() {
  if (fs.existsSync(nodeExe)) return

  if (!fs.existsSync(cacheZipPath)) {
    console.log(`Downloading Windows Node.js runtime: ${nodeDownloadUrl}`)
    await download(nodeDownloadUrl, cacheZipPath)
    console.log(`Downloaded ${cacheZipPath}`)
  }

  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.mkdirSync(cacheDir, { recursive: true })
  run("ditto", ["-x", "-k", cacheZipPath, cacheDir], { cwd: repoRoot })

  if (!fs.existsSync(nodeExe)) {
    throw new Error(`Expected Windows node.exe not found: ${nodeExe}`)
  }
}

function syncMigrationAssets() {
  if (!fs.existsSync(sourceMigrationsDir)) {
    throw new Error(
      `Missing source migrations directory: ${sourceMigrationsDir}`
    )
  }

  fs.mkdirSync(distMigrationsDir, { recursive: true })
  for (const file of fs.readdirSync(distMigrationsDir)) {
    if (file.endsWith(".sql")) {
      fs.rmSync(path.join(distMigrationsDir, file), { force: true })
    }
  }

  const migrations = fs
    .readdirSync(sourceMigrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()

  if (migrations.length === 0) {
    throw new Error(`No SQL migrations found in ${sourceMigrationsDir}`)
  }

  for (const file of migrations) {
    fs.copyFileSync(
      path.join(sourceMigrationsDir, file),
      path.join(distMigrationsDir, file)
    )
  }

  console.log(`Synced ${migrations.length} migration(s)`)
}

console.log(`Building Protocol Bridge SEA binary for ${target}`)
console.log(`Host: ${process.platform}-${process.arch}`)
console.log(`Node runtime: ${nodeVersion}`)

if (process.platform !== "darwin") {
  throw new Error("This helper is intended for macOS hosts")
}

await ensureWindowsNode()

console.log("Bundling bridge entry...")
run("node", [path.join(projectDir, "sea", "esbuild.js")])

console.log("Syncing migration assets...")
syncMigrationAssets()

console.log("Generating SEA config and blob...")
run("node", [path.join(projectDir, "sea", "generate-config.mjs")])
run("node", ["--experimental-sea-config", "dist/sea-config.generated.json"])

console.log("Injecting SEA blob into Windows node.exe...")
fs.copyFileSync(nodeExe, outputBinary)
run("npx", [
  "-y",
  "postject",
  outputBinary,
  "NODE_SEA_BLOB",
  path.join(distDir, "sea-prep.blob"),
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
])

const sizeMb = fs.statSync(outputBinary).size / (1024 * 1024)
console.log(
  [
    `Windows SEA binary ready: ${path.relative(repoRoot, outputBinary)}`,
    `Size: ${sizeMb.toFixed(2)} MB`,
    `SHA256: ${sha256(outputBinary)}`,
    `Temp: ${os.tmpdir()}`,
  ].join("\n")
)
