import fs from "node:fs"
import path from "node:path"

/** Only actual executables in this extension family, never a shell's arguments. */
export function managedBridgeProcesses(
  psOutput,
  { extensionsRoot, publisher, extensionName, target }
) {
  const processes = new Map()
  for (const line of psOutput.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!match) continue
    const relative = path.relative(extensionsRoot, match[2])
    const parts = relative.split(path.sep)
    if (
      parts.length === 4 &&
      parts[0].startsWith(`${publisher}.${extensionName}-`) &&
      parts[1] === "bridge" &&
      parts[2] === target &&
      parts[3] === "agent-vibes-bridge"
    ) {
      processes.set(Number(match[1]), match[2])
    }
  }
  return processes
}

/** Linux comm is only a process name; /proc supplies the executable identity. */
export function managedLinuxBridgeProcesses(candidatePids, options) {
  const executables = []
  for (const pid of new Set(candidatePids)) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    try {
      // An extension upgrade may unlink the executable while it is still running.
      const executable = fs
        .readlinkSync(`/proc/${pid}/exe`)
        .replace(/ \(deleted\)$/, "")
      executables.push(`${pid} ${executable}`)
    } catch (error) {
      // A process can exit between the listener/PID lookup and readlink.
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error
    }
  }
  return managedBridgeProcesses(executables.join("\n"), options)
}

export function selectBridgePids(processes, listeningPids, pidFilePid) {
  const candidates = new Set([
    ...listeningPids,
    ...(pidFilePid ? [pidFilePid] : []),
  ])
  return [...candidates].filter((pid) => processes.has(pid))
}

export function healthMatchesChild(statusCode, pid, alive, listeningPids) {
  return statusCode === 200 && alive && listeningPids.includes(pid)
}
