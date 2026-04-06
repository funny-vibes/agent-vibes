#!/usr/bin/env node
/**
 * Cloud Code Native Worker Process
 *
 * Runs using the Antigravity IDE's own Node.js binary and modules.
 * Pulls behavior closer to the IDE's Cloud Code client without depending on
 * the official bundled language server binary.
 *
 * Communication: JSON Lines over stdin/stdout
 *
 * Request format:
 *   { "id": "req-1", "method": "generate", "params": { ... } }
 *
 * Response format:
 *   { "id": "req-1", "result": { ... } }             // success
 *   { "id": "req-1", "error": { "message": "..." } } // error
 *   { "id": "req-1", "stream": { ... } }              // streaming chunk
 *   { "id": "req-1", "stream": null }                 // stream end
 */

"use strict"

const { OAuth2Client } = require("google-auth-library")
const { HttpProxyAgent } = require("http-proxy-agent")
const { HttpsProxyAgent } = require("https-proxy-agent")
const { SocksProxyAgent } = require("socks-proxy-agent")
const os = require("os")
const readline = require("readline")

const ANTIGRAVITY_IDE_VERSION = "1.21.9"

// ---------------------------------------------------------------------------
// OAuth Credentials (Cloud Code API)
// ---------------------------------------------------------------------------
const OAUTH_NON_GCP = {
  clientId:
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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",
}

const OAUTH_GCP_TOS = {
  clientId:
    "884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com",
  clientSecret: "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",
}

// ---------------------------------------------------------------------------
// Cloud Code Endpoints
// ---------------------------------------------------------------------------
const ENDPOINTS = {
  sandbox: "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  daily: "https://daily-cloudcode-pa.googleapis.com",
  production: "https://cloudcode-pa.googleapis.com",
}

// ---------------------------------------------------------------------------
// Serialization helpers — replicates Tk() from main.js
// Cloud Code API uses camelCase on the wire for both request and response.
// snakeToCamel is retained as a safety net for older API versions.
// Note: BGe() (camelToSnake) exists in main.js source but traffic capture
// confirms the official IDE sends camelCase on the wire.
// ---------------------------------------------------------------------------
function camelToSnake(obj) {
  if (obj == null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(camelToSnake)
  const result = {}
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const snakeKey = key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)
      result[snakeKey] = camelToSnake(obj[key])
    }
  }
  return result
}

function snakeToCamel(obj) {
  if (obj == null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(snakeToCamel)
  const result = {}
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const camelKey = key.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase())
      result[camelKey] = snakeToCamel(obj[key])
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Worker State
// ---------------------------------------------------------------------------
let oauthClient = null
let config = null
let endpoint = null
let cloudaicompanionProject = null
let oauthTokensListener = null
const LOAD_CODE_ASSIST_CACHE_TTL_MS = 10_000
const loadCodeAssistCache = new Map()
const loadCodeAssistInflight = new Map()

function extractCloudCodeProjectId(result) {
  if (!result || typeof result !== "object") return null
  if (
    typeof result.cloudaicompanionProject === "string" &&
    result.cloudaicompanionProject.trim() !== ""
  ) {
    return result.cloudaicompanionProject.trim()
  }
  return null
}

function readResponseHeader(response, name) {
  const headers = response?.headers
  if (!headers) return null
  if (typeof headers.get === "function") {
    const value = headers.get(name)
    return typeof value === "string" && value.trim() ? value.trim() : null
  }
  const rawValue =
    headers[name] ??
    headers[name.toLowerCase()] ??
    headers[name.toUpperCase()] ??
    null
  if (Array.isArray(rawValue)) {
    const [first] = rawValue
    return typeof first === "string" && first.trim() ? first.trim() : null
  }
  return typeof rawValue === "string" && rawValue.trim()
    ? rawValue.trim()
    : null
}

function extractCloudCodeResponseMeta(response) {
  const traceId = readResponseHeader(response, "x-cloudaicompanion-trace-id")
  const retryAfter = readResponseHeader(response, "retry-after")
  const meta = {}
  if (traceId) meta.traceId = traceId
  if (retryAfter) meta.retryAfter = retryAfter
  return meta
}

function attachCloudCodeMeta(result, response) {
  const meta = extractCloudCodeResponseMeta(response)
  if (Object.keys(meta).length === 0 || !result || typeof result !== "object") {
    return result
  }
  return {
    ...result,
    __cloudCodeMeta: meta,
  }
}

function buildCloudCodeError(apiMethod, response, errorText, kind = "failed") {
  const meta = extractCloudCodeResponseMeta(response)
  const annotations = []
  if (meta.retryAfter) annotations.push(`retry-after=${meta.retryAfter}`)
  if (meta.traceId) annotations.push(`trace-id=${meta.traceId}`)
  const suffix = annotations.length > 0 ? ` [${annotations.join(" ")}]` : ""
  return new Error(
    `Cloud Code ${apiMethod} ${kind}: ${response.status}${suffix} ${errorText.slice(0, 500)}`
  )
}

function parseDurationMs(value) {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) return null

  let totalMs = 0
  let matched = false
  const re = /([\d.]+)\s*(ms|s|m|h)/gi
  let match
  while ((match = re.exec(text)) !== null) {
    matched = true
    const amount = Number.parseFloat(match[1] || "0")
    if (!Number.isFinite(amount)) continue
    const unit = String(match[2] || "").toLowerCase()
    if (unit === "ms") totalMs += amount
    else if (unit === "s") totalMs += amount * 1000
    else if (unit === "m") totalMs += amount * 60 * 1000
    else if (unit === "h") totalMs += amount * 60 * 60 * 1000
  }

  return matched ? Math.max(0, Math.round(totalMs)) : null
}

function parseRetryAfterMs(value) {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) return null

  const seconds = Number.parseFloat(text)
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000))
  }

  const retryAt = Date.parse(text)
  if (Number.isNaN(retryAt)) return null
  return Math.max(0, retryAt - Date.now())
}

function extractQuotaResetDelayMs(errorText) {
  const text =
    typeof errorText === "string" ? errorText : String(errorText || "")
  const patterns = [
    /quota will reset after ([^.,;\]\n]+)/i,
    /retry after ([^.,;\]\n]+)/i,
    /quotaResetDelay["'=:\s]+([^\s,"}\]]+)/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    const delayMs = parseDurationMs(match?.[1] || "")
    if (delayMs !== null) return delayMs
  }

  return null
}

function getCloudCodeRetryDelayMs(response, errorText) {
  const retryAfterMs = parseRetryAfterMs(
    readResponseHeader(response, "retry-after")
  )
  if (retryAfterMs !== null) return retryAfterMs
  return extractQuotaResetDelayMs(errorText)
}

function shouldGraceRetryQuotaExhausted(response, errorText) {
  if (!isQuotaExhausted(errorText)) return false
  const retryDelayMs = getCloudCodeRetryDelayMs(response, errorText)
  return retryDelayMs !== null && retryDelayMs <= QUOTA_RESET_GRACE_WINDOW_MS
}

function clearLoadCodeAssistCache() {
  loadCodeAssistCache.clear()
  loadCodeAssistInflight.clear()
}

function setLoadCodeAssistCacheValue(cacheKey, result) {
  loadCodeAssistCache.set(cacheKey, {
    expiresAt: Date.now() + LOAD_CODE_ASSIST_CACHE_TTL_MS,
    result,
  })
}

function getLoadCodeAssistCacheValue(cacheKey) {
  const cached = loadCodeAssistCache.get(cacheKey)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    loadCodeAssistCache.delete(cacheKey)
    return null
  }
  return cached.result
}

function buildLoadCodeAssistPayload(params = {}) {
  const metadata =
    params.metadata && typeof params.metadata === "object"
      ? { ...params.metadata }
      : {
          ideType: config?.isGcpTos ? "JETSKI" : "ANTIGRAVITY",
        }
  return { metadata }
}

function getLoadCodeAssistCacheKey(payload) {
  return JSON.stringify({
    metadata: payload?.metadata || {},
  })
}

async function requestLoadCodeAssist(params = {}, options = {}) {
  const payload = buildLoadCodeAssistPayload(params)
  const useCache = options.useCache !== false
  const cacheKey = getLoadCodeAssistCacheKey(payload)

  if (useCache) {
    const cached = getLoadCodeAssistCacheValue(cacheKey)
    if (cached) return cached
    const inFlight = loadCodeAssistInflight.get(cacheKey)
    if (inFlight) return inFlight
  }

  const promise = (async () => {
    const result = await cloudCodeRequest("loadCodeAssist", payload)
    const resolvedProjectId = extractCloudCodeProjectId(result)
    if (resolvedProjectId) {
      cloudaicompanionProject = resolvedProjectId
      if (config) {
        config.projectId = resolvedProjectId
      }
    }
    if (useCache) {
      setLoadCodeAssistCacheValue(cacheKey, result)
      if (resolvedProjectId) {
        const resolvedKey = getLoadCodeAssistCacheKey({
          ...payload,
          cloudaicompanionProject: resolvedProjectId,
        })
        setLoadCodeAssistCacheValue(resolvedKey, result)
      }
    }
    return result
  })()

  if (!useCache) {
    return promise
  }

  loadCodeAssistInflight.set(cacheKey, promise)
  try {
    return await promise
  } finally {
    loadCodeAssistInflight.delete(cacheKey)
  }
}

/**
 * User-Agent string matching Antigravity IDE format.
 */
function getUserAgent() {
  const version = config?.ideVersion || ANTIGRAVITY_IDE_VERSION
  const ideName = config?.isGcpTos ? "jetski" : "antigravity"
  return `${ideName}/${version} ${os.platform()}/${os.arch()}`
}

/**
 * Build IDE metadata for Cloud Code requests.
 */
function buildIdeMetadata() {
  return {
    ideName: config?.isGcpTos ? "jetski" : "antigravity",
    ideVersion: config?.ideVersion || ANTIGRAVITY_IDE_VERSION,
  }
}

/**
 * Convert a Gemini generateContent payload to TabChat format.
 * TabChat is the only AI generation endpoint in the new Cloud Code API.
 */
function convertToTabChatPayload(payload) {
  const request = payload.request || {}
  const contents = request.contents || []
  const genConfig = request.generationConfig || {}

  // Convert contents to chatMessagePrompts
  const chatMessagePrompts = []
  let systemPrompt = ""

  // Extract system instruction
  if (request.systemInstruction) {
    const siParts = request.systemInstruction.parts || []
    systemPrompt = siParts.map((p) => p.text || "").join("\n")
  }

  for (const msg of contents) {
    if (!msg) continue
    if (msg.role === "system") {
      systemPrompt = (msg.parts || []).map((p) => p.text || "").join("\n")
      continue
    }
    const source =
      msg.role === "model"
        ? "CHAT_MESSAGE_SOURCE_ASSISTANT"
        : "CHAT_MESSAGE_SOURCE_USER"
    for (const part of msg.parts || []) {
      if (part.text !== undefined) {
        const prompt = { source, prompt: part.text }
        if (part.thought) {
          prompt.thinking = part.text
          prompt.prompt = ""
        }
        if (part.thoughtSignature) {
          prompt.signature = part.thoughtSignature
        }
        chatMessagePrompts.push(prompt)
      } else if (part.functionCall) {
        chatMessagePrompts.push({
          source: "CHAT_MESSAGE_SOURCE_ASSISTANT",
          prompt: "",
          toolCalls: [
            {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args || {}),
              id: part.functionCall.id || "",
            },
          ],
        })
      } else if (part.functionResponse) {
        chatMessagePrompts.push({
          source: "CHAT_MESSAGE_SOURCE_USER",
          prompt:
            typeof part.functionResponse.response === "string"
              ? part.functionResponse.response
              : JSON.stringify(part.functionResponse.response || {}),
          toolCallId:
            part.functionResponse.id || part.functionResponse.name || "",
        })
      }
    }
  }

  // Convert tools
  const chatTools = []
  if (request.tools) {
    for (const toolGroup of request.tools) {
      for (const decl of toolGroup.functionDeclarations || []) {
        chatTools.push({
          name: decl.name,
          description: decl.description || "",
          jsonSchemaString: JSON.stringify(decl.parameters || {}),
        })
      }
    }
  }

  // Build configuration
  const configuration = {}
  if (genConfig.temperature !== undefined)
    configuration.temperature = genConfig.temperature
  if (genConfig.maxOutputTokens !== undefined)
    configuration.maxTokens = genConfig.maxOutputTokens

  const getChatMessageRequest = {
    metadata: buildIdeMetadata(),
    prompt: systemPrompt,
    chatMessagePrompts,
    requestType: "CHAT_MESSAGE_REQUEST_TYPE_CASCADE",
    chatModelName: payload.model || "",
  }
  if (chatTools.length > 0) getChatMessageRequest.tools = chatTools
  if (Object.keys(configuration).length > 0)
    getChatMessageRequest.configuration = configuration

  return {
    project:
      cloudaicompanionProject || payload.project || config.projectId || "",
    request: getChatMessageRequest,
  }
}

/**
 * Convert a TabChat SSE response chunk to Gemini format.
 */
function convertTabChatResponseToGemini(chunk) {
  const resp = chunk.response || chunk
  const parts = []
  if (resp.deltaThinking)
    parts.push({ text: resp.deltaThinking, thought: true })
  if (resp.deltaText) parts.push({ text: resp.deltaText })
  const toolCalls = resp.deltaToolCalls || []
  for (const tc of toolCalls) {
    parts.push({
      functionCall: {
        name: tc.name || "",
        args: tc.arguments ? JSON.parse(tc.arguments) : {},
        id: tc.id || "",
      },
    })
  }
  if (parts.length === 0) parts.push({ text: "" })
  let finishReason = undefined
  if (
    resp.stopReason &&
    resp.stopReason !== "STOP_REASON_UNSPECIFIED" &&
    resp.stopReason !== 0
  )
    finishReason = "STOP"
  return { candidates: [{ content: { role: "model", parts }, finishReason }] }
}

/**
 * Select Cloud Code endpoint based on account type
 * Replicates yqn() from main.js
 */
function selectEndpoint(account) {
  if (account.cloudCodeUrlOverride) return account.cloudCodeUrlOverride
  if (account.isGcpTos) return ENDPOINTS.production
  return ENDPOINTS.daily
}

function normalizeProxyUrl(value) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function sanitizeProxyUrlForLog(proxyUrl) {
  try {
    const parsed = new URL(proxyUrl)
    if (parsed.password) {
      parsed.password = "***"
    }
    return parsed.toString()
  } catch {
    return proxyUrl
  }
}

function buildProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined

  let parsed
  try {
    parsed = new URL(proxyUrl)
  } catch (error) {
    throw new Error(
      `Invalid proxy URL ${proxyUrl}: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  switch (parsed.protocol) {
    case "http:":
      return new HttpProxyAgent(proxyUrl)
    case "https:":
      return new HttpsProxyAgent(proxyUrl)
    case "socks4:":
    case "socks5:":
    case "socks5h:":
      return new SocksProxyAgent(proxyUrl)
    default:
      throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`)
  }
}

/**
 * Initialize OAuth2Client for the given account
 */
function initializeClient(account) {
  const creds = account.isGcpTos ? OAUTH_GCP_TOS : OAUTH_NON_GCP
  const proxyUrl = normalizeProxyUrl(account.proxyUrl)
  const proxyAgent = buildProxyAgent(proxyUrl)

  if (oauthClient && oauthTokensListener) {
    oauthClient.removeListener("tokens", oauthTokensListener)
    oauthTokensListener = null
  }

  oauthClient = new OAuth2Client({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    ...(proxyAgent ? { transporterOptions: { agent: proxyAgent } } : {}),
  })
  clearLoadCodeAssistCache()
  cloudaicompanionProject = null
  oauthClient.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expiry_date: account.expiresAt
      ? new Date(account.expiresAt).getTime()
      : Date.now() - 1000,
    token_type: "Bearer",
  })

  // Listen for token refresh events to report back
  oauthTokensListener = (tokens) => {
    sendMessage({
      type: "token_refresh",
      tokens: {
        accessToken: tokens.access_token,
        refreshToken:
          tokens.refresh_token || config?.refreshToken || account.refreshToken,
        expiresAt: tokens.expiry_date
          ? new Date(tokens.expiry_date).toISOString()
          : undefined,
      },
    })
  }
  oauthClient.on("tokens", oauthTokensListener)
  if (proxyUrl) {
    process.stderr.write(
      `[proxy] Using Google native proxy ${sanitizeProxyUrlForLog(proxyUrl)}\n`
    )
  }

  const quotaProjectId =
    typeof account.quotaProjectId === "string" &&
    account.quotaProjectId.trim().length > 0
      ? account.quotaProjectId.trim()
      : typeof account.projectId === "string" &&
          account.projectId.trim().length > 0
        ? account.projectId.trim()
        : undefined
  const cloudCodeProjectId =
    typeof account.quotaProjectId === "string" &&
    account.quotaProjectId.trim().length > 0 &&
    typeof account.projectId === "string" &&
    account.projectId.trim().length > 0
      ? account.projectId.trim()
      : undefined

  config = {
    ...account,
    ...(proxyUrl ? { proxyUrl } : {}),
    projectId: cloudCodeProjectId,
    quotaProjectId,
  }
  endpoint = selectEndpoint(account)
}

// ---------------------------------------------------------------------------
// Retry config for 503 MODEL_CAPACITY_EXHAUSTED / 429 rate limit
// ---------------------------------------------------------------------------
const RETRY_STATUS_CODES = [503, 429]
const MAX_RETRIES = 3
const BASE_DELAY_MS = 2000 // 2s, 4s, 8s exponential backoff
const STREAM_FIRST_CHUNK_TIMEOUT_MS = 20000
const STREAM_IDLE_TIMEOUT_MS = 45000
const QUOTA_RESET_GRACE_WINDOW_MS = 1500
const QUOTA_RESET_RETRY_DELAY_MS = 5000

// Many quota 429s are deterministic, but official Antigravity still gives
// "reset after 0s/1s" responses one short grace retry before surfacing them.
function isQuotaExhausted(responseText) {
  return (
    responseText.includes("QUOTA_EXHAUSTED") ||
    responseText.includes("exhausted your capacity")
  )
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeAbortReason(apiMethod, signal, fallbackLabel) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  if (typeof reason === "string" && reason.trim()) {
    return new Error(reason)
  }
  return new Error(`Cloud Code ${apiMethod} ${fallbackLabel}`)
}

function buildCloudCodeHeaders() {
  return new Headers({
    "Content-Type": "application/json",
    "User-Agent": getUserAgent(),
    "Accept-Encoding": "gzip",
  })
}

function buildCloudCodeRequestOptions(
  url,
  body,
  responseType,
  signal = undefined
) {
  return {
    url,
    method: "POST",
    headers: buildCloudCodeHeaders(),
    data: body,
    responseType,
    retry: 0,
    validateStatus: () => true,
    signal,
  }
}

function isAbortLikeError(error) {
  return (
    error?.name === "AbortError" ||
    error?.code === "ABORT_ERR" ||
    String(error?.message || "").includes("aborted")
  )
}

function isSuccessfulResponse(response) {
  if (typeof response?.ok === "boolean") return response.ok
  const status = Number(response?.status)
  return Number.isFinite(status) && status >= 200 && status < 300
}

async function readResponseText(response) {
  if (!response) return ""

  if (typeof response.text === "function") {
    const text = await response.text()
    return typeof text === "string" ? text : String(text ?? "")
  }

  const data = response.data
  if (typeof data === "string") return data
  if (Buffer.isBuffer(data)) return data.toString("utf8")
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8")

  if (typeof data?.[Symbol.asyncIterator] === "function") {
    const decoder = new TextDecoder()
    let text = ""
    for await (const chunk of data) {
      text += decoder.decode(chunk, { stream: true })
    }
    text += decoder.decode()
    return text
  }

  return data == null ? "" : String(data)
}

async function* iterateResponseStream(stream) {
  if (!stream) {
    throw new Error("Cloud Code stream returned no body")
  }

  if (typeof stream[Symbol.asyncIterator] === "function") {
    for await (const chunk of stream) {
      yield chunk
    }
    return
  }

  if (typeof stream.getReader === "function") {
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        yield value
      }
    } finally {
      reader.releaseLock?.()
    }
    return
  }

  throw new Error("Cloud Code stream returned an unsupported body type")
}

/**
 * Make authenticated request to Cloud Code API (with retry)
 * Replicates the w() method from Antigravity IDE
 */
async function cloudCodeRequest(apiMethod, payload) {
  let lastError = null
  let retryDelayMs = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = retryDelayMs ?? BASE_DELAY_MS * Math.pow(2, attempt - 1)
      retryDelayMs = null
      process.stderr.write(
        `[retry] ${apiMethod} attempt ${attempt + 1}/${MAX_RETRIES + 1} after ${delay}ms\n`
      )
      await sleep(delay)
    }

    const url = `${endpoint}/v1internal:${apiMethod}`
    const body = JSON.stringify(payload)
    let response
    try {
      response = await oauthClient.request(
        buildCloudCodeRequestOptions(url, body, "text")
      )
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt === MAX_RETRIES) {
        break
      }
      continue
    }

    if (isSuccessfulResponse(response)) {
      const rawData =
        typeof response.data === "string"
          ? response.data
          : await readResponseText(response)
      const data = JSON.parse(rawData)
      return attachCloudCodeMeta(snakeToCamel(data), response)
    }

    const errorText = await readResponseText(response)
    lastError = buildCloudCodeError(apiMethod, response, errorText)

    if (response.status === 429 && isQuotaExhausted(errorText)) {
      if (
        attempt < MAX_RETRIES &&
        shouldGraceRetryQuotaExhausted(response, errorText)
      ) {
        retryDelayMs = QUOTA_RESET_RETRY_DELAY_MS
        process.stderr.write(
          `[retry] ${apiMethod} quota reset is imminent; retrying in ${retryDelayMs}ms\n`
        )
        continue
      }
      throw lastError
    }

    if (!RETRY_STATUS_CODES.includes(response.status)) {
      throw lastError // Non-retryable error
    }
  }

  throw lastError // All retries exhausted
}

/**
 * Make streaming request to Cloud Code API (SSE) with retry
 * Replicates streaming generateContent from Antigravity IDE
 */
async function* cloudCodeStreamRequest(apiMethod, payload) {
  let lastError = null
  let retryDelayMs = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = retryDelayMs ?? BASE_DELAY_MS * Math.pow(2, attempt - 1)
      retryDelayMs = null
      process.stderr.write(
        `[retry] ${apiMethod} stream attempt ${attempt + 1}/${MAX_RETRIES + 1} after ${delay}ms\n`
      )
      await sleep(delay)
    }

    const url = `${endpoint}/v1internal:${apiMethod}?alt=sse`
    const body = JSON.stringify(payload)

    // Debug: dump full payload for comparison with IDE traffic
    process.stderr.write(
      `[DEBUG] ${apiMethod} payload (${body.length} bytes): ${body.slice(0, 2000)}\n`
    )

    const controller = new AbortController()
    let timeout = null
    const clearStreamTimeout = () => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
    }
    const armStreamTimeout = (ms, label) => {
      clearStreamTimeout()
      timeout = setTimeout(() => {
        controller.abort(
          new Error(`Cloud Code ${apiMethod} ${label} timeout after ${ms}ms`)
        )
      }, ms)
    }

    let response
    try {
      armStreamTimeout(STREAM_FIRST_CHUNK_TIMEOUT_MS, "first chunk")
      response = await oauthClient.request(
        buildCloudCodeRequestOptions(url, body, "stream", controller.signal)
      )

      if (isSuccessfulResponse(response)) {
        const traceId = response.headers.get("x-cloudaicompanion-trace-id")
        if (traceId) {
          yield {
            __cloudCodeMeta: {
              traceId,
            },
          }
        }

        const decoder = new TextDecoder()
        let buffer = ""

        for await (const value of iterateResponseStream(response.data)) {
          armStreamTimeout(STREAM_IDLE_TIMEOUT_MS, "idle")
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() || ""

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith(":")) continue
            if (trimmed.startsWith("data: ")) {
              const jsonStr = trimmed.slice(6)
              if (jsonStr === "[DONE]") {
                clearStreamTimeout()
                return
              }
              try {
                yield snakeToCamel(JSON.parse(jsonStr))
              } catch {
                // Skip malformed JSON
              }
            }
          }
        }

        clearStreamTimeout()

        // Process remaining buffer
        if (buffer.trim()) {
          const trimmed = buffer.trim()
          if (trimmed.startsWith("data: ") && trimmed.slice(6) !== "[DONE]") {
            try {
              yield snakeToCamel(JSON.parse(trimmed.slice(6)))
            } catch {
              // Skip
            }
          }
        }
        return // Stream completed successfully
      }
    } catch (error) {
      clearStreamTimeout()
      lastError =
        controller.signal.aborted || isAbortLikeError(error)
          ? normalizeAbortReason(apiMethod, controller.signal, "stream aborted")
          : error instanceof Error
            ? error
            : new Error(String(error))

      if (attempt === MAX_RETRIES) {
        break
      }
      continue
    }

    clearStreamTimeout()
    const errorText = await readResponseText(response)
    lastError = buildCloudCodeError(
      apiMethod,
      response,
      errorText,
      "stream failed"
    )

    if (response.status === 429 && isQuotaExhausted(errorText)) {
      if (
        attempt < MAX_RETRIES &&
        shouldGraceRetryQuotaExhausted(response, errorText)
      ) {
        retryDelayMs = QUOTA_RESET_RETRY_DELAY_MS
        process.stderr.write(
          `[retry] ${apiMethod} stream quota reset is imminent; retrying in ${retryDelayMs}ms\n`
        )
        continue
      }
      throw lastError
    }

    if (!RETRY_STATUS_CODES.includes(response.status)) {
      throw lastError // Non-retryable error
    }
  }

  throw lastError // All retries exhausted
}

// ---------------------------------------------------------------------------
// Request Handlers
// ---------------------------------------------------------------------------
async function handleInit(params) {
  initializeClient(params.account)
  return { status: "ok", endpoint }
}

async function handleCheckAvailability() {
  if (!oauthClient) throw new Error("Worker not initialized")
  const result = await requestLoadCodeAssist(undefined, { useCache: true })
  process.stderr.write(
    `[DEBUG] loadCodeAssist currentTier: ${JSON.stringify(result?.currentTier)}, paidTier: ${JSON.stringify(result?.paidTier)}, allowedTiers: ${JSON.stringify(result?.allowedTiers)}, ineligibleTiers: ${JSON.stringify(result?.ineligibleTiers)}, project: ${result?.cloudaicompanionProject}\n`
  )
  // Cache cloudaicompanionProject for tabChat calls
  if (result && result.cloudaicompanionProject) {
    cloudaicompanionProject = result.cloudaicompanionProject
  }
  return { available: true }
}

async function handleGenerate(id, params) {
  if (!oauthClient) throw new Error("Worker not initialized")
  // Use streamGenerateContent (confirmed by traffic capture) and collect all chunks
  const payload = buildStreamPayload(params.payload)
  process.stderr.write(
    `[DEBUG] streamGenerateContent request: project=${payload.project}, model=${payload.model}\n`
  )
  const allParts = []
  let lastFinishReason = undefined
  let usageMetadata = undefined
  for await (const chunk of cloudCodeStreamRequest(
    "streamGenerateContent",
    payload
  )) {
    // SSE chunks have outer wrapper: { response: { candidates: [...] }, traceId, metadata }
    const inner = chunk.response || chunk
    if (inner.candidates?.[0]?.content?.parts) {
      for (const p of inner.candidates[0].content.parts) {
        allParts.push(p)
      }
    }
    if (inner.candidates?.[0]?.finishReason)
      lastFinishReason = inner.candidates[0].finishReason
    if (inner.usageMetadata) usageMetadata = inner.usageMetadata
  }
  const result = {
    candidates: [
      {
        content: {
          role: "model",
          parts: allParts.length > 0 ? allParts : [{ text: "" }],
        },
        finishReason: lastFinishReason || "STOP",
      },
    ],
  }
  if (usageMetadata) result.usageMetadata = usageMetadata
  return result
}

async function handleGenerateStream(id, params) {
  if (!oauthClient) throw new Error("Worker not initialized")
  // Use streamGenerateContent (confirmed by traffic capture) — forward SSE chunks directly
  const payload = buildStreamPayload(params.payload)
  process.stderr.write(
    `[DEBUG] streamGenerateContent stream: project=${payload.project}, model=${payload.model}\n`
  )
  for await (const chunk of cloudCodeStreamRequest(
    "streamGenerateContent",
    payload
  )) {
    // Unwrap outer response wrapper before forwarding
    const inner = chunk.response || chunk
    sendMessage({ id, stream: inner })
  }
  sendMessage({ id, stream: null }) // signal stream end
}

/**
 * Build streamGenerateContent payload matching IDE's actual format.
 * GoogleService already builds the full Cloud Code payload:
 *   { project, model, request: {...}, requestType, userAgent, requestId }
 * We only need to ensure requestId and project are set, then pass through.
 */
function buildStreamPayload(incomingPayload) {
  // If incoming payload already has a 'request' object with 'contents',
  // it's a fully-formed Cloud Code payload from GoogleService — pass through
  if (
    incomingPayload.request &&
    (incomingPayload.request.contents ||
      incomingPayload.request.systemInstruction)
  ) {
    const payload = { ...incomingPayload }
    // Ensure project is set (prefer cloudaicompanionProject from loadCodeAssist)
    if (cloudaicompanionProject) payload.project = cloudaicompanionProject
    // Ensure requestId is set
    if (!payload.requestId) {
      payload.requestId = `agent/${Date.now()}/${crypto.randomUUID()}`
    }
    return payload
  }

  // Otherwise, build from raw Gemini payload (legacy path)
  const payload = {
    project:
      cloudaicompanionProject ||
      incomingPayload.project ||
      config.projectId ||
      "",
    requestId: `agent/${Date.now()}/${crypto.randomUUID()}`,
    request: {},
  }
  if (incomingPayload.model) payload.model = incomingPayload.model

  const inner = {}
  if (incomingPayload.contents) inner.contents = incomingPayload.contents
  if (incomingPayload.systemInstruction)
    inner.systemInstruction = incomingPayload.systemInstruction
  if (incomingPayload.tools) inner.tools = incomingPayload.tools
  if (incomingPayload.generationConfig)
    inner.generationConfig = incomingPayload.generationConfig
  if (incomingPayload.toolConfig) inner.toolConfig = incomingPayload.toolConfig

  payload.request = inner
  return payload
}

async function handleLoadCodeAssist(params) {
  if (!oauthClient) throw new Error("Worker not initialized")
  return requestLoadCodeAssist(params, {
    useCache: params?.forceRefresh !== true,
  })
}

async function handleWebSearch(params) {
  if (!oauthClient) throw new Error("Worker not initialized")
  const payload = {
    project: config.projectId || "",
    model: "gemini-2.5-flash",
    requestType: "web_search",
    request: {
      contents: [{ role: "user", parts: [{ text: params.query }] }],
      systemInstruction: {
        role: "user",
        parts: [
          {
            text: "You are a search engine bot. You will be given a query from a user. Your task is to search the web for relevant information that will help the user. You MUST perform a web search. Do not respond or interact with the user, please respond as if they typed the query into a search bar.",
          },
        ],
      },
      tools: [
        {
          googleSearch: {
            enhancedContent: {
              imageSearch: {
                maxResultCount: 5,
              },
            },
          },
        },
      ],
      generationConfig: {
        candidateCount: 1,
      },
    },
  }
  return await cloudCodeRequest("generateContent", payload)
}

async function handleFetchAvailableModels() {
  if (!oauthClient) throw new Error("Worker not initialized")
  const payload = {
    project: config.projectId || "",
  }
  return await cloudCodeRequest("fetchAvailableModels", payload)
}

async function handleFetchUserInfo(params) {
  if (!oauthClient) throw new Error("Worker not initialized")
  const requestedProjectId =
    params && typeof params.projectId === "string"
      ? params.projectId.trim()
      : ""
  const currentProjectId =
    config && typeof config.projectId === "string"
      ? config.projectId.trim()
      : ""
  const projectId = requestedProjectId || currentProjectId
  const payload = {}
  if (projectId) {
    payload.project = projectId
  }
  return await cloudCodeRequest("fetchUserInfo", payload)
}

async function handleRecordCodeAssistMetrics(params) {
  if (!oauthClient) throw new Error("Worker not initialized")
  if (!params || typeof params.payload !== "object" || !params.payload) {
    throw new Error("recordCodeAssistMetrics requires payload")
  }
  return await cloudCodeRequest("recordCodeAssistMetrics", params.payload)
}

async function handleRecordTrajectoryAnalytics(params) {
  if (!oauthClient) throw new Error("Worker not initialized")
  if (!params || typeof params.payload !== "object" || !params.payload) {
    throw new Error("recordTrajectoryAnalytics requires payload")
  }
  return await cloudCodeRequest("recordTrajectoryAnalytics", params.payload)
}

// ---------------------------------------------------------------------------
// IPC (JSON Lines over stdin/stdout)
// ---------------------------------------------------------------------------
function sendMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

async function handleRequest(request) {
  const { id, method, params } = request
  try {
    let result
    switch (method) {
      case "init":
        result = await handleInit(params)
        break
      case "checkAvailability":
        result = await handleCheckAvailability()
        break
      case "generate":
        result = await handleGenerate(id, params)
        break
      case "generateStream":
        await handleGenerateStream(id, params)
        return // streaming responses sent inline
      case "loadCodeAssist":
        result = await handleLoadCodeAssist(params)
        break
      case "fetchAvailableModels":
        result = await handleFetchAvailableModels()
        break
      case "fetchUserInfo":
        result = await handleFetchUserInfo(params)
        break
      case "recordCodeAssistMetrics":
        result = await handleRecordCodeAssistMetrics(params)
        break
      case "recordTrajectoryAnalytics":
        result = await handleRecordTrajectoryAnalytics(params)
        break
      case "webSearch":
        result = await handleWebSearch(params)
        break
      default:
        throw new Error(`Unknown method: ${method}`)
    }
    sendMessage({ id, result })
  } catch (error) {
    sendMessage({
      id,
      error: { message: error.message, stack: error.stack },
    })
  }
}

// ---------------------------------------------------------------------------
// Main: read JSON Lines from stdin
// ---------------------------------------------------------------------------
const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
})

rl.on("line", (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  try {
    const request = JSON.parse(trimmed)
    handleRequest(request).catch((err) => {
      sendMessage({
        id: request.id,
        error: { message: err.message, stack: err.stack },
      })
    })
  } catch (err) {
    sendMessage({
      error: { message: `Invalid JSON: ${err.message}` },
    })
  }
})

rl.on("close", () => {
  process.exit(0)
})

// Signal ready
sendMessage({ type: "ready", pid: process.pid, userAgent: getUserAgent() })
