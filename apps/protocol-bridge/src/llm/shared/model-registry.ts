/**
 * Unified Model Registry
 *
 * Single source of truth for all model name mappings, aliases, and metadata.
 * Replaces scattered mappings in: model-router.service.ts, google.service.ts,
 * and google-model-cache.service.ts.
 */

import { parseModelRequest } from "./model-request"
import {
  getCodexModelProfile,
  listCodexModelProfiles,
  codexCapabilitiesFromProfile,
} from "../openai/codex-model-catalog"

// ---------------------------------------------------------------------------
// Model Families
// ---------------------------------------------------------------------------

export type ModelFamily = "gemini" | "claude" | "gpt" | "unknown"

export interface ThinkingCapability {
  levels?: readonly string[]
  minBudget?: number
  maxBudget?: number
  zeroAllowed?: boolean
  dynamicAllowed?: boolean
  defaultLevel?: string
}

export interface CodexRequestCapabilities {
  supportsVerbosity: boolean
  defaultVerbosity?: string
  supportsParallelToolCalls: boolean
  useResponsesLite: boolean
  supportsReasoningSummaryParameter?: boolean
  compactionModelHash?: string
  autoCompactTokenLimit?: number
  supportsReasoningSummaries: boolean
  supportsOriginalImageDetail: boolean
  supportsImages: boolean
  supportedServiceTiers?: readonly string[]
  contextTokenLimit?: number
  contextTokenLimitForMaxMode?: number
  truncationPolicy?: CodexTruncationPolicyConfig
}

export interface CodexTruncationPolicyConfig {
  mode: "bytes" | "tokens"
  limit: number
}

export interface ModelEntry {
  /** Canonical Cloud Code model ID */
  cloudCodeId: string
  /** Human-readable display name */
  displayName: string
  /** Model family */
  family: ModelFamily
  /** Whether this model supports thinking/extended thinking */
  isThinking: boolean
  /** Richer model reasoning/thinking capability metadata */
  thinking?: ThinkingCapability
  /** Whether this is a Claude model routed through Google Cloud Code */
  isClaudeThroughGoogle: boolean
  /** Codex Responses request capabilities, when this is a ChatGPT Codex model */
  codex?: CodexRequestCapabilities
}

export interface PublicModelMetadata {
  createdAt?: number
  ownedBy: string
  displayName?: string
}

export type CodexModelTier = "free" | "team" | "plus" | "pro"

function createLevelThinkingCapability(
  levels: readonly string[],
  defaultLevel?: string
): ThinkingCapability {
  return {
    levels,
    zeroAllowed: levels.includes("none"),
    dynamicAllowed: levels.includes("auto"),
    defaultLevel:
      defaultLevel ||
      (levels.includes("high")
        ? "high"
        : levels[levels.length - 1] || undefined),
  }
}

function inferPassthroughGptThinkingCapability(
  normalizedModel: string
): ThinkingCapability | undefined {
  if (
    normalizedModel.startsWith("o1") ||
    normalizedModel.startsWith("o3") ||
    normalizedModel.startsWith("o4") ||
    normalizedModel.startsWith("codex")
  ) {
    return createLevelThinkingCapability(["low", "medium", "high", "xhigh"])
  }

  if (normalizedModel.startsWith("gpt-5")) {
    return createLevelThinkingCapability(["low", "medium", "high", "xhigh"])
  }

  return undefined
}
// ---------------------------------------------------------------------------
// Gemini Models: Cursor alias -> Cloud Code canonical ID
// ---------------------------------------------------------------------------

const GEMINI_MODELS: Record<
  string,
  Omit<ModelEntry, "family" | "isClaudeThroughGoogle">
> = {
  "gemini-3-pro": {
    cloudCodeId: "gemini-3-pro-preview",
    displayName: "Gemini 3 Pro",
    isThinking: false,
  },
  "gemini-3-pro-high": {
    cloudCodeId: "gemini-3-pro-high",
    displayName: "Gemini 3 Pro High (Deprecated)",
    isThinking: false,
  },
  "gemini-3-pro-low": {
    cloudCodeId: "gemini-3-pro-low",
    displayName: "Gemini 3 Pro Low (Deprecated)",
    isThinking: false,
  },
  "gemini-3.1-pro-high": {
    cloudCodeId: "gemini-pro-agent",
    displayName: "Gemini 3.1 Pro High",
    isThinking: true,
  },
  "gemini-3.1-pro-low": {
    cloudCodeId: "gemini-3.1-pro-low",
    displayName: "Gemini 3.1 Pro Low",
    isThinking: false,
  },
  "gemini-3.1-flash-image": {
    cloudCodeId: "gemini-3.1-flash-image",
    displayName: "Gemini 3.1 Flash Image",
    isThinking: false,
  },
  "gemini-3-flash": {
    cloudCodeId: "gemini-3-flash",
    displayName: "Gemini 3 Flash",
    isThinking: false,
  },
  "gemini-2.5-flash": {
    cloudCodeId: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    isThinking: false,
  },
  "gemini-2.5-flash-lite": {
    cloudCodeId: "gemini-2.5-flash-lite",
    displayName: "Gemini 2.5 Flash Lite",
    isThinking: false,
  },
  "gemini-2.5-pro": {
    cloudCodeId: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    isThinking: false,
  },
}

// ---------------------------------------------------------------------------
// Claude Models: All known aliases -> Cloud Code canonical ID
// Merges mappings from model-router (Cursor aliases) and google.service
// (Claude CLI aliases)
// ---------------------------------------------------------------------------

const CLAUDE_MODELS: Record<
  string,
  Omit<ModelEntry, "family" | "isClaudeThroughGoogle">
> = {
  // --- Opus 4.8 ---
  "claude-opus-4-8": {
    cloudCodeId: "claude-opus-4-8-thinking",
    displayName: "Claude Opus 4.8",
    isThinking: false,
  },
  "claude-opus-4.8": {
    cloudCodeId: "claude-opus-4-8-thinking",
    displayName: "Claude Opus 4.8",
    isThinking: false,
  },
  "claude-opus-4-8-thinking": {
    cloudCodeId: "claude-opus-4-8-thinking",
    displayName: "Claude Opus 4.8 Thinking",
    isThinking: true,
  },
  "claude-opus-4.8-thinking": {
    cloudCodeId: "claude-opus-4-8-thinking",
    displayName: "Claude Opus 4.8 Thinking",
    isThinking: true,
  },
  "claude-4.8-opus": {
    cloudCodeId: "claude-opus-4-8-thinking",
    displayName: "Claude Opus 4.8",
    isThinking: true,
  },
  "claude-4.8-opus-thinking": {
    cloudCodeId: "claude-opus-4-8-thinking",
    displayName: "Claude Opus 4.8 Thinking",
    isThinking: true,
  },

  // --- Opus 4.7 ---
  "claude-opus-4-7": {
    cloudCodeId: "claude-opus-4-7-thinking",
    displayName: "Claude Opus 4.7",
    isThinking: false,
  },
  "claude-opus-4.7": {
    cloudCodeId: "claude-opus-4-7-thinking",
    displayName: "Claude Opus 4.7",
    isThinking: false,
  },
  "claude-opus-4-7-thinking": {
    cloudCodeId: "claude-opus-4-7-thinking",
    displayName: "Claude Opus 4.7 Thinking",
    isThinking: true,
  },
  "claude-4.7-opus": {
    cloudCodeId: "claude-opus-4-7-thinking",
    displayName: "Claude Opus 4.7",
    isThinking: true,
  },
  "claude-4.7-opus-thinking": {
    cloudCodeId: "claude-opus-4-7-thinking",
    displayName: "Claude Opus 4.7 Thinking",
    isThinking: true,
  },

  // --- Opus 4.6 (latest) ---
  "claude-opus-4-6": {
    cloudCodeId: "claude-opus-4-6-thinking",
    displayName: "Claude Opus 4.6",
    isThinking: false,
  },
  "claude-opus-4-20250514": {
    cloudCodeId: "claude-opus-4-6-thinking",
    displayName: "Claude 4 Opus (→ Opus 4.6)",
    isThinking: true,
  },
  "claude-opus-4-6-thinking": {
    cloudCodeId: "claude-opus-4-6-thinking",
    displayName: "Claude Opus 4.6 Thinking",
    isThinking: true,
  },
  "claude-opus-4.6": {
    cloudCodeId: "claude-opus-4-6-thinking",
    displayName: "Claude Opus 4.6",
    isThinking: false,
  },
  "claude-4.6-opus": {
    cloudCodeId: "claude-opus-4-6-thinking",
    displayName: "Claude Opus 4.6",
    isThinking: true,
  },
  "claude-4.6-opus-thinking": {
    cloudCodeId: "claude-opus-4-6-thinking",
    displayName: "Claude Opus 4.6 Thinking",
    isThinking: true,
  },

  // --- Opus 4.5 ---
  "claude-opus-4-5": {
    cloudCodeId: "claude-opus-4-5-thinking",
    displayName: "Claude Opus 4.5",
    isThinking: true,
  },
  "claude-opus-4-5-20251101": {
    cloudCodeId: "claude-opus-4-5",
    displayName: "Claude Opus 4.5",
    isThinking: false,
  },
  "claude-opus-4.5": {
    cloudCodeId: "claude-opus-4-5-thinking",
    displayName: "Claude Opus 4.5",
    isThinking: true,
  },
  "claude-4.5-opus-high": {
    cloudCodeId: "claude-opus-4-5",
    displayName: "Claude Opus 4.5 High",
    isThinking: false,
  },
  "claude-4.5-opus-high-thinking": {
    cloudCodeId: "claude-opus-4-5-thinking",
    displayName: "Claude Opus 4.5 High Thinking",
    isThinking: true,
  },
  "claude-opus-4-5-thinking": {
    cloudCodeId: "claude-opus-4-5-thinking",
    displayName: "Claude Opus 4.5 Thinking",
    isThinking: true,
  },
  "claude-opus-4.5-thinking": {
    cloudCodeId: "claude-opus-4-5-thinking",
    displayName: "Claude Opus 4.5 Thinking",
    isThinking: true,
  },

  // --- Generic Opus (resolve to latest) ---
  "claude-opus-4": {
    cloudCodeId: "claude-opus-4-8-thinking",
    displayName: "Claude Opus 4",
    isThinking: true,
  },
  "claude-4-opus": {
    cloudCodeId: "claude-opus-4-8-thinking",
    displayName: "Claude Opus 4",
    isThinking: true,
  },

  // --- Sonnet 4.6 ---
  "claude-sonnet-4-6": {
    cloudCodeId: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    isThinking: false,
  },
  "claude-sonnet-4-5-20250929": {
    cloudCodeId: "claude-sonnet-4-5",
    displayName: "Claude 4.5 Sonnet",
    isThinking: false,
  },
  "claude-sonnet-4-20250514": {
    cloudCodeId: "claude-sonnet-4-5",
    displayName: "Claude 4 Sonnet (→ Sonnet 4.5)",
    isThinking: false,
  },
  "claude-sonnet-4.6": {
    cloudCodeId: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    isThinking: false,
  },

  // --- Sonnet 4.5 ---
  "claude-sonnet-4": {
    cloudCodeId: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4",
    isThinking: false,
  },
  "claude-sonnet-4-5": {
    cloudCodeId: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    isThinking: false,
  },
  "claude-sonnet-4.5": {
    cloudCodeId: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    isThinking: false,
  },
  "claude-4-sonnet": {
    cloudCodeId: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4",
    isThinking: false,
  },
  "claude-sonnet-4-5-thinking": {
    cloudCodeId: "claude-sonnet-4-5-thinking",
    displayName: "Claude Sonnet 4.5 Thinking",
    isThinking: true,
  },
  "claude-sonnet-4.5-thinking": {
    cloudCodeId: "claude-sonnet-4-5-thinking",
    displayName: "Claude Sonnet 4.5 Thinking",
    isThinking: true,
  },

  // --- Haiku 4.5 ---
  "claude-haiku-4-5": {
    cloudCodeId: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    isThinking: false,
  },
  "claude-haiku-4.5": {
    cloudCodeId: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    isThinking: false,
  },
  "claude-haiku-4-5-20251001": {
    cloudCodeId: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    isThinking: false,
  },
  "claude-4-5-haiku": {
    cloudCodeId: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    isThinking: false,
  },
  "claude-4.5-haiku": {
    cloudCodeId: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    isThinking: false,
  },

  // --- Legacy 3.x (map to latest equivalents) ---
  "claude-3-opus": {
    cloudCodeId: "claude-opus-4-6-thinking",
    displayName: "Claude 3 Opus (→ Opus 4.6)",
    isThinking: true,
  },
  "claude-3-sonnet": {
    cloudCodeId: "claude-sonnet-4-5",
    displayName: "Claude 3 Sonnet (→ Sonnet 4.5)",
    isThinking: false,
  },
  "claude-3.5-sonnet": {
    cloudCodeId: "claude-sonnet-4-5",
    displayName: "Claude 3.5 Sonnet (→ Sonnet 4.5)",
    isThinking: false,
  },
  "claude-3-5-sonnet": {
    cloudCodeId: "claude-sonnet-4-5",
    displayName: "Claude 3.5 Sonnet (→ Sonnet 4.5)",
    isThinking: false,
  },
  "claude-3-7-sonnet-20250219": {
    cloudCodeId: "claude-sonnet-4-5",
    displayName: "Claude 3.7 Sonnet (→ Sonnet 4.5)",
    isThinking: false,
  },
}

// ---------------------------------------------------------------------------
// Codex (OpenAI) Models: Cursor/Claude Code alias -> Codex canonical ID
// ---------------------------------------------------------------------------

const CODEX_MODELS: Record<
  string,
  Omit<ModelEntry, "family" | "isClaudeThroughGoogle">
> = {
  // --- GPT-5 ---
  // --- GPT-4.1 ---
  "gpt-4.1": {
    cloudCodeId: "gpt-4.1",
    displayName: "GPT-4.1",
    isThinking: false,
  },
  "gpt-4.1-mini": {
    cloudCodeId: "gpt-4.1-mini",
    displayName: "GPT-4.1 Mini",
    isThinking: false,
  },
  "gpt-4.1-nano": {
    cloudCodeId: "gpt-4.1-nano",
    displayName: "GPT-4.1 Nano",
    isThinking: false,
  },

  // --- GPT-4o ---
  "gpt-4o": {
    cloudCodeId: "gpt-4o",
    displayName: "GPT-4o",
    isThinking: false,
  },
  "gpt-4o-mini": {
    cloudCodeId: "gpt-4o-mini",
    displayName: "GPT-4o Mini",
    isThinking: false,
  },

  // --- O-series reasoning models ---
  o3: {
    cloudCodeId: "o3",
    displayName: "O3",
    isThinking: true,
    thinking: createLevelThinkingCapability(["low", "medium", "high", "xhigh"]),
  },
  "o3-mini": {
    cloudCodeId: "o3-mini",
    displayName: "O3 Mini",
    isThinking: true,
    thinking: createLevelThinkingCapability(["low", "medium", "high", "xhigh"]),
  },
  "o4-mini": {
    cloudCodeId: "o4-mini",
    displayName: "O4 Mini",
    isThinking: true,
    thinking: createLevelThinkingCapability(["low", "medium", "high", "xhigh"]),
  },

  // --- Codex-specific models ---
  "codex-mini": {
    cloudCodeId: "codex-mini-latest",
    displayName: "Codex Mini",
    isThinking: true,
    thinking: createLevelThinkingCapability(["low", "medium", "high", "xhigh"]),
  },
  "codex-mini-latest": {
    cloudCodeId: "codex-mini-latest",
    displayName: "Codex Mini Latest",
    isThinking: true,
    thinking: createLevelThinkingCapability(["low", "medium", "high", "xhigh"]),
  },
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default Gemini model when no mapping found */
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-pro-high"

/** Default Claude model when no mapping found */
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-5"

/** Default Codex model when no mapping found */
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol"

const PUBLIC_MODEL_METADATA: Record<string, PublicModelMetadata> = {
  "claude-sonnet-4-5-20250929": {
    createdAt: 1759104000,
    ownedBy: "anthropic",
    displayName: "Claude 4.5 Sonnet",
  },
  "claude-sonnet-4-6": {
    createdAt: 1771372800,
    ownedBy: "anthropic",
    displayName: "Claude 4.6 Sonnet",
  },
  "claude-opus-4-6": {
    createdAt: 1770318000,
    ownedBy: "anthropic",
    displayName: "Claude 4.6 Opus",
  },
  "claude-opus-4-5-20251101": {
    createdAt: 1761955200,
    ownedBy: "anthropic",
    displayName: "Claude 4.5 Opus",
  },
  "claude-opus-4-20250514": {
    createdAt: 1715644800,
    ownedBy: "anthropic",
    displayName: "Claude 4 Opus",
  },
  "claude-sonnet-4-20250514": {
    createdAt: 1715644800,
    ownedBy: "anthropic",
    displayName: "Claude 4 Sonnet",
  },
  "claude-3-7-sonnet-20250219": {
    createdAt: 1708300800,
    ownedBy: "anthropic",
    displayName: "Claude 3.7 Sonnet",
  },
  "claude-3-5-haiku-20241022": {
    createdAt: 1729555200,
    ownedBy: "anthropic",
    displayName: "Claude 3.5 Haiku",
  },
  "claude-haiku-4-5-20251001": {
    createdAt: 1759276800,
    ownedBy: "anthropic",
    displayName: "Claude Haiku 4.5",
  },
  "claude-haiku-4-5": {
    createdAt: 1759276800,
    ownedBy: "anthropic",
    displayName: "Claude Haiku 4.5",
  },
  "claude-opus-4-6-thinking": {
    createdAt: 1770318000,
    ownedBy: "antigravity",
    displayName: "Claude Opus 4.6 (Thinking)",
  },
  "claude-4.6-opus": {
    createdAt: 1770318000,
    ownedBy: "anthropic",
    displayName: "Claude 4.6 Opus",
  },
  "claude-4.6-opus-thinking": {
    createdAt: 1770318000,
    ownedBy: "antigravity",
    displayName: "Claude 4.6 Opus (Thinking)",
  },
  "claude-sonnet-4-5": {
    createdAt: 1759104000,
    ownedBy: "anthropic",
    displayName: "Claude 4.5 Sonnet",
  },
  "claude-sonnet-4-5-thinking": {
    createdAt: 1759104000,
    ownedBy: "antigravity",
    displayName: "Claude 4.5 Sonnet (Thinking)",
  },
  "claude-4.5-opus-high-thinking": {
    createdAt: 1761955200,
    ownedBy: "antigravity",
    displayName: "Claude 4.5 Opus (Thinking)",
  },
  "gpt-5": {
    createdAt: 1754524800,
    ownedBy: "openai",
    displayName: "GPT 5",
  },
  "gpt-5-codex": {
    createdAt: 1757894400,
    ownedBy: "openai",
    displayName: "GPT 5 Codex",
  },
  "gpt-5-codex-mini": {
    createdAt: 1762473600,
    ownedBy: "openai",
    displayName: "GPT 5 Codex Mini",
  },
  "gpt-5.1": {
    createdAt: 1762905600,
    ownedBy: "openai",
    displayName: "GPT 5.1",
  },
  "gpt-5.1-codex": {
    createdAt: 1762905600,
    ownedBy: "openai",
    displayName: "GPT 5.1 Codex",
  },
  "gpt-5.1-codex-mini": {
    createdAt: 1762905600,
    ownedBy: "openai",
    displayName: "GPT 5.1 Codex Mini",
  },
  "gpt-5.1-codex-max": {
    createdAt: 1763424000,
    ownedBy: "openai",
    displayName: "GPT 5.1 Codex Max",
  },
  "gpt-5.2": {
    createdAt: 1765440000,
    ownedBy: "openai",
    displayName: "GPT 5.2",
  },
  "gpt-5.2-codex": {
    createdAt: 1765440000,
    ownedBy: "openai",
    displayName: "GPT 5.2 Codex",
  },
  "gpt-5.3-codex": {
    createdAt: 1770307200,
    ownedBy: "openai",
    displayName: "GPT 5.3 Codex",
  },
  "gpt-5.3-codex-spark": {
    createdAt: 1770912000,
    ownedBy: "openai",
    displayName: "GPT 5.3 Codex Spark",
  },
  "gpt-6-sol": {
    createdAt: 1790121600,
    ownedBy: "openai",
    displayName: "GPT 6 Sol",
  },
  "gpt-6-luna": {
    createdAt: 1790121600,
    ownedBy: "openai",
    displayName: "GPT 6 Luna",
  },
  "gpt-6-astra": {
    createdAt: 1790121600,
    ownedBy: "openai",
    displayName: "GPT 6 Astra",
  },
  "gpt-5.6-sol": {
    createdAt: 1783555200,
    ownedBy: "openai",
    displayName: "GPT 5.6 Sol",
  },
  "gpt-5.6-terra": {
    createdAt: 1783555200,
    ownedBy: "openai",
    displayName: "GPT 5.6 Terra",
  },
  "gpt-5.6-luna": {
    createdAt: 1783555200,
    ownedBy: "openai",
    displayName: "GPT 5.6 Luna",
  },
  "gpt-5.5": {
    createdAt: 1778112000,
    ownedBy: "openai",
    displayName: "GPT 5.5",
  },
  "gpt-5.4": {
    createdAt: 1772668800,
    ownedBy: "openai",
    displayName: "GPT 5.4",
  },
  "gpt-5.4-mini": {
    createdAt: 1773705600,
    ownedBy: "openai",
    displayName: "GPT 5.4 Mini",
  },
}

// ---------------------------------------------------------------------------
// Query Functions
// ---------------------------------------------------------------------------

/**
 * Resolve any model name to its Cloud Code canonical ID.
 * Returns null if the model is completely unknown.
 */
export function resolveCloudCodeModel(alias: string): ModelEntry | null {
  const request = parseModelRequest(alias)
  const normalized = request.normalizedBaseModel

  // Check Gemini models first
  const gemini = GEMINI_MODELS[normalized]
  if (gemini) {
    return {
      ...gemini,
      family: "gemini",
      isClaudeThroughGoogle: false,
    }
  }
  // Passthrough for unmapped gemini models
  if (normalized.startsWith("gemini")) {
    const isThinking =
      normalized.includes("thinking") ||
      normalized.includes("-low") ||
      normalized.includes("-medium") ||
      normalized.includes("-high") ||
      normalized.includes("-agent")

    return {
      cloudCodeId: normalized,
      displayName: normalized,
      family: "gemini",
      isThinking,
      thinking: undefined,
      isClaudeThroughGoogle: false,
    }
  }

  // Check Claude models
  const claude = CLAUDE_MODELS[normalized]
  if (claude) {
    return {
      ...claude,
      family: "claude",
      isClaudeThroughGoogle: true,
    }
  }

  // Check Codex (OpenAI) models
  const profile = getCodexModelProfile(normalized)
  if (profile) {
    return {
      cloudCodeId: profile.slug,
      displayName: profile.display_name,
      family: "gpt",
      isThinking: profile.supported_reasoning_levels.length > 0,
      thinking: createLevelThinkingCapability(
        profile.supported_reasoning_levels.map((x) => x.effort),
        profile.default_reasoning_level
      ),
      codex: codexCapabilitiesFromProfile(profile),
      isClaudeThroughGoogle: false,
    }
  }
  const codex = CODEX_MODELS[normalized]
  if (codex) {
    return {
      ...codex,
      family: "gpt",
      isClaudeThroughGoogle: false,
    }
  }
  // Passthrough for unmapped GPT/O-series models
  if (
    normalized.startsWith("gpt") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4") ||
    normalized.startsWith("codex")
  ) {
    const thinking = inferPassthroughGptThinkingCapability(normalized)
    return {
      cloudCodeId: normalized,
      displayName: normalized,
      family: "gpt",
      isThinking: !!thinking,
      thinking,
      isClaudeThroughGoogle: false,
    }
  }

  return null
}

export function resolveCodexRequestCapabilities(
  modelId: string
): CodexRequestCapabilities | null {
  const normalized = parseModelRequest(modelId).normalizedBaseModel
  if (!normalized) {
    return null
  }

  const profile = getCodexModelProfile(normalized)
  return profile ? codexCapabilitiesFromProfile(profile) : null
}

export function resolveModelThinkingCapability(
  modelId: string
): ThinkingCapability | null {
  // A ChatGPT Web model resolves to nothing below — the slug behind the prefix
  // is chatgpt.com's — so its ladder comes from the catalogue the web app
  // publishes, expressed in the same low/medium/high/xhigh Cursor already uses
  // for the GPT family. The default is the deepest rung: the web quota is the
  // reason to pick one of these, and Cursor's picker opens on whatever this
  // says.
  // Only for ids that actually asked for the web route: the helper reads a
  // Codex profile for the slug, so without this guard a plain Codex model
  // would take this branch and lose its own catalogue's default rung.
  const webLevels = isWebGptModel(modelId)
    ? webGptCursorEffortLevels(modelId)
    : []
  if (webLevels.length > 0) {
    // Not the deepest rung: `ultra` is a Cursor extension the web app has no
    // answer for, and it is not a value the variant projection even
    // recognises — asking for it lands back on the bottom of the ladder.
    return createLevelThinkingCapability(
      webLevels,
      webGptDefaultLevel(modelId) ?? webLevels[webLevels.length - 1]
    )
  }

  const resolved = resolveCloudCodeModel(modelId)
  if (resolved?.thinking) {
    return resolved.thinking
  }

  if (resolved?.isThinking) {
    // GPT / Codex 在缺少显式 thinking metadata 时回退为 low/medium/high。
    if (resolved.family === "gpt") {
      return createLevelThinkingCapability(["low", "medium", "high"])
    }
    // Claude 思考模型对齐 Cursor 的 effort 档位菜单。三条 Claude 后端
    // (kiro / google-claude / claude-api) 均消费 output_config.effort：
    // kiro 透传为原生 effort，google-claude 映射成 thinkingBudget，
    // claude-api 透传为 Anthropic adaptive effort。上游 effort 只到 max，
    // 故不含 ultra。
    if (resolved.family === "claude") {
      return createLevelThinkingCapability(
        ["low", "medium", "high", "xhigh", "max"],
        "medium"
      )
    }
    // Gemini 的 isThinking 更接近布尔 thinking toggle，保持不投影成 effort。
    return null
  }

  return null
}

export function getPublicModelMetadata(
  modelId: string
): PublicModelMetadata | null {
  const normalized = parseModelRequest(modelId).normalizedBaseModel
  return PUBLIC_MODEL_METADATA[normalized] || null
}

/**
 * Determine whether a public model ID should be treated as thinking-capable.
 *
 * Use registry metadata as the source of truth when available, but keep a
 * suffix-based fallback for custom or passthrough model IDs such as
 * provider-specific aliases ending in "thinking".
 */
export function doesModelSupportThinking(modelId: string): boolean {
  const request = parseModelRequest(modelId)
  const normalized = request.normalizedBaseModel
  if (!normalized) {
    return false
  }

  if (
    request.suffix?.kind === "none" ||
    request.suffix?.kind === "auto" ||
    request.suffix?.kind === "budget" ||
    request.suffix?.kind === "level"
  ) {
    return true
  }

  if (resolveModelThinkingCapability(normalized)) {
    return true
  }

  return normalized.includes("thinking")
}

/**
 * Detect model family from name.
 */
export function detectModelFamily(name: string): ModelFamily {
  const n = parseModelRequest(name).normalizedBaseModel
  if (n.startsWith("gemini")) return "gemini"
  if (
    n.includes("claude") ||
    n.includes("sonnet") ||
    n.includes("haiku") ||
    n.includes("opus")
  )
    return "claude"
  if (
    n.startsWith("gpt") ||
    n.startsWith("o1") ||
    n.startsWith("o3") ||
    n.startsWith("o4") ||
    n.startsWith("codex")
  )
    return "gpt"
  return "unknown"
}

/**
 * Check if a model is a Claude Opus variant (eligible for google-claude backend).
 */
export function isOpusModel(name: string): boolean {
  const n = parseModelRequest(name).normalizedBaseModel
  return n.includes("opus")
}

/**
 * Get all default model IDs for cache initialization.
 */
export function getDefaultModelIds(): string[] {
  const ids = new Set<string>()
  for (const entry of Object.values(GEMINI_MODELS)) {
    ids.add(entry.cloudCodeId)
  }
  // Add canonical Claude models (not all aliases)
  ids.add("claude-sonnet-4-6")
  ids.add("claude-sonnet-4-5")
  ids.add("claude-sonnet-4-5-thinking")
  ids.add("claude-opus-4-5-thinking")
  ids.add("claude-opus-4-6-thinking")
  return Array.from(ids).sort()
}

/**
 * Check if a model ID is a supported Cloud Code model (Gemini or Claude).
 */
export function isSupportedModel(modelId: string): boolean {
  const family = detectModelFamily(modelId)
  return family === "gemini" || family === "claude"
}

// ---------------------------------------------------------------------------
// Cursor Display Models (for AvailableModels endpoint)
// ---------------------------------------------------------------------------

export interface CursorDisplayModel {
  name: string
  displayName: string
  shortName: string
  family: ModelFamily
  isThinking: boolean
  aliases?: string[]
  isUserAdded?: boolean
  isHidden?: boolean
  isLongContextOnly?: boolean
  isChatOnly?: boolean
  supportsAgent?: boolean
  supportsCmdK?: boolean
  onlySupportsCmdK?: boolean
  supportsPlanMode?: boolean
  supportsSandboxing?: boolean
  supportsImages?: boolean
  isRecommendedForBackgroundComposer?: boolean
  visibleInRoutedModelView?: boolean
  contextTokenLimit?: number
  contextTokenLimitForMaxMode?: number
  legacySlugs?: string[]
  idAliases?: string[]
  cloudMigrateToModel?: string
  upgradeModelId?: string
  /**
   * Optional badge/subtitle rendered next to the model name in the Cursor
   * picker (e.g. `Fast`, `Beta`). When set, this wins over the default
   * `buildCursorAvailableModel` fallback that derives a tagline from the
   * variant config or the display name. Used today for the Antigravity
   * `gemini-3.5-flash-*` family which Antigravity's own UI badges as `Fast`.
   */
  tagline?: string
}

export interface CursorDisplayModelOptions {
  includeCodex?: boolean
  codexModelTier?: string | null
  excludeMaxNamedModels?: boolean
  extraModels?: CursorDisplayModel[]
}

export const GEMINI_CURSOR_DISPLAY_MODELS: CursorDisplayModel[] = [
  {
    name: "gemini-3.1-pro-high",
    displayName: "Gemini 3.1 Pro High",
    shortName: "Gemini 3.1 Pro",
    family: "gemini",
    isThinking: true,
  },
  {
    name: "gemini-3.1-pro-low",
    displayName: "Gemini 3.1 Pro Low",
    shortName: "Gemini 3.1 Low",
    family: "gemini",
    isThinking: false,
  },
  {
    name: "gemini-3.1-flash-image",
    displayName: "Gemini 3.1 Flash Image",
    shortName: "Gemini 3.1 Flash",
    family: "gemini",
    isThinking: false,
  },
  {
    name: "gemini-3-pro-high",
    displayName: "Gemini 3 Pro High",
    shortName: "Gemini 3 Pro",
    family: "gemini",
    isThinking: false,
  },
  {
    name: "gemini-3-flash",
    displayName: "Gemini 3 Flash",
    shortName: "Gemini 3 Flash",
    family: "gemini",
    isThinking: false,
  },
  {
    name: "gemini-3-flash-agent",
    displayName: "Gemini 3 Flash Agent",
    shortName: "Gemini 3 Agent",
    family: "gemini",
    isThinking: false,
  },
  {
    name: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    shortName: "Gemini 2.5 Pro",
    family: "gemini",
    isThinking: false,
  },
  {
    name: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    shortName: "Gemini 2.5 Flash",
    family: "gemini",
    isThinking: false,
  },
  {
    name: "gemini-2.5-flash-thinking",
    displayName: "Gemini 2.5 Flash (Thinking)",
    shortName: "Gemini 2.5 Thinking",
    family: "gemini",
    isThinking: true,
  },
  {
    name: "gemini-2.5-flash-lite",
    displayName: "Gemini 2.5 Flash Lite",
    shortName: "Gemini 2.5 Lite",
    family: "gemini",
    isThinking: false,
  },
]

export const CLAUDE_CURSOR_DISPLAY_MODELS: CursorDisplayModel[] = [
  {
    name: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    shortName: "Opus 4.8",
    family: "claude",
    isThinking: false,
  },
  {
    name: "claude-opus-4-8-thinking",
    displayName: "Claude Opus 4.8 (Thinking)",
    shortName: "Opus 4.8 Thinking",
    family: "claude",
    isThinking: true,
  },
  {
    name: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    shortName: "Opus 4.7",
    family: "claude",
    isThinking: false,
  },
  {
    name: "claude-opus-4-7-thinking",
    displayName: "Claude Opus 4.7 (Thinking)",
    shortName: "Opus 4.7 Thinking",
    family: "claude",
    isThinking: true,
  },
  {
    name: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    shortName: "Opus 4.6",
    family: "claude",
    isThinking: false,
  },
  {
    name: "claude-opus-4-6-thinking",
    displayName: "Claude Opus 4.6 (Thinking)",
    shortName: "Opus 4.6 Thinking",
    family: "claude",
    isThinking: true,
  },
  {
    name: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    shortName: "Sonnet 4.6",
    family: "claude",
    isThinking: false,
  },
  {
    name: "claude-4.5-opus-high-thinking",
    displayName: "Claude Opus 4.5 (Thinking)",
    shortName: "Opus 4.5 Thinking",
    family: "claude",
    isThinking: true,
  },
  {
    name: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    shortName: "Sonnet 4.5",
    family: "claude",
    isThinking: false,
  },
  {
    name: "claude-sonnet-4-5-thinking",
    displayName: "Claude Sonnet 4.5 (Thinking)",
    shortName: "Sonnet 4.5 Thinking",
    family: "claude",
    isThinking: true,
  },
]

function codexDisplayModel(
  profile: ReturnType<typeof listCodexModelProfiles>[number]
): CursorDisplayModel {
  return {
    name: profile.slug,
    displayName: profile.display_name,
    shortName: profile.display_name,
    family: "gpt",
    isThinking: profile.supported_reasoning_levels.length > 0,
    isHidden: profile.visibility !== "list",
    supportsImages: profile.input_modalities.includes("image"),
    contextTokenLimit: profile.context_window,
    contextTokenLimitForMaxMode: profile.max_context_window,
  }
}
export const BASE_CODEX_CURSOR_DISPLAY_MODELS: CursorDisplayModel[] =
  listCodexModelProfiles().map(codexDisplayModel)
export const CODEX_CURSOR_DISPLAY_MODELS = BASE_CODEX_CURSOR_DISPLAY_MODELS

/**
 * Models served by chatgpt.com's web app rather than the Codex backend.
 *
 * They are listed so the editor's picker offers them like any other model —
 * the route exists either way, but a model nobody can select from a list is a
 * model nobody uses.
 *
 * The `web-gpt/` prefix is part of the name, not a vendor tag to be stripped:
 * it is what tells the router to spend the web quota and drive a browser, and
 * that has to be a deliberate choice rather than something inferred from a
 * model id that also exists on Codex.
 *
 * Names match the slugs chatgpt.com's own catalogue returns; `*-pro` and
 * `research` have no Codex equivalent at all.
 */
/** The chatgpt.com model behind a `web-gpt/` (or `web-gpt:`) prefix, if any. */
export function readWebGptModel(modelId: string): string | null {
  const match = /^web-gpt[/:](.+)$/i.exec(modelId.trim())
  return match ? match[1]!.trim() : null
}

/**
 * Whether an id asks for the ChatGPT Web route.
 *
 * Nothing else in this registry resolves one: the slug behind the prefix
 * belongs to chatgpt.com's catalogue, not to any local backend, so
 * `resolveCloudCodeModel` returns null for it and every caller asking "who
 * serves this model" has to settle this question before consulting the
 * registry at all.
 */
export function isWebGptModel(modelId: string): boolean {
  return readWebGptModel(modelId) !== null
}

/**
 * A ChatGPT Web model, as its own slider presents it.
 *
 * The web app shows one model with five stops — Instant, Medium, High, Extra
 * High, and then Pro — and the last one hands the turn to a different model
 * rather than sending a deeper effort. Codex names the same five rungs Low,
 * Medium, High, Extra high, Max, so they line up one for one, with Cursor's
 * `ultra` left over because nothing sits above Pro.
 *
 * `thinking` is the slug the first four rungs go to; `pro` is the slug the top
 * rung switches to.
 */
interface WebGptModel {
  readonly thinking: string
  readonly pro?: string
}

/**
 * Chat models only, keyed by the slug chatgpt.com uses.
 *
 * The catalogue's `-wm` family — Astra, Sol, Terra, Luna and 5.5, under the
 * names Codex also uses — is ChatGPT's *work* mode: the tab beside Chat, on
 * the same quota as the Codex CLI. Coming here at all is about the other
 * quota, so pointing at those was both pointless and why the tab kept landing
 * in a composer this hook does not know how to drive. `is_work_mode_model` in
 * the catalogue is what tells them apart.
 */
const WEB_GPT_MODELS: Record<string, WebGptModel> = {
  "gpt-5-6-thinking": { thinking: "gpt-5-6-thinking", pro: "gpt-5-6-pro" },
  "gpt-5-5-thinking": { thinking: "gpt-5-5-thinking", pro: "gpt-5-5-pro" },
  // Chat has no non-Pro GPT-6, so it stands alone with no slider.
  "gpt-6-pro": { thinking: "gpt-6-pro" },
  // Auto-reasoning and instant: nothing to choose from.
  "gpt-5-6": { thinking: "gpt-5-6" },
  "gpt-5-5": { thinking: "gpt-5-5" },
  "gpt-5-6-mini": { thinking: "gpt-5-6-mini" },
  "gpt-5-5-mini": { thinking: "gpt-5-5-mini" },
  "o3-pro": { thinking: "o3-pro" },
}

/**
 * The four efforts the web app sends for the non-Pro rungs, in its own words,
 * against the names Cursor uses for the same four.
 */
const WEB_GPT_EFFORTS = [
  { effort: "min", level: "low" },
  { effort: "standard", level: "medium" },
  { effort: "extended", level: "high" },
  { effort: "max", level: "xhigh" },
] as const

/** The rung Cursor's `max` means: hand the turn to the Pro model. */
const WEB_GPT_PRO_LEVEL = "max"

/** What chatgpt.com's own catalogue calls each of them. */
const WEB_GPT_LABELS: Record<string, string> = {
  "gpt-5-6-thinking": "GPT-5.6 Sol",
  "gpt-5-5-thinking": "GPT-5.5 Thinking",
  "gpt-6-pro": "GPT-6 Pro",
  "gpt-5-6": "GPT-5.6 Sol Instant",
  "gpt-5-5": "GPT-5.5 Instant",
  "gpt-5-6-mini": "GPT-5.6 Mini",
  "gpt-5-5-mini": "GPT-5.5 Mini",
  "o3-pro": "o3-pro",
}

function webGptModel(modelId: string): WebGptModel | undefined {
  const slug = (readWebGptModel(modelId) ?? modelId).trim().toLowerCase()
  return WEB_GPT_MODELS[slug]
}

/**
 * The rungs Cursor should offer: the web app's four, plus Pro as the fifth
 * where the model has one.
 *
 * Empty when there is nothing to choose — a picker with one option only takes
 * up room.
 */
export function webGptCursorEffortLevels(modelId: string): string[] {
  const model = webGptModel(modelId)
  if (!model) return []
  // A model with no Pro tier has no slider either: those entries are the
  // standalone ones — o3-pro and the minis — which publish no depths at all.
  if (!model.pro) return []
  return [
    ...WEB_GPT_EFFORTS.map((rung) => rung.level),
    ...(model.pro ? [WEB_GPT_PRO_LEVEL] : []),
  ]
}

/**
 * The rung a turn gets when it names none: Extra High.
 *
 * The deepest the model itself thinks before the slider stops being about
 * effort and starts being about which model answers.
 */
export function webGptDefaultLevel(modelId: string): string | null {
  const levels = webGptCursorEffortLevels(modelId)
  if (levels.length === 0) return null
  return levels.includes("xhigh")
    ? "xhigh"
    : (levels[levels.length - 1] ?? null)
}

/** Which model answers, and how hard it thinks. */
export interface WebGptTarget {
  /** The slug chatgpt.com knows this by. */
  readonly slug: string
  /** Its `thinking_effort`, or null to leave the web app's own default. */
  readonly thinkingEffort: string | null
}

/**
 * Resolve a Cursor model and rung into the model chatgpt.com should answer
 * with.
 *
 * The two travel together because the top rung changes both: asking for Max is
 * asking for the Pro model, not for a deeper effort on this one.
 *
 * A rung the model does not have is clamped rather than refused — Cursor's
 * ladder is longer than the web app's, and the OpenAI surface takes whatever
 * effort a caller cares to send.
 */
export function webGptTarget(
  modelId: string,
  requestedDepth?: string | null
): WebGptTarget {
  const named = (readWebGptModel(modelId) ?? modelId).trim()
  const model = webGptModel(modelId)
  if (!model) return { slug: named, thinkingEffort: null }

  const levels = webGptCursorEffortLevels(modelId)
  const asked = (requestedDepth ?? webGptDefaultLevel(modelId) ?? "")
    .trim()
    .toLowerCase()

  // Cursor's ladder is read first, because both ladders have a rung spelled
  // `max` and they do not mean the same thing: on Cursor's it is the top stop,
  // which here is Pro; on ChatGPT's it is the deepest effort, which Cursor
  // calls Extra high. A caller who wants that effort by name asks for `xhigh`.
  if (model.pro && (asked === WEB_GPT_PRO_LEVEL || asked === "ultra")) {
    return { slug: model.pro, thinkingEffort: null }
  }
  if (!levels.length) return { slug: model.thinking, thinkingEffort: null }

  // Otherwise either vocabulary is accepted: ChatGPT's own words map to the
  // rung that sends them.
  const fromEffort = WEB_GPT_EFFORTS.find((rung) => rung.effort === asked)
  const level = fromEffort?.level ?? asked

  const onLadder = WEB_GPT_EFFORTS.find((rung) => rung.level === level)
  // Anything else is off the ends of this ladder: `minimal` below it, and a
  // rung Cursor has above Extra high but short of Pro. Clamp rather than
  // refuse — the OpenAI surface takes whatever effort a caller sends.
  const rung =
    onLadder ??
    (level === "minimal"
      ? WEB_GPT_EFFORTS[0]
      : WEB_GPT_EFFORTS[WEB_GPT_EFFORTS.length - 1])
  return { slug: model.thinking, thinkingEffort: rung?.effort ?? null }
}

/** The slug alone, for a caller that has no rung to offer. */
export function webGptUpstreamSlug(modelId: string): string {
  return webGptTarget(modelId).slug
}

export const WEB_GPT_CURSOR_DISPLAY_MODELS: CursorDisplayModel[] = [
  // One entry per model ChatGPT's Chat tab offers, under the name its own
  // catalogue gives it. The Pro tiers are not entries of their own: they are
  // the top rung of the model they belong to.
  ...Object.keys(WEB_GPT_MODELS).map((slug) => {
    const label = WEB_GPT_LABELS[slug] || slug
    return {
      name: `web-gpt/${slug}`,
      displayName: `${label} (Web)`,
      shortName: `${label} Web`,
      family: "gpt" as const,
      isThinking: webGptCursorEffortLevels(`web-gpt/${slug}`).length > 0,
      supportsAgent: true,
      // The transport flattens a turn down to the text chatgpt.com's composer
      // accepts, so an attached image would be dropped without a word. Saying
      // so here means the editor never offers to attach one.
      supportsImages: false,
    }
  }),
  // Not a model at all: the parked turn that lets a conversation started in
  // ChatGPT's own UI reach this editor. It is listed here because picking a
  // model is how a Cursor turn gets started, and a turn is the only place a
  // Cursor tool can run. It answers nothing on its own.
  {
    name: "web-gpt/tool-host",
    displayName: "ChatGPT Tool Host",
    shortName: "Tool Host",
    family: "gpt",
    isThinking: false,
    supportsAgent: true,
    supportsImages: false,
  },
]

const ALL_CURSOR_DISPLAY_MODELS: CursorDisplayModel[] = [
  ...CLAUDE_CURSOR_DISPLAY_MODELS,
  ...GEMINI_CURSOR_DISPLAY_MODELS,
  ...CODEX_CURSOR_DISPLAY_MODELS,
  ...WEB_GPT_CURSOR_DISPLAY_MODELS,
]

const CURSOR_DISPLAY_MODEL_BY_NAME = new Map(
  ALL_CURSOR_DISPLAY_MODELS.map(
    (model) => [model.name.toLowerCase(), model] as const
  )
)

export function getCursorDisplayModel(
  modelId: string
): CursorDisplayModel | null {
  const profile = getCodexModelProfile(
    parseModelRequest(modelId).normalizedBaseModel
  )
  if (profile) return codexDisplayModel(profile)
  return (
    CURSOR_DISPLAY_MODEL_BY_NAME.get(
      parseModelRequest(modelId).normalizedBaseModel
    ) || null
  )
}

/**
 * Some public model IDs imply Cursor-facing thinking/max semantics even if the
 * provider-specific upstream model name does not literally contain
 * "thinking". When an account strips thinking fields, those public IDs should
 * not be exposed or matched by that account.
 */
export function doesModelIdRequireExplicitThinkingSupport(
  modelId: string
): boolean {
  const normalized = parseModelRequest(modelId).normalizedBaseModel
  if (!normalized) {
    return false
  }

  if (normalized.includes("thinking")) {
    return true
  }

  const resolved = resolveCloudCodeModel(normalized)
  return (
    resolved?.family === "claude" &&
    !!resolveModelThinkingCapability(normalized)
  )
}

export function canPublicClaudeModelUseGoogle(modelId: string): boolean {
  const normalized = parseModelRequest(modelId).normalizedBaseModel
  const resolved = resolveCloudCodeModel(normalized)
  if (!resolved || resolved.family !== "claude") {
    return false
  }

  // Google Cloud Code 侧当前没有 Haiku 产品线，
  // registry 中的 Haiku -> Sonnet 映射不能被当成 Google 可原生承载的证据。
  if (normalized.includes("haiku")) {
    return false
  }

  // Opus models always route through Google (only thinking variant exists)
  if (isOpusModel(normalized)) {
    return true
  }

  return (
    normalized.includes("sonnet") ||
    !!resolveModelThinkingCapability(normalized) ||
    !resolved.cloudCodeId.includes("thinking")
  )
}

/**
 * Determine whether a Claude public model ID can be served by the Kiro backend
 * (AWS CodeWhisperer / Q). Kiro currently exposes Sonnet, Opus, and Haiku
 * variants via Anthropic's branded model IDs.
 */
export function canPublicClaudeModelUseKiro(modelId: string): boolean {
  const normalized = parseModelRequest(modelId).normalizedBaseModel
  const resolved = resolveCloudCodeModel(normalized)
  if (!resolved || resolved.family !== "claude") {
    return false
  }

  return (
    normalized.includes("sonnet") ||
    normalized.includes("opus") ||
    normalized.includes("haiku")
  )
}

export function normalizeCodexModelTier(
  value?: string | null
): CodexModelTier | null {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) {
    return null
  }

  if (
    normalized === "team" ||
    normalized === "business" ||
    normalized.includes("team")
  ) {
    return "team"
  }
  if (normalized === "plus" || normalized.includes("plus")) {
    return "plus"
  }
  if (
    normalized === "pro" ||
    normalized === "enterprise" ||
    normalized.includes("pro")
  ) {
    return "pro"
  }
  if (normalized === "free" || normalized.includes("free")) {
    return "free"
  }

  return null
}

export function getCodexCursorDisplayModels(
  options: Omit<CursorDisplayModelOptions, "includeCodex"> = {}
): CursorDisplayModel[] {
  const excludeMaxNamedModels = options.excludeMaxNamedModels ?? false
  const normalizedTier = normalizeCodexModelTier(options.codexModelTier)

  let models = listCodexModelProfiles()
    .filter(
      (profile) =>
        !normalizedTier ||
        supportsCodexModelForTier(profile.slug, normalizedTier)
    )
    .map(codexDisplayModel)

  if (excludeMaxNamedModels) {
    models = models.filter((model) => !model.name.includes("max"))
  }

  return models
}

export function getCodexModelIdsForTier(
  tier?: string | null
): readonly string[] {
  const normalizedTier = normalizeCodexModelTier(tier)
  return listCodexModelProfiles()
    .filter(
      (p) =>
        !normalizedTier ||
        p.available_in_plans.length === 0 ||
        p.available_in_plans.some(
          (plan) => normalizeCodexModelTier(plan) === normalizedTier
        )
    )
    .map((p) => p.slug)
}

export function supportsCodexModelForTier(
  modelId: string,
  tier?: string | null
): boolean {
  const normalized = parseModelRequest(modelId).normalizedBaseModel
  if (!normalized) {
    return false
  }
  return new Set(getCodexModelIdsForTier(tier)).has(normalized)
}

export function getCodexPublicModelIds(
  options: Omit<CursorDisplayModelOptions, "includeCodex"> = {}
): string[] {
  return getCodexCursorDisplayModels(options).map((model) => model.name)
}

export function isChatGptCodexModelSupported(modelId: string): boolean {
  const normalized = parseModelRequest(modelId).normalizedBaseModel
  if (!normalized) {
    return false
  }

  return getCodexModelProfile(normalized) !== undefined
}

export function getCursorDisplayModels(
  options: CursorDisplayModelOptions = {}
): CursorDisplayModel[] {
  const includeCodex = options.includeCodex ?? true

  const allModels = [
    ...CLAUDE_CURSOR_DISPLAY_MODELS,
    ...GEMINI_CURSOR_DISPLAY_MODELS,
    ...(includeCodex
      ? getCodexCursorDisplayModels({
          codexModelTier: options.codexModelTier,
          excludeMaxNamedModels: options.excludeMaxNamedModels,
        })
      : []),
    // Listed regardless of `includeCodex`: these are served by chatgpt.com's
    // web app, so the Codex backend being absent says nothing about them.
    // Whether one can actually run is the caller's routability check, which is
    // where the ChatGPT credential is known.
    ...WEB_GPT_CURSOR_DISPLAY_MODELS,
    ...(options.extraModels || []),
  ]

  const filteredModels = options.excludeMaxNamedModels
    ? allModels.filter((model) => !model.name.includes("max"))
    : allModels

  // Two-pass merge: the first occurrence anchors the display position so the
  // curated static order (Claude → Gemini → Codex) is preserved. Subsequent
  // occurrences with the same name only refresh the label fields, and only
  // when the upstream value is non-degenerate — i.e. trimmed, non-empty, and
  // not just the modelId echoed back as a fallback. This lets dynamic Cloud
  // Code metadata correct stale hand-coded `displayName`/`shortName` (e.g.
  // `Gemini 3.1 Pro High` → `Gemini 3.1 Pro (High)`) without letting an
  // adapter that fell back to the modelId ever overwrite a curated label.
  const dedupedModels: CursorDisplayModel[] = []
  const indexByName = new Map<string, number>()
  for (const model of filteredModels) {
    const normalized = model.name.toLowerCase().trim()
    if (!normalized) {
      continue
    }
    const existingIndex = indexByName.get(normalized)
    if (existingIndex === undefined) {
      indexByName.set(normalized, dedupedModels.length)
      dedupedModels.push(model)
      continue
    }
    const existing = dedupedModels[existingIndex]!
    const merged: CursorDisplayModel = { ...existing }
    const idLower = normalized
    const refinedDisplayName = model.displayName?.trim()
    if (
      refinedDisplayName &&
      refinedDisplayName.length > 0 &&
      refinedDisplayName.toLowerCase() !== idLower
    ) {
      merged.displayName = refinedDisplayName
    }
    const refinedShortName = model.shortName?.trim()
    if (
      refinedShortName &&
      refinedShortName.length > 0 &&
      refinedShortName.toLowerCase() !== idLower
    ) {
      merged.shortName = refinedShortName
    }
    dedupedModels[existingIndex] = merged
  }

  return dedupedModels
}

export function getAllCursorDisplayModels(): CursorDisplayModel[] {
  return getCursorDisplayModels()
}
