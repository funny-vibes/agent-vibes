import { GptRequestError } from "../shared/gpt-api-contract"
import { Injectable, Logger } from "@nestjs/common"
import * as crypto from "node:crypto"
import type { CodexRealtimeAccountLease } from "./codex-realtime-account"
import { CodexService } from "./codex.service"
import type {
  ChatGptWebRealtimeCallRequest,
  ChatGptWebRealtimeCallResult,
} from "./chatgpt-web-realtime"
import {
  type ChatGptWebVoiceSettings,
  ChatGptWebVoiceTransport,
} from "./chatgpt-web-transport"

export class ChatGptWebRealtimeServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "ChatGptWebRealtimeServiceError"
  }
}

@Injectable()
export class ChatGptWebRealtimeService {
  private readonly logger = new Logger(ChatGptWebRealtimeService.name)

  constructor(
    private readonly codex: CodexService,
    private readonly transport: ChatGptWebVoiceTransport
  ) {}

  async createCall(
    request: ChatGptWebRealtimeCallRequest
  ): Promise<ChatGptWebRealtimeCallResult> {
    if (request.historyPolicy !== "delete_after_completion") {
      throw new GptRequestError(
        "ChatGPT Web voice requires history_policy: delete_after_completion",
        "history_policy"
      )
    }
    normalizeChatGptWebVoice(resolveRequestedVoice(request.session))
    const accountCount = this.codex.getChatGptWebRealtimeAccountCount()
    if (accountCount === 0) {
      throw new ChatGptWebRealtimeServiceError(
        503,
        "realtime_not_configured",
        "No ChatGPT OAuth account is configured for Realtime voice"
      )
    }

    const excluded = new Set<string>()
    const failures: string[] = []
    for (let attempt = 0; attempt < accountCount; attempt += 1) {
      const lease = await this.codex.acquireChatGptWebRealtimeAccount(excluded)
      if (!lease) break
      excluded.add(lease.accountKey)

      const result = await this.tryCreateCall(request, lease, failures)
      if (result) return result
    }

    if (excluded.size === 0) {
      throw new ChatGptWebRealtimeServiceError(
        503,
        "realtime_temporarily_unavailable",
        "All configured ChatGPT OAuth accounts are temporarily unavailable"
      )
    }

    this.logger.warn(
      `ChatGPT Web Realtime call failed across ${excluded.size} account(s): ${failures.join(" | ").slice(0, 1_000)}`
    )
    throw new ChatGptWebRealtimeServiceError(
      502,
      "realtime_upstream_unavailable",
      "ChatGPT Web Realtime did not accept the call"
    )
  }

  private async tryCreateCall(
    request: ChatGptWebRealtimeCallRequest,
    lease: CodexRealtimeAccountLease,
    failures: string[]
  ): Promise<ChatGptWebRealtimeCallResult | null> {
    let accessToken = lease.accessToken
    let authRefreshed = false

    while (true) {
      try {
        const voice = normalizeChatGptWebVoice(
          resolveRequestedVoice(request.session)
        )
        const response = await this.transport.post({
          endpoint: this.transport.settings.endpoint,
          offerSdp: normalizeOfferSdp(request.sdp),
          sessionJson: JSON.stringify(
            buildChatGptWebSession(this.transport.settings, voice)
          ),
          headers: buildChatGptWebHeaders(
            this.transport.settings,
            accessToken,
            lease.deviceId
          ),
          proxyUrl: lease.proxyUrl,
        })

        if (response.status === 200 || response.status === 201) {
          if (!response.text.trim().startsWith("v=0")) {
            lease.reject(
              502,
              "ChatGPT Web voice returned an invalid SDP response"
            )
            failures.push(`${lease.label}: invalid SDP response`)
            return null
          }
          lease.accept()
          return {
            callId: `web_${crypto.randomUUID().replaceAll("-", "")}`,
            sdp: response.text,
            transport: "chatgpt-web-voice",
            accountKey: lease.accountKey,
          }
        }

        if (
          !authRefreshed &&
          (response.status === 401 || response.status === 403)
        ) {
          authRefreshed = true
          const refreshedToken = await lease.refreshAccessToken(
            `ChatGPT Web Realtime HTTP ${response.status}`
          )
          if (refreshedToken) {
            accessToken = refreshedToken
            continue
          }
        }

        const detail = safeDetail(response.text)
        lease.reject(response.status || 502, detail)
        failures.push(`${lease.label}: HTTP ${response.status} ${detail}`)
        return null
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        lease.reject(502, detail)
        failures.push(`${lease.label}: ${detail}`)
        return null
      }
    }
  }
}

export function buildChatGptWebSession(
  settings: ChatGptWebVoiceSettings,
  voice: string
): Record<string, unknown> {
  const sessionId = crypto.randomUUID().toUpperCase()
  return {
    backend_reasoning_effort: "instant",
    language_code: "auto",
    requested_default_model: "",
    voice,
    voice_session_id: sessionId,
    voice_status_request_id: sessionId,
    timezone_offset_min: settings.timezoneOffsetMinutes,
    timezone: settings.timezone,
    voice_mode: "wingman",
    model_slug: "",
    model_slug_advanced: "",
    client_tools: [],
    // Web voice rejects temporary chats. The gateway tracks end-of-call cleanup.
    history_and_training_disabled: false,
    conversation_mode: { kind: "primary_assistant" },
    enable_message_streaming: true,
  }
}

export function buildChatGptWebHeaders(
  settings: ChatGptWebVoiceSettings,
  token: string,
  deviceId: string
): Record<string, string> {
  return {
    accept: "*/*",
    origin: "https://chatgpt.com",
    referer: "https://chatgpt.com/",
    "user-agent": settings.userAgent,
    "oai-device-id": deviceId,
    "oai-language": settings.language,
    "oai-client-version": settings.clientVersion,
    "oai-client-build-number": settings.clientBuildNumber,
    authorization: `Bearer ${token}`,
  }
}

function normalizeOfferSdp(value: string): string {
  const normalized = value
    .trim()
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\n", "\r\n")
  return normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`
}

function resolveRequestedVoice(session: Record<string, unknown>): string {
  if (typeof session.voice === "string") return session.voice
  const audio = isRecord(session.audio) ? session.audio : null
  const output = audio && isRecord(audio.output) ? audio.output : null
  return output && typeof output.voice === "string" ? output.voice : "cove"
}

const CHATGPT_WEB_VOICES = new Set([
  "breeze",
  "cove",
  "ember",
  "fathom",
  "glimmer",
  "juniper",
  "maple",
  "orbit",
  "vale",
])

export function normalizeChatGptWebVoice(value: string): string {
  const aliases: Record<string, string> = {
    arbor: "fathom",
    marin: "cove",
    cedar: "cove",
    sol: "glimmer",
    spruce: "orbit",
  }
  const normalized = value.trim().toLowerCase()
  const resolved = aliases[normalized] || normalized
  if (!CHATGPT_WEB_VOICES.has(resolved))
    throw new GptRequestError(
      `Unsupported ChatGPT Web voice: ${value}`,
      "session.voice"
    )
  return resolved
}

function safeDetail(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500) || "empty response"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
