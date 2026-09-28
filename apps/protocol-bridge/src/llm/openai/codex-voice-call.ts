/**
 * Codex voice: the GPT-Live call Codex itself opens, at the Codex backend's
 * `realtime/calls`. Unlike ChatGPT Web voice, the caller writes the voice
 * model's instructions and chooses how it delegates; with client delegation
 * the page that holds the call receives `delegation.created` on its data
 * channel and answers with `delegation.context.append`.
 */

/** Sessions for these models go to Codex voice instead of ChatGPT Web. */
export function isCodexVoiceSession(session: Record<string, unknown>): boolean {
  return typeof session.model === "string" && /^gpt-live/.test(session.model)
}

/** The fields Codex voice accepts at call creation, in its own shape. */
export function buildCodexVoiceSession(
  session: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { model: session.model }
  if (typeof session.instructions === "string") {
    out.instructions = session.instructions
  }
  const voice = requestedVoice(session)
  if (voice) out.audio = { output: { voice } }
  if (isRecord(session.delegation)) out.delegation = session.delegation
  if (Array.isArray(session.initial_items)) {
    out.initial_items = session.initial_items
  }
  return out
}

export function codexVoiceCallUrl(callUrl: string): string {
  const url = new URL(callUrl)
  url.searchParams.set("intent", "quicksilver")
  url.searchParams.set("architecture", "avas")
  return url.toString()
}

/** The call id Codex voice names in the Location of a created call. */
export function codexVoiceCallId(location: string | null): string | null {
  if (!location) return null
  const segments = location.split("?")[0]!.split("/").filter(Boolean)
  const last = segments[segments.length - 1]
  return last && /^(rtc_[A-Za-z0-9_-]+|[0-9a-f-]{36})$/.test(last) ? last : null
}

function requestedVoice(session: Record<string, unknown>): string | null {
  if (typeof session.voice === "string" && session.voice.trim()) {
    return session.voice.trim()
  }
  const audio = isRecord(session.audio) ? session.audio : null
  const output = audio && isRecord(audio.output) ? audio.output : null
  return output && typeof output.voice === "string" && output.voice.trim()
    ? output.voice.trim()
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
