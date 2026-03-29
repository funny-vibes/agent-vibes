#!/usr/bin/env node
// TCP relay: forwards connections from LISTEN_IP:LISTEN_PORT to TARGET_IP:TARGET_PORT
// Used as a pf-free alternative for macOS loopback port forwarding.
// Usage: node tcp-relay.js <listen_ip> <listen_port> <target_ip> <target_port> <pid_file>

const net = require("net")
const fs = require("fs")

const os = require("os")
const path = require("path")

const LISTEN_IP = process.argv[2] || "127.0.0.2"
const LISTEN_PORT = parseInt(process.argv[3] || "443")
const TARGET_IP = process.argv[4] || "127.0.0.1"
const TARGET_PORT = parseInt(process.argv[5] || "8000")
const PID_FILE =
  process.argv[6] ||
  (process.platform === "win32"
    ? path.join(os.tmpdir(), "cursor-proxy-relay.pid")
    : "/tmp/cursor-proxy-relay.pid")

fs.writeFileSync(PID_FILE, String(process.pid))

const server = net.createServer((client) => {
  const upstream = net.createConnection(TARGET_PORT, TARGET_IP)
  client.pipe(upstream)
  upstream.pipe(client)
  client.on("error", () => upstream.destroy())
  upstream.on("error", () => client.destroy())
})

server.on("error", (err) => {
  console.error(`TCP relay error: ${err.message}`)
  cleanup()
  process.exit(1)
})

server.listen(LISTEN_PORT, LISTEN_IP, () => {
  console.log(
    `TCP relay started: ${LISTEN_IP}:${LISTEN_PORT} → ${TARGET_IP}:${TARGET_PORT} (pid ${process.pid})`
  )
})

function cleanup() {
  try {
    fs.unlinkSync(PID_FILE)
  } catch {
    // ignore
  }
}

process.on("SIGTERM", () => {
  server.close()
  cleanup()
  process.exit(0)
})
process.on("SIGINT", () => {
  server.close()
  cleanup()
  process.exit(0)
})
