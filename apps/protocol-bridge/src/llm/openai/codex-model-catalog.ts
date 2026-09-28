import { CODEX_MODEL_INSTRUCTION_CATALOG } from "./codex-model-instructions.generated"

/** Immutable provider model facts. UI, request encoding and history use this same contract. */
export interface CodexModelProfile {
  slug: string
  display_name: string
  visibility: string
  priority: number
  context_window?: number
  max_context_window?: number
  comp_hash?: string | null
  auto_compact_token_limit?: number | null
  default_reasoning_level?: string
  supported_reasoning_levels: readonly {
    effort: string
    description?: string
  }[]
  multi_agent_reasoning_effort?: string | null
  use_responses_lite: boolean
  supports_reasoning_summaries: boolean
  supports_reasoning_summary_parameter: boolean
  supports_parallel_tool_calls: boolean
  supports_image_detail_original: boolean
  input_modalities: readonly string[]
  support_verbosity: boolean
  default_verbosity?: string | null
  service_tiers: readonly { id: string }[]
  available_in_plans: readonly string[]
  truncation_policy: { mode: "bytes" | "tokens"; limit: number }
  minimal_client_version?: [number, number, number]
  [key: string]: unknown
}

export function parseCodexModelProfile(value: unknown): CodexModelProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex model profile must be an object")
  }
  const raw = value as Record<string, unknown>
  // ModelInfo omits serde-default fields on the wire. The extra capability
  // hints in models.json are not required fields of the /models response.
  const normalized: Record<string, unknown> = {
    service_tiers: [],
    use_responses_lite: false,
    supports_reasoning_summary_parameter: true,
    supports_image_detail_original: false,
    input_modalities: ["text", "image"],
    supports_reasoning_summaries: true,
    supports_parallel_tool_calls: true,
    available_in_plans: [],
    ...raw,
    context_window: raw.context_window ?? raw.max_context_window ?? undefined,
    max_context_window:
      raw.max_context_window ?? raw.context_window ?? undefined,
    default_reasoning_level: raw.default_reasoning_level ?? undefined,
  }
  const p = normalized as CodexModelProfile
  if (
    typeof p.slug !== "string" ||
    !p.slug ||
    p.slug.trim() !== p.slug ||
    typeof p.display_name !== "string" ||
    !["list", "hide", "none"].includes(p.visibility) ||
    !Number.isSafeInteger(p.priority) ||
    (p.context_window !== undefined &&
      (!Number.isSafeInteger(p.context_window) || p.context_window <= 0)) ||
    (p.max_context_window !== undefined &&
      (!Number.isSafeInteger(p.max_context_window) ||
        p.max_context_window <= 0)) ||
    !Array.isArray(p.supported_reasoning_levels) ||
    !p.supported_reasoning_levels.every(
      (x: unknown) =>
        !!x &&
        typeof x === "object" &&
        typeof (x as Record<string, unknown>).effort === "string" &&
        String((x as Record<string, unknown>).effort).length > 0
    ) ||
    !Array.isArray(p.input_modalities) ||
    !Array.isArray(p.service_tiers) ||
    !Array.isArray(p.available_in_plans) ||
    typeof p.use_responses_lite !== "boolean" ||
    (p.default_reasoning_level !== undefined &&
      typeof p.default_reasoning_level !== "string") ||
    !p.input_modalities.every((x) => typeof x === "string") ||
    !p.available_in_plans.every((x) => typeof x === "string") ||
    !p.service_tiers.every(
      (x: unknown) =>
        !!x &&
        typeof x === "object" &&
        typeof (x as Record<string, unknown>).id === "string"
    ) ||
    (p.comp_hash != null && typeof p.comp_hash !== "string") ||
    (p.auto_compact_token_limit != null &&
      (!Number.isSafeInteger(p.auto_compact_token_limit) ||
        p.auto_compact_token_limit <= 0)) ||
    ![
      p.support_verbosity,
      p.supports_parallel_tool_calls,
      p.supports_reasoning_summaries,
      p.supports_reasoning_summary_parameter,
      p.supports_image_detail_original,
    ].every((x) => typeof x === "boolean") ||
    !p.truncation_policy ||
    !Number.isFinite(p.truncation_policy.limit) ||
    p.truncation_policy.limit < 0 ||
    !["bytes", "tokens"].includes(p.truncation_policy.mode)
  ) {
    throw new Error("Codex model catalog contains an invalid model profile")
  }
  return freezeProfile(structuredClone(p))
}

function freezeProfile<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeProfile(child)
    Object.freeze(value)
  }
  return value
}

const bundled = new Map<string, CodexModelProfile>(
  Object.values(CODEX_MODEL_INSTRUCTION_CATALOG).map((entry) => {
    const profile = parseCodexModelProfile(entry.profile)
    return [profile.slug, profile]
  })
)

/** Remote catalogs are account/provider scoped; account availability never leaks to another slot. */
const remote = new Map<string, ReadonlyMap<string, CodexModelProfile>>()

export function installCodexModelCatalog(
  scope: string,
  models: readonly unknown[]
): void {
  if (!scope) throw new Error("Codex model catalog must be scoped")
  const entries = models.map(parseCodexModelProfile)
  if (new Set(entries.map((p) => p.slug)).size !== entries.length)
    throw new Error("Duplicate Codex model slug")
  // As in ModelsManager, a visible account catalog is authoritative. An
  // empty/hidden-only response supplements the bundled catalog instead.
  const catalog = entries.some((p) => p.visibility === "list")
    ? new Map<string, CodexModelProfile>()
    : new Map(bundled)
  for (const entry of entries) catalog.set(entry.slug, entry)
  remote.set(scope, catalog)
}

export function removeCodexModelCatalog(scope: string): void {
  remote.delete(scope)
}

export function getCodexModelProfile(
  model: string,
  scope?: string
): CodexModelProfile | undefined {
  if (scope)
    // An account's fetched catalog is an advertisement, not an authorization:
    // 2026-09-23 the Codex API served `gpt-6-sol` for an account whose
    // catalog did not list it, while this lookup refused the request before
    // it was ever sent. Fall back to the bundled catalog so the upstream
    // decides what it will serve; a model it really lacks still fails there.
    return remote.get(scope)?.get(model) ?? bundled.get(model)
  const profiles = [...remote.values()].flatMap((c) =>
    c.has(model) ? [c.get(model)!] : []
  )
  if (profiles.length === 0) return bundled.get(model)
  // Before account selection, use the smallest available context budget. Wire
  // encoding is resolved again against the selected account's exact profile.
  const smallest = profiles.reduce((a, b) =>
    (a.context_window ?? Infinity) <= (b.context_window ?? Infinity) ? a : b
  )
  const maxWindows = profiles.flatMap((p) =>
    p.max_context_window === undefined ? [] : [p.max_context_window]
  )
  return {
    ...smallest,
    max_context_window: maxWindows.length ? Math.min(...maxWindows) : undefined,
  }
}

export function listCodexModelProfiles(scope?: string): CodexModelProfile[] {
  if (scope) return [...(remote.get(scope) ?? bundled).values()]
  const ids = new Set([
    ...bundled.keys(),
    ...[...remote.values()].flatMap((c) => [...c.keys()]),
  ])
  return [...ids]
    .map((id) => getCodexModelProfile(id)!)
    .sort((a, b) => a.priority - b.priority)
}

export function hasRemoteCodexModelCatalog(scope: string): boolean {
  return remote.has(scope)
}

export function codexCapabilitiesFromProfile(p: CodexModelProfile) {
  return {
    supportsVerbosity: p.support_verbosity,
    defaultVerbosity: p.default_verbosity ?? undefined,
    supportsParallelToolCalls: p.supports_parallel_tool_calls,
    useResponsesLite: p.use_responses_lite,
    supportsReasoningSummaries: p.supports_reasoning_summaries,
    supportsReasoningSummaryParameter: p.supports_reasoning_summary_parameter,
    supportsOriginalImageDetail: p.supports_image_detail_original,
    supportsImages: p.input_modalities.includes("image"),
    supportedServiceTiers: p.service_tiers.map((t) => t.id),
    contextTokenLimit: p.context_window,
    contextTokenLimitForMaxMode: p.max_context_window,
    truncationPolicy: p.truncation_policy,
    compactionModelHash: p.comp_hash ?? undefined,
    autoCompactTokenLimit: p.auto_compact_token_limit ?? undefined,
  }
}

export function resolveCodexWireEffort(
  profile: CodexModelProfile | undefined,
  effort: string | undefined
): string | undefined {
  if (effort === "persistent") return "disabled"
  if (effort !== "ultra") return effort
  const levels = profile?.supported_reasoning_levels.map((x) => x.effort) ?? []
  const override = profile?.multi_agent_reasoning_effort
  if (override && override !== "ultra" && levels.includes(override))
    return override
  return levels.includes("max")
    ? "max"
    : (levels.filter((x) => x !== "ultra").at(-1) ?? "medium")
}
