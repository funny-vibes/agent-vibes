import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const projectDir = path.resolve(__dirname, "..")
const distDir = path.join(projectDir, "dist")
const migrationsDir = path.join(distDir, "persistence", "migrations")
const outputPath = path.join(distDir, "sea-config.generated.json")

if (!fs.existsSync(migrationsDir)) {
  throw new Error(`Migrations directory not found: ${migrationsDir}`)
}

const migrationFiles = fs
  .readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort()

if (migrationFiles.length === 0) {
  throw new Error(`No SQL migrations found in ${migrationsDir}`)
}

const assets = Object.fromEntries(
  migrationFiles.map((file) => [file, `dist/persistence/migrations/${file}`])
)

const config = {
  main: "dist/sea-entry.js",
  output: "dist/sea-prep.blob",
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
  assets,
}

fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")

console.log(
  [
    `Generated SEA config: ${path.relative(projectDir, outputPath)}`,
    `Included migrations: ${migrationFiles.join(", ")}`,
  ].join("\n")
)
