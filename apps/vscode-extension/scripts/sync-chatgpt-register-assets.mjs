import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const extensionRoot = path.resolve(__dirname, "..")
const repoRoot = path.resolve(extensionRoot, "..", "..")
const sourceRoot = path.join(repoRoot, "apps", "chatgpt-register")
const sourceDist = path.join(sourceRoot, "dist")
const sourcePackageJson = path.join(sourceRoot, "package.json")
const targetRoot = path.join(extensionRoot, "chatgpt-register")

if (!fs.existsSync(sourceRoot)) {
  throw new Error(`ChatGPT register app not found: ${sourceRoot}`)
}

if (!fs.existsSync(sourceDist)) {
  throw new Error(
    `ChatGPT register build output not found: ${sourceDist}. Run 'npm --workspace apps/chatgpt-register run build' first.`
  )
}

fs.rmSync(targetRoot, { recursive: true, force: true })
fs.mkdirSync(targetRoot, { recursive: true })

fs.cpSync(sourceDist, path.join(targetRoot, "dist"), {
  recursive: true,
  force: true,
})
fs.copyFileSync(sourcePackageJson, path.join(targetRoot, "package.json"))

const syncedFiles = []

function collectFiles(currentPath) {
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    const entryPath = path.join(currentPath, entry.name)
    if (entry.isDirectory()) {
      collectFiles(entryPath)
      continue
    }
    syncedFiles.push(path.relative(extensionRoot, entryPath))
  }
}

collectFiles(targetRoot)

console.log(
  [
    "Synced ChatGPT register assets",
    `source=${path.relative(repoRoot, sourceDist)}`,
    `target=${path.relative(repoRoot, targetRoot)}`,
    `files=${syncedFiles.length}`,
  ].join("\n")
)
