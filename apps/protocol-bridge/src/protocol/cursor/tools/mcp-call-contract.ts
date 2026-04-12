import { McpToolDef } from "./cursor-request-parser"

export interface ResolvedMcpCallFields {
  name: string
  toolName: string
  providerIdentifier: string
  rawArgs: Record<string, unknown>
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function pickFirstString(
  source: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = asString(source[key]).trim()
    if (value) return value
  }
  return undefined
}

function composeMcpName(providerIdentifier: string, toolName: string): string {
  const normalizedToolName = toolName.trim()
  if (!normalizedToolName) return ""

  const normalizedProvider = providerIdentifier.trim()
  if (!normalizedProvider) return normalizedToolName

  const compactTool = normalizeMcpToolIdentifier(normalizedToolName)
  const compactProvider = normalizeMcpToolIdentifier(normalizedProvider)
  if (compactProvider && compactTool.startsWith(compactProvider)) {
    return normalizedToolName
  }

  return `${normalizedProvider}-${normalizedToolName}`
}

function extractToolNameFromComposedName(
  name: string,
  providerIdentifier: string
): string {
  const normalizedName = name.trim()
  if (!normalizedName) return ""

  const normalizedProvider = providerIdentifier.trim()
  if (!normalizedProvider) return normalizedName

  const providerPrefix = `${normalizedProvider}-`
  if (
    normalizedName.length > providerPrefix.length &&
    normalizedName.toLowerCase().startsWith(providerPrefix.toLowerCase())
  ) {
    return normalizedName.slice(providerPrefix.length)
  }

  return normalizedName
}

export function normalizeMcpToolIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

export function resolveMcpToolDefinition(
  defs: McpToolDef[] | undefined,
  toolName: string
): McpToolDef | undefined {
  if (!defs || defs.length === 0) return undefined

  const normalizedRequested = normalizeMcpToolIdentifier(toolName)
  for (const def of defs) {
    if (!def || typeof def.name !== "string") continue
    if (def.name === toolName) return def

    const normalizedDefName = normalizeMcpToolIdentifier(def.name)
    if (normalizedDefName === normalizedRequested) {
      return def
    }

    if (typeof def.toolName === "string" && def.toolName.length > 0) {
      const normalizedToolName = normalizeMcpToolIdentifier(def.toolName)
      if (normalizedToolName === normalizedRequested) {
        return def
      }
    }
  }

  return undefined
}

export function extractMcpRawArguments(
  input: Record<string, unknown>
): Record<string, unknown> {
  return asRecord(input.arguments) || asRecord(input.args) || input
}

export function buildMcpDispatchInput(
  input: Record<string, unknown>,
  mcpToolDef: McpToolDef
): Record<string, unknown> {
  const declaredToolName =
    typeof mcpToolDef.name === "string" ? mcpToolDef.name.trim() : ""
  if (!declaredToolName) {
    throw new Error("Invalid MCP tool definition: missing name")
  }

  const rawArgs = extractMcpRawArguments(input)

  const name = pickFirstString(input, ["name"]) || declaredToolName
  if (!name) {
    throw new Error("Invalid MCP dispatch input: missing args.name")
  }
  const toolName =
    pickFirstString(input, ["toolName", "tool_name"]) ||
    (typeof mcpToolDef.toolName === "string"
      ? mcpToolDef.toolName.trim()
      : "") ||
    declaredToolName
  if (!toolName) {
    throw new Error(
      "Invalid MCP dispatch input: missing args.toolName/tool_name"
    )
  }
  const providerIdentifier =
    pickFirstString(input, [
      "providerIdentifier",
      "provider_identifier",
      "serverName",
      "server_name",
    ]) ||
    mcpToolDef.providerIdentifier ||
    ""

  return {
    ...input,
    name,
    toolName,
    providerIdentifier,
    arguments: rawArgs,
  }
}

export function resolveMcpCallFields(
  args: Record<string, unknown>
): ResolvedMcpCallFields {
  const serverName =
    pickFirstString(args, ["serverName", "server_name", "provider"]) || ""
  const providerIdentifier =
    pickFirstString(args, ["providerIdentifier", "provider_identifier"]) ||
    serverName

  const explicitName = pickFirstString(args, ["name"])
  const explicitToolName = pickFirstString(args, ["toolName", "tool_name"])
  const aliasTool = pickFirstString(args, ["tool"])

  let toolName =
    explicitToolName ||
    (explicitName
      ? extractToolNameFromComposedName(explicitName, providerIdentifier)
      : "") ||
    aliasTool ||
    ""

  let name =
    explicitName ||
    (toolName ? composeMcpName(providerIdentifier, toolName) : "")

  if (!name && aliasTool) {
    name = composeMcpName(providerIdentifier, aliasTool)
  }
  if (!toolName && name) {
    toolName = extractToolNameFromComposedName(name, providerIdentifier)
  }

  if (!name || !toolName) {
    throw new Error(
      `Invalid MCP args: name/toolName unresolved (received name="${explicitName || ""}", toolName="${explicitToolName || ""}")`
    )
  }

  return {
    name,
    toolName,
    providerIdentifier,
    rawArgs: extractMcpRawArguments(args),
  }
}
