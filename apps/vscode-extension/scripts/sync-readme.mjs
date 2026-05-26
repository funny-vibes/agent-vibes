import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const extensionRoot = path.resolve(__dirname, "..")
const repoRoot = path.resolve(extensionRoot, "..", "..")
const readmeEnPath = path.join(repoRoot, "README.md")
const extensionReadmePath = path.join(extensionRoot, "README.md")

if (!fs.existsSync(readmeEnPath)) {
  throw new Error(`README not found: ${readmeEnPath}`)
}

fs.copyFileSync(readmeEnPath, extensionReadmePath)

console.log(
  `Synced private README.md -> ${path.relative(repoRoot, extensionReadmePath)}`
)
