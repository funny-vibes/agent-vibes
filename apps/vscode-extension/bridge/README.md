# Bridge Binaries

This directory contains pre-compiled Protocol Bridge SEA (Single Executable Application) binaries for each supported platform.

## Directory Structure

```text
bridge/
├── darwin-arm64/agent-vibes-bridge    # macOS Apple Silicon
├── darwin-x64/agent-vibes-bridge      # macOS Intel
├── linux-x64/agent-vibes-bridge       # Linux x64
└── win32-x64/agent-vibes-bridge.exe   # Windows x64
```

## Building

These binaries are built by the CI pipeline using Node.js SEA (`--build-sea`).
See the root CI workflow for build instructions.

## Development Fallback

When no SEA binary is found, the extension falls back to running
`apps/protocol-bridge/dist/main.js` using the current Node.js runtime.
