import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const extensionRoot = path.resolve(__dirname, "..")
const repoRoot = path.resolve(extensionRoot, "..", "..")

const source = path.join(repoRoot, "README.md")
const target = path.join(extensionRoot, "README.md")

if (!fs.existsSync(source)) {
  throw new Error(`Root README.md not found: ${source}`)
}

fs.copyFileSync(source, target)
console.log(`Synced README.md → ${path.relative(repoRoot, target)}`)
