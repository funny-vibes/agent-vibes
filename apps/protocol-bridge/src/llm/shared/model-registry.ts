/**
 * Unified Model Registry
 *
 * Single source of truth for all model name mappings, aliases, and metadata.
 * Replaces scattered mappings in: model-router.service.ts, google.service.ts,
 * and google-model-cache.service.ts.
 */

import { parseModelRequest } from "./model-request"

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
    cloudCodeId: "gemini-3.1-pro-high",
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
    cloudCodeId: "gemini-3-flash-preview",
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
    cloudCodeId: "claude-opus-4-6-thinking",
    displayName: "Claude Opus 4",
    isThinking: true,
  },
  "claude-4-opus": {
    cloudCodeId: "claude-opus-4-6-thinking",
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
  "gpt-5": {
    cloudCodeId: "gpt-5",
    displayName: "GPT-5",
    isThinking: true,
    thinking: createLevelThinkingCapability([
      "minimal",
      "low",
      "medium",
      "high",
    ]),
  },
  "gpt-5-codex": {
    cloudCodeId: "gpt-5-codex",
    displayName: "GPT-5 Codex",
    isThinking: true,
    thinking: createLevelThinkingCapability(["low", "medium", "high"]),
  },
  "gpt-5-codex-mini": {
    cloudCodeId: "gpt-5-codex-mini",
    displayName: "GPT-5 Codex Mini",
    isThinking: true,
    thinking: createLevelThinkingCapability(["low", "medium", "high"]),
  },
  "gpt-5.1": {
    cloudCodeId: "gpt-5.1",
    displayName: "GPT-5.1",
    isThinking: true,
    thinking: createLevelThinkingCapability(["none", "low", "medium", "high"]),
  },
  "gpt-5.1-codex": {
    cloudCodeId: "gpt-5.1-codex",
    displayName: "GPT-5.1 Codex",
    isThinking: true,
    thinking: createLevelThinkingCapability(["low", "medium", "high"]),
  },
  "gpt-5.1-codex-mini": {
    cloudCodeId: "gpt-5.1-codex-mini",
    displayName: "GPT-5.1 Codex Mini",
    isThinking: true,
    thinking: createLevelThinkingCapability(["low", "medium", "high"]),
  },
  "gpt-5.1-codex-max": {
    cloudCodeId: "gpt-5.1-codex-max",
    displayName: "GPT-5.1 Codex Max",
    isThinking: true,
    thinking: createLevelThinkingCapability(["low", "medium", "high", "xhigh"]),
  },
  "gpt-5.2": {
    cloudCodeId: "gpt-5.2",
    displayName: "GPT-5.2",
    isThinking: true,
    thinking: createLevelThinkingCapability([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]),
  },
  "gpt-5.2-codex": {
    cloudCodeId: "gpt-5.2-codex",
    displayName: "GPT-5.2 Codex",
    isThinking: true,
    thinking: createLevelThinkingCapability(["low", "medium", "high", "xhigh"]),
  },
  "gpt-5.3-codex": {
    cloudCodeId: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    isThinking: true,
    thinking: createLevelThinkingCapability(["low", "medium", "high", "xhigh"]),
  },
  "gpt-5.3-codex-spark": {
    cloudCodeId: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3 Codex Spark",
    isThinking: true,
    thinking: createLevelThinkingCapability(["low", "medium", "high", "xhigh"]),
  },
  "gpt-5.4": {
    cloudCodeId: "gpt-5.4",
    displayName: "GPT-5.4",
    isThinking: true,
    thinking: createLevelThinkingCapability(["low", "medium", "high", "xhigh"]),
  },
  "gpt-5.4-mini": {
    cloudCodeId: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    isThinking: true,
    thinking: createLevelThinkingCapability(["low", "medium", "high", "xhigh"]),
  },

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

const CODEX_GPT5_MODEL_IDS_BY_TIER: Record<CodexModelTier, readonly string[]> =
  {
    free: [
      "gpt-5",
      "gpt-5-codex",
      "gpt-5-codex-mini",
      "gpt-5.1",
      "gpt-5.1-codex",
      "gpt-5.1-codex-mini",
      "gpt-5.1-codex-max",
      "gpt-5.2",
      "gpt-5.2-codex",
      "gpt-5.3-codex",
      "gpt-5.4",
      "gpt-5.4-mini",
    ],
    team: [
      "gpt-5",
      "gpt-5-codex",
      "gpt-5-codex-mini",
      "gpt-5.1",
      "gpt-5.1-codex",
      "gpt-5.1-codex-mini",
      "gpt-5.1-codex-max",
      "gpt-5.2",
      "gpt-5.2-codex",
      "gpt-5.3-codex",
      "gpt-5.4",
      "gpt-5.4-mini",
    ],
    plus: [
      "gpt-5",
      "gpt-5-codex",
      "gpt-5-codex-mini",
      "gpt-5.1",
      "gpt-5.1-codex",
      "gpt-5.1-codex-mini",
      "gpt-5.1-codex-max",
      "gpt-5.2",
      "gpt-5.2-codex",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.4",
      "gpt-5.4-mini",
    ],
    pro: [
      "gpt-5",
      "gpt-5-codex",
      "gpt-5-codex-mini",
      "gpt-5.1",
      "gpt-5.1-codex",
      "gpt-5.1-codex-mini",
      "gpt-5.1-codex-max",
      "gpt-5.2",
      "gpt-5.2-codex",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.4",
      "gpt-5.4-mini",
    ],
  }

const CODEX_OFFICIAL_MODEL_IDS = Array.from(
  new Set(Object.values(CODEX_GPT5_MODEL_IDS_BY_TIER).flat())
)

const CHATGPT_CODEX_MODEL_IDS = new Set(CODEX_OFFICIAL_MODEL_IDS)

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default Gemini model when no mapping found */
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-pro-high"

/** Default Claude model when no mapping found */
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-5"

/** Default Codex model when no mapping found */
export const DEFAULT_CODEX_MODEL = "gpt-5-codex-mini"

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
    return {
      cloudCodeId: normalized,
      displayName: normalized,
      family: "gemini",
      isThinking: false,
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

export function resolveModelThinkingCapability(
  modelId: string
): ThinkingCapability | null {
  const resolved = resolveCloudCodeModel(modelId)
  if (resolved?.thinking) {
    return resolved.thinking
  }

  if (resolved?.isThinking) {
    // 只有 GPT / Codex 这类模型在缺少显式 thinking metadata 时，
    // 才回退为 level-based reasoning capability。
    // Claude / Gemini 的 isThinking 更接近布尔 thinking toggle，
    // 不能错误投影成 low / medium / high effort。
    if (resolved.family === "gpt") {
      return createLevelThinkingCapability(["low", "medium", "high"])
    }
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

const DEFAULT_VISIBLE_CODEX_CURSOR_MODEL_IDS = new Set([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2",
])

export const BASE_CODEX_CURSOR_DISPLAY_MODELS: CursorDisplayModel[] = [
  {
    name: "gpt-5.4",
    displayName: "GPT-5.4",
    shortName: "GPT-5.4",
    family: "gpt",
    isThinking: true,
  },
  {
    name: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    shortName: "GPT-5.4 Mini",
    family: "gpt",
    isThinking: true,
  },
  {
    name: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    shortName: "GPT-5.3 Codex",
    family: "gpt",
    isThinking: true,
  },
  {
    name: "gpt-5.2",
    displayName: "GPT-5.2",
    shortName: "GPT-5.2",
    family: "gpt",
    isThinking: true,
  },
  {
    name: "gpt-5",
    displayName: "GPT-5",
    shortName: "GPT-5",
    family: "gpt",
    isThinking: true,
  },
  {
    name: "gpt-5-codex",
    displayName: "GPT-5 Codex",
    shortName: "GPT-5 Codex",
    family: "gpt",
    isThinking: true,
  },
  {
    name: "gpt-5-codex-mini",
    displayName: "GPT-5 Codex Mini",
    shortName: "GPT-5 Mini",
    family: "gpt",
    isThinking: true,
  },
  {
    name: "gpt-5.1",
    displayName: "GPT-5.1",
    shortName: "GPT-5.1",
    family: "gpt",
    isThinking: true,
  },
  {
    name: "gpt-5.1-codex",
    displayName: "GPT-5.1 Codex",
    shortName: "GPT-5.1 Codex",
    family: "gpt",
    isThinking: true,
  },
  {
    name: "gpt-5.1-codex-mini",
    displayName: "GPT-5.1 Codex Mini",
    shortName: "GPT-5.1 Mini",
    family: "gpt",
    isThinking: true,
  },
  {
    name: "gpt-5.1-codex-max",
    displayName: "GPT-5.1 Codex Max",
    shortName: "GPT-5.1 Max",
    family: "gpt",
    isThinking: true,
  },
  {
    name: "gpt-5.2-codex",
    displayName: "GPT-5.2 Codex",
    shortName: "GPT-5.2 Codex",
    family: "gpt",
    isThinking: true,
  },
  {
    name: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3 Codex Spark",
    shortName: "GPT-5.3 Spark",
    family: "gpt",
    isThinking: true,
  },
]

export const CODEX_CURSOR_DISPLAY_MODELS: CursorDisplayModel[] =
  BASE_CODEX_CURSOR_DISPLAY_MODELS.map(
    (model): CursorDisplayModel =>
      DEFAULT_VISIBLE_CODEX_CURSOR_MODEL_IDS.has(model.name)
        ? model
        : {
            ...model,
            isHidden: true,
          }
  )

const ALL_CURSOR_DISPLAY_MODELS: CursorDisplayModel[] = [
  ...CLAUDE_CURSOR_DISPLAY_MODELS,
  ...GEMINI_CURSOR_DISPLAY_MODELS,
  ...CODEX_CURSOR_DISPLAY_MODELS,
]

const CURSOR_DISPLAY_MODEL_BY_NAME = new Map(
  ALL_CURSOR_DISPLAY_MODELS.map(
    (model) => [model.name.toLowerCase(), model] as const
  )
)

export function getCursorDisplayModel(
  modelId: string
): CursorDisplayModel | null {
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

  const allowedModelIds = new Set<string>(
    normalizedTier
      ? CODEX_GPT5_MODEL_IDS_BY_TIER[normalizedTier]
      : CODEX_OFFICIAL_MODEL_IDS
  )
  let models = CODEX_CURSOR_DISPLAY_MODELS.filter((model) =>
    allowedModelIds.has(model.name)
  )

  if (excludeMaxNamedModels) {
    models = models.filter((model) => !model.name.includes("max"))
  }

  return models
}

export function getCodexModelIdsForTier(
  tier?: string | null
): readonly string[] {
  const normalizedTier = normalizeCodexModelTier(tier)
  return normalizedTier
    ? CODEX_GPT5_MODEL_IDS_BY_TIER[normalizedTier]
    : CODEX_OFFICIAL_MODEL_IDS
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

  return CHATGPT_CODEX_MODEL_IDS.has(normalized)
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
    ...(options.extraModels || []),
  ]

  const filteredModels = options.excludeMaxNamedModels
    ? allModels.filter((model) => !model.name.includes("max"))
    : allModels

  const dedupedModels: CursorDisplayModel[] = []
  const seen = new Set<string>()
  for (const model of filteredModels) {
    const normalized = model.name.toLowerCase().trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    dedupedModels.push(model)
  }

  return dedupedModels
}

export function getAllCursorDisplayModels(): CursorDisplayModel[] {
  return getCursorDisplayModels()
}
