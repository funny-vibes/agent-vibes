#!/usr/bin/env node

const { spawnSync } = require("node:child_process")
const path = require("node:path")

const ROOT = path.resolve(__dirname, "..", "..")

function parseArgs(argv) {
  const parsed = {
    source: "dev",
    target: "main",
    remote: "origin",
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      parsed.help = true
      continue
    }
    if ((arg === "--source" || arg === "-s") && argv[i + 1]) {
      parsed.source = argv[++i]
      continue
    }
    if ((arg === "--target" || arg === "-t") && argv[i + 1]) {
      parsed.target = argv[++i]
      continue
    }
    if ((arg === "--remote" || arg === "-r") && argv[i + 1]) {
      parsed.remote = argv[++i]
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return parsed
}

function printHelp() {
  console.log(`Usage: npm run release -- [--source dev] [--target main] [--remote origin]

Default behavior:
1. Ensure the worktree is clean
2. Update and push source branch
3. Switch to target branch
4. Merge source into target
5. Push target branch
6. Switch back to the branch you started on`)
}

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    if (options.allowFailure) {
      return {
        ok: false,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
      }
    }

    const detail =
      (result.stderr || result.stdout || "").trim() ||
      `git ${args.join(" ")} exited with code ${result.status}`
    throw new Error(detail)
  }

  return {
    ok: true,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  }
}

function gitOutput(args) {
  return runGit(args, { capture: true }).stdout.trim()
}

function currentBranch() {
  return gitOutput(["branch", "--show-current"])
}

function hasMergeInProgress() {
  return runGit(["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
    capture: true,
    allowFailure: true,
  }).ok
}

function ensureCleanWorktree() {
  const status = gitOutput(["status", "--porcelain"])
  if (status) {
    throw new Error(
      "Working tree is not clean. Commit or stash your changes before running merge:main."
    )
  }
}

function step(message) {
  console.log(`\n> ${message}`)
}

function switchBranch(branch, options = {}) {
  runGit(["switch", branch], options)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const { source, target, remote } = args
  const startingBranch = currentBranch()

  if (!startingBranch) {
    throw new Error("Failed to determine the current branch.")
  }

  ensureCleanWorktree()

  try {
    step(`Fetching ${remote}/${source} and ${remote}/${target}`)
    runGit(["fetch", remote, source, target])

    if (currentBranch() !== source) {
      step(`Switching to ${source}`)
      switchBranch(source)
    }

    step(`Updating ${source}`)
    runGit(["pull", "--ff-only", remote, source])

    step(`Pushing ${source}`)
    runGit(["push", remote, source])

    step(`Switching to ${target}`)
    switchBranch(target)

    step(`Updating ${target}`)
    runGit(["pull", "--ff-only", remote, target])

    step(`Merging ${source} into ${target}`)
    runGit(["merge", source, "--no-edit"])

    step(`Pushing ${target}`)
    runGit(["push", remote, target])

    console.log(
      `\nMerged ${source} into ${target}, pushed both branches, and restored your branch.`
    )
  } catch (error) {
    if (hasMergeInProgress()) {
      step("Merge failed, aborting in-progress merge")
      runGit(["merge", "--abort"], { allowFailure: true })
    }
    throw error
  } finally {
    const branchAfterRun = currentBranch()
    if (branchAfterRun && branchAfterRun !== startingBranch) {
      step(`Switching back to ${startingBranch}`)
      switchBranch(startingBranch, { allowFailure: true })
    }
  }
}

try {
  main()
} catch (error) {
  console.error(
    `\nrelease failed: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exit(1)
}
