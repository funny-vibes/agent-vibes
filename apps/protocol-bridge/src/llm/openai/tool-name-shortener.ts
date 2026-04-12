/**
 * Tool Name Shortener for Codex API
 *
 * Codex (OpenAI Responses API) limits tool names to 64 characters.
 * This module provides utilities to shorten tool names while preserving
 * uniqueness and supporting reverse mapping for response translation.
 *
 * Ported from CLIProxyAPI: internal/translator/codex/claude/codex_claude_request.go
 */

const TOOL_NAME_LIMIT = 64

/**
 * Shorten a single tool name if it exceeds the 64-character limit.
 * For MCP tools (prefixed with "mcp__"), preserves the prefix and last segment.
 */
export function shortenNameIfNeeded(name: string): string {
  if (name.length <= TOOL_NAME_LIMIT) {
    return name
  }
  if (name.startsWith("mcp__")) {
    const idx = name.lastIndexOf("__")
    if (idx > 0) {
      const candidate = "mcp__" + name.slice(idx + 2)
      if (candidate.length > TOOL_NAME_LIMIT) {
        return candidate.slice(0, TOOL_NAME_LIMIT)
      }
      return candidate
    }
  }
  return name.slice(0, TOOL_NAME_LIMIT)
}

/**
 * Build a map of original tool names to unique shortened names.
 * Ensures uniqueness by appending suffixes like "_1", "_2" when collisions occur.
 */
export function buildShortNameMap(names: string[]): Map<string, string> {
  const used = new Set<string>()
  const m = new Map<string, string>()

  const baseCandidate = (n: string): string => {
    if (n.length <= TOOL_NAME_LIMIT) {
      return n
    }
    if (n.startsWith("mcp__")) {
      const idx = n.lastIndexOf("__")
      if (idx > 0) {
        let cand = "mcp__" + n.slice(idx + 2)
        if (cand.length > TOOL_NAME_LIMIT) {
          cand = cand.slice(0, TOOL_NAME_LIMIT)
        }
        return cand
      }
    }
    return n.slice(0, TOOL_NAME_LIMIT)
  }

  const makeUnique = (cand: string): string => {
    if (!used.has(cand)) {
      return cand
    }
    const base = cand
    for (let i = 1; ; i++) {
      const suffix = "_" + i.toString()
      let allowed = TOOL_NAME_LIMIT - suffix.length
      if (allowed < 0) allowed = 0
      let tmp = base
      if (tmp.length > allowed) {
        tmp = tmp.slice(0, allowed)
      }
      tmp = tmp + suffix
      if (!used.has(tmp)) {
        return tmp
      }
    }
  }

  for (const n of names) {
    const cand = baseCandidate(n)
    const uniq = makeUnique(cand)
    used.add(uniq)
    m.set(n, uniq)
  }
  return m
}

/**
 * Build a reverse map from shortened names back to original names.
 * Used during response translation to restore original tool names.
 */
export function buildReverseMap(
  shortMap: Map<string, string>
): Map<string, string> {
  const rev = new Map<string, string>()
  for (const [original, short] of shortMap) {
    rev.set(short, original)
  }
  return rev
}

/**
 * Build a reverse map from Claude request tools.
 * Extracts tool names from the original Claude request and builds
 * short→original mapping for response translation.
 */
export function buildReverseMapFromClaudeTools(
  tools: Array<{ name?: string; type?: string }> | undefined
): Map<string, string> {
  if (!tools || tools.length === 0) {
    return new Map()
  }
  const names: string[] = []
  for (const tool of tools) {
    if (tool.name) {
      names.push(tool.name)
    }
  }
  if (names.length === 0) {
    return new Map()
  }
  const shortMap = buildShortNameMap(names)
  return buildReverseMap(shortMap)
}
