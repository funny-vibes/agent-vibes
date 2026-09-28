const MAX_REALTIME_SDP_LENGTH = 1_000_000
const MAX_REALTIME_SESSION_LENGTH = 64_000

export const DEFAULT_REALTIME_MODEL = "gpt-realtime"

export interface ChatGptWebRealtimeCallRequest {
  sdp: string
  session: Record<string, unknown>
}

export interface ChatGptWebRealtimeCallResult {
  callId: string
  sdp: string
  transport: "chatgpt-web-voice" | "codex-voice"
}

export class ChatGptWebRealtimeRequestError extends Error {
  constructor(
    message: string,
    public readonly param: string | null = null
  ) {
    super(message)
    this.name = "ChatGptWebRealtimeRequestError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function normalizeSdp(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ChatGptWebRealtimeRequestError(
      "sdp is required and must be a string",
      "sdp"
    )
  }
  if (value.length > MAX_REALTIME_SDP_LENGTH) {
    throw new ChatGptWebRealtimeRequestError(
      `sdp exceeds ${MAX_REALTIME_SDP_LENGTH} characters`,
      "sdp"
    )
  }
  if (!/^v=0(?:\r?\n|$)/.test(value)) {
    throw new ChatGptWebRealtimeRequestError(
      "sdp must be a browser-generated WebRTC offer",
      "sdp"
    )
  }
  if (!/(?:^|\r?\n)m=audio\s/.test(value)) {
    throw new ChatGptWebRealtimeRequestError(
      "sdp must include an audio media section",
      "sdp"
    )
  }
  if (!/(?:^|\r?\n)m=application\s.*webrtc-datachannel/.test(value)) {
    throw new ChatGptWebRealtimeRequestError(
      "sdp must include a WebRTC data channel for Realtime events",
      "sdp"
    )
  }
  return value
}

function normalizeSession(value: unknown): Record<string, unknown> {
  if (value == null) {
    return { type: "realtime", model: DEFAULT_REALTIME_MODEL }
  }
  if (!isRecord(value)) {
    throw new ChatGptWebRealtimeRequestError(
      "session must be a JSON object",
      "session"
    )
  }

  const serialized = JSON.stringify(value)
  if (serialized.length > MAX_REALTIME_SESSION_LENGTH) {
    throw new ChatGptWebRealtimeRequestError(
      `session exceeds ${MAX_REALTIME_SESSION_LENGTH} characters`,
      "session"
    )
  }

  const type = value.type ?? "realtime"
  if (type !== "realtime") {
    throw new ChatGptWebRealtimeRequestError(
      "session.type must be realtime",
      "session.type"
    )
  }

  const model = value.model ?? DEFAULT_REALTIME_MODEL
  if (
    typeof model !== "string" ||
    model.trim() === "" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(model)
  ) {
    throw new ChatGptWebRealtimeRequestError(
      "session.model must be a valid model identifier",
      "session.model"
    )
  }

  return { ...value, type, model }
}

export function normalizeChatGptWebRealtimeCallRequest(
  value: unknown
): ChatGptWebRealtimeCallRequest {
  if (!isRecord(value)) {
    throw new ChatGptWebRealtimeRequestError(
      "request body must be a JSON object",
      null
    )
  }

  return {
    sdp: normalizeSdp(value.sdp),
    session: normalizeSession(value.session),
  }
}

function parseMultipartField(
  part: string
): { name: string; value: string } | null {
  const separator = part.indexOf("\r\n\r\n")
  if (separator < 0) return null

  const rawHeaders = part.slice(0, separator)
  const disposition = rawHeaders
    .split("\r\n")
    .find((line) => /^content-disposition:/i.test(line))
  const name = disposition?.match(/(?:^|;)\s*name="([^"]+)"/i)?.[1]
  if (!name) return null

  return {
    name,
    value: part.slice(separator + 4).replace(/\r\n$/, ""),
  }
}

export function parseRealtimeMultipartBody(
  body: Buffer,
  contentType: string
): ChatGptWebRealtimeCallRequest {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
  if (!boundary) {
    throw new ChatGptWebRealtimeRequestError(
      "multipart boundary is missing",
      null
    )
  }

  const fields = new Map<string, string>()
  for (const rawPart of body.toString("utf8").split(`--${boundary}`)) {
    const part = rawPart.replace(/^\r\n/, "")
    if (!part || part === "--\r\n" || part === "--") continue
    const field = parseMultipartField(part)
    if (!field) continue
    if (fields.has(field.name)) {
      throw new ChatGptWebRealtimeRequestError(
        `multipart field ${field.name} must appear only once`,
        field.name
      )
    }
    fields.set(field.name, field.value)
  }

  const rawSession = fields.get("session")
  let session: unknown
  if (rawSession != null) {
    try {
      session = JSON.parse(rawSession)
    } catch {
      throw new ChatGptWebRealtimeRequestError(
        "session must contain valid JSON",
        "session"
      )
    }
  }

  return normalizeChatGptWebRealtimeCallRequest({
    sdp: fields.get("sdp"),
    session,
  })
}

export function parseChatGptWebRealtimeCallRequest(
  body: unknown,
  contentType: string
): ChatGptWebRealtimeCallRequest {
  const normalizedContentType = contentType.toLowerCase()
  if (normalizedContentType.startsWith("multipart/form-data")) {
    if (!Buffer.isBuffer(body)) {
      throw new ChatGptWebRealtimeRequestError(
        "multipart request body is unavailable",
        null
      )
    }
    return parseRealtimeMultipartBody(body, contentType)
  }

  if (
    normalizedContentType.startsWith("application/sdp") ||
    normalizedContentType.startsWith("text/plain")
  ) {
    const sdp = Buffer.isBuffer(body) ? body.toString("utf8") : body
    return normalizeChatGptWebRealtimeCallRequest({ sdp })
  }

  return normalizeChatGptWebRealtimeCallRequest(body)
}
