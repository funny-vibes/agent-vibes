#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_URL="${OPENAI_COMPAT_BASE_URL:-${SKYLINK_BASE_URL:-https://skylink-gateway.com/api/v1}}"
API_KEY="${OPENAI_COMPAT_API_KEY:-${SKYLINK_API_KEY:-}}"
RESPONSES_MODE="${OPENAI_COMPAT_USE_RESPONSES_API:-always}"
SERVICE_TIER="${OPENAI_COMPAT_SERVICE_TIER:-priority}"
MAX_CONTEXT_TOKENS="${OPENAI_COMPAT_MAX_CONTEXT_TOKENS:-200000}"

usage() {
  cat <<'EOF'
Install Agent Vibes self-managed Cursor Agent gateway.

Required:
  SKYLINK_API_KEY=sk-... scripts/self-managed/install-self-managed.sh

Options:
  --api-key KEY
  --base-url URL
  --responses-mode auto|always|never
  --service-tier priority|default
  --no-fast
  --max-context-tokens N
  --skip-build
  --skip-cert
  --skip-route

Environment:
  SKYLINK_API_KEY or OPENAI_COMPAT_API_KEY
  SKYLINK_BASE_URL or OPENAI_COMPAT_BASE_URL
  OPENAI_COMPAT_USE_RESPONSES_API
  OPENAI_COMPAT_SERVICE_TIER
EOF
}

EXTRA_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-key)
      API_KEY="${2:-}"
      shift 2
      ;;
    --api-key=*)
      API_KEY="${1#*=}"
      shift
      ;;
    --base-url)
      BASE_URL="${2:-}"
      shift 2
      ;;
    --base-url=*)
      BASE_URL="${1#*=}"
      shift
      ;;
    --responses-mode)
      RESPONSES_MODE="${2:-}"
      shift 2
      ;;
    --responses-mode=*)
      RESPONSES_MODE="${1#*=}"
      shift
      ;;
    --service-tier)
      SERVICE_TIER="${2:-}"
      shift 2
      ;;
    --service-tier=*)
      SERVICE_TIER="${1#*=}"
      shift
      ;;
    --no-fast)
      SERVICE_TIER=""
      EXTRA_ARGS+=("--no-fast")
      shift
      ;;
    --max-context-tokens)
      MAX_CONTEXT_TOKENS="${2:-}"
      shift 2
      ;;
    --max-context-tokens=*)
      MAX_CONTEXT_TOKENS="${1#*=}"
      shift
      ;;
    --skip-build|--skip-cert|--skip-route)
      EXTRA_ARGS+=("$1")
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$API_KEY" ]]; then
  echo "Missing API key. Set SKYLINK_API_KEY or pass --api-key." >&2
  exit 1
fi

command -v node >/dev/null 2>&1 || {
  echo "node is required. Install Node.js 24+ first." >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "npm is required. Install npm 11+ first." >&2
  exit 1
}

cd "$ROOT"

npm install

INSTALL_ARGS=(
  "self-managed"
  "install"
  "--base-url"
  "$BASE_URL"
  "--api-key"
  "$API_KEY"
  "--responses-mode"
  "$RESPONSES_MODE"
  "--prefer-responses"
  "--max-context-tokens"
  "$MAX_CONTEXT_TOKENS"
)

if [[ -n "$SERVICE_TIER" ]]; then
  INSTALL_ARGS+=("--service-tier" "$SERVICE_TIER")
fi
INSTALL_ARGS+=("${EXTRA_ARGS[@]}")

node ./bin/agent-vibes "${INSTALL_ARGS[@]}"

cat <<'EOF'

Done.
Fully quit and restart Cursor, then select gpt-5.5 xHigh in the Agent panel.
Check status with:
  node ./bin/agent-vibes self-managed status
EOF
