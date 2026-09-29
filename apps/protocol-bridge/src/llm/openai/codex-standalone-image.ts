import type { CodexProviderIdentity } from "./codex-provider-identity"

/**
 * Native Codex image generation, the way the official Codex CLI does it since
 * its standalone image extension: one POST to `images/generations` (or
 * `images/edits` when reference images are given) on the Codex backend, with
 * the fixed `gpt-image-2` model and a real `background` choice. The picture
 * comes back as `data[0].b64_json`; usage is metered on the backend's
 * separate `image_gen` limit rather than the conversation quota.
 */
export const CODEX_IMAGE_MODEL = "gpt-image-2"
export const CODEX_IMAGE_MAX_REFERENCES = 5

export type CodexImageBackground = "transparent" | "opaque" | "auto"

export interface CodexImageReference {
  readonly mimeType: string
  readonly data: string
}

export interface CodexStandaloneImageBody {
  readonly prompt: string
  readonly background: CodexImageBackground
  readonly model: typeof CODEX_IMAGE_MODEL
  readonly quality: "auto"
  readonly size: "auto"
  readonly images?: ReadonlyArray<{ readonly image_url: string }>
}

export interface CodexStandaloneImageRequest {
  /** Text model that picks the account slot and rate-limit bucket. */
  readonly model: string
  readonly localProjectionKey: string
  readonly upstreamIdentity: CodexProviderIdentity
  readonly endpoint: "images/generations" | "images/edits"
  readonly body: CodexStandaloneImageBody
}

export interface CodexStandaloneImageResult {
  readonly imageData: string
  readonly background?: CodexImageBackground
  readonly generationId?: string
  readonly revisedPrompt?: string
}

export function buildCodexStandaloneImageRequest(input: {
  readonly prompt: string
  readonly model: string
  readonly conversationId: string
  readonly upstreamIdentity: CodexProviderIdentity
  readonly background?: CodexImageBackground
  readonly referenceImages?: readonly CodexImageReference[]
}): CodexStandaloneImageRequest {
  const prompt = input.prompt.trim()
  if (!prompt) {
    throw new Error("Image generation prompt is required")
  }
  const references = (input.referenceImages ?? []).filter(
    (reference) => reference.data.trim().length > 0
  )
  if (references.length > CODEX_IMAGE_MAX_REFERENCES) {
    throw new Error(
      `Codex image edits accept at most ${CODEX_IMAGE_MAX_REFERENCES} reference images`
    )
  }
  const body: CodexStandaloneImageBody = {
    prompt,
    background: input.background ?? "opaque",
    model: CODEX_IMAGE_MODEL,
    quality: "auto",
    size: "auto",
    ...(references.length > 0
      ? {
          images: references.map((reference) => ({
            image_url: `data:${reference.mimeType || "image/png"};base64,${reference.data.trim()}`,
          })),
        }
      : {}),
  }
  return {
    model: input.model,
    localProjectionKey: input.conversationId,
    upstreamIdentity: input.upstreamIdentity,
    endpoint: references.length > 0 ? "images/edits" : "images/generations",
    body,
  }
}

export function decodeCodexStandaloneImageResponse(
  value: unknown
): CodexStandaloneImageResult {
  const response = requireRecord(value, "Codex image response")
  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new Error("Codex image response.data must be a non-empty array")
  }
  const first = requireRecord(response.data[0], "Codex image response.data[0]")
  const imageData =
    typeof first.b64_json === "string" ? first.b64_json.trim() : ""
  if (!imageData) {
    throw new Error("Codex image response.data[0].b64_json must be base64")
  }
  const background = decodeBackground(response.background)
  return {
    imageData,
    ...(background ? { background } : {}),
    ...(typeof first.generation_id === "string" && first.generation_id
      ? { generationId: first.generation_id }
      : {}),
    ...(typeof first.revised_prompt === "string" && first.revised_prompt
      ? { revisedPrompt: first.revised_prompt }
      : {}),
  }
}

export function normalizeCodexImageBackground(
  value: unknown
): CodexImageBackground | undefined {
  if (value === true) return "transparent"
  if (value === false) return "opaque"
  return decodeBackground(value)
}

function decodeBackground(value: unknown): CodexImageBackground | undefined {
  if (value === "transparent" || value === "opaque" || value === "auto") {
    return value
  }
  return undefined
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}
