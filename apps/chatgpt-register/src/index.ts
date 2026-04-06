import * as crypto from "crypto"
import { ProxyAgent } from "undici"

export interface ChatGptRegisterInput {
  apiUrl: string
  adminToken: string
  customAuth?: string
  domain?: string
  domains?: string[]
  enabledDomains?: string[]
  subdomain?: string
  randomSubdomain?: boolean
  fingerprint?: string
  proxyUrl?: string
  password?: string
}

export interface ChatGptRegisterResult {
  account: Record<string, string>
  metadata?: Record<string, unknown>
  logs: string[]
}

interface MailboxAccount {
  email: string
  accountId: string
  extra?: Record<string, unknown>
}

interface OAuthStart {
  authUrl: string
  state: string
  codeVerifier: string
  redirectUri: string
}

interface FlowState {
  pageType: string
  continueUrl: string
  method: string
  currentUrl: string
  source: string
  payload: Record<string, unknown>
  raw: Record<string, unknown>
}

interface RegistrationResult {
  success: boolean
  email: string
  password: string
  accountId: string
  workspaceId: string
  accessToken: string
  refreshToken: string
  idToken: string
  sessionToken: string
  errorMessage: string
  logs: string[]
  metadata?: Record<string, unknown>
  source: "register" | "login"
}

interface SignupFormResult {
  success: boolean
  pageType: string
  isExistingAccount: boolean
  responseData?: Record<string, unknown>
  errorMessage: string
}

interface CookieRecord {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  hostOnly: boolean
  expiresAt?: number
}

const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const OAUTH_AUTH_URL = "https://auth.openai.com/oauth/authorize"
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
const OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback"
const OAUTH_SCOPE = "openid email profile offline_access"

const OPENAI_API_ENDPOINTS = {
  sentinel: "https://sentinel.openai.com/backend-api/sentinel/req",
  signup: "https://auth.openai.com/api/accounts/authorize/continue",
  register: "https://auth.openai.com/api/accounts/user/register",
  passwordVerify: "https://auth.openai.com/api/accounts/password/verify",
  sendOtp: "https://auth.openai.com/api/accounts/email-otp/send",
  validateOtp: "https://auth.openai.com/api/accounts/email-otp/validate",
  createAccount: "https://auth.openai.com/api/accounts/create_account",
  selectWorkspace: "https://auth.openai.com/api/accounts/workspace/select",
} as const

const OPENAI_PAGE_TYPES = {
  emailOtpVerification: "email_otp_verification",
  passwordRegistration: "create_account_password",
  loginPassword: "login_password",
} as const

const OTP_CODE_PATTERN = /(?<!\d)(\d{6})(?!\d)/
const DEFAULT_PASSWORD_LENGTH = 12
const MIN_REGISTRATION_AGE = 20
const MAX_REGISTRATION_AGE = 45

const FIRST_NAMES = [
  "James",
  "John",
  "Robert",
  "Michael",
  "William",
  "David",
  "Richard",
  "Joseph",
  "Thomas",
  "Charles",
  "Emma",
  "Olivia",
  "Ava",
  "Isabella",
  "Sophia",
  "Mia",
  "Charlotte",
  "Amelia",
  "Harper",
  "Evelyn",
  "Alex",
  "Jordan",
  "Taylor",
  "Morgan",
  "Casey",
  "Riley",
  "Jamie",
  "Avery",
  "Quinn",
  "Skyler",
  "Liam",
  "Noah",
  "Ethan",
  "Lucas",
  "Mason",
  "Oliver",
  "Elijah",
  "Aiden",
  "Henry",
  "Sebastian",
  "Grace",
  "Lily",
  "Chloe",
  "Zoey",
  "Nora",
  "Aria",
  "Hazel",
  "Aurora",
  "Stella",
  "Ivy",
]

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"

const SENTINEL_SEC_CH_UA =
  '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0)
  }

  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }

  return []
}

function normalizeDomain(value: unknown): string {
  let normalized = String(value ?? "")
    .trim()
    .toLowerCase()
  if (normalized.startsWith("@")) {
    normalized = normalized.slice(1)
  }
  return normalized
}

function normalizeSubdomain(value: unknown): string {
  let normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "")
  if (normalized.startsWith("@")) {
    normalized = normalized.slice(1)
  }
  return normalized
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(".")
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value
  }
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase()
  )
}

function createProxyDispatcher(proxyUrl?: string): ProxyAgent | undefined {
  const normalized = String(proxyUrl ?? "").trim()
  if (!normalized) {
    return undefined
  }

  const parsed = new URL(normalized)
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`)
  }

  return new ProxyAgent(normalized)
}

function b64UrlNoPad(raw: Buffer): string {
  return raw.toString("base64url")
}

function sha256Base64UrlNoPad(value: string): string {
  return b64UrlNoPad(crypto.createHash("sha256").update(value).digest())
}

function randomState(size = 16): string {
  return crypto.randomBytes(size).toString("base64url")
}

function randomVerifier(): string {
  return crypto.randomBytes(64).toString("base64url")
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  if (!token || token.split(".").length < 2) {
    return {}
  }

  try {
    const payload = token.split(".")[1] ?? ""
    return JSON.parse(
      Buffer.from(payload, "base64url").toString("utf-8")
    ) as Record<string, unknown>
  } catch {
    return {}
  }
}

function decodeJwtSegment(segment: string): Record<string, unknown> {
  if (!segment) {
    return {}
  }

  try {
    return JSON.parse(
      Buffer.from(segment, "base64url").toString("utf-8")
    ) as Record<string, unknown>
  } catch {
    return {}
  }
}

function parseJwtClaims(idToken: string): {
  email: string
  accountId: string
  planType: string
  expire: string
} {
  const claims = decodeJwtPayload(idToken)
  const authClaims = (claims["https://api.openai.com/auth"] ?? {}) as Record<
    string,
    unknown
  >
  const exp = Number(claims.exp ?? 0)

  return {
    email: String(claims.email ?? "").trim(),
    accountId: String(authClaims.chatgpt_account_id ?? "").trim(),
    planType: String(authClaims.chatgpt_plan_type ?? "").trim(),
    expire:
      exp > 0
        ? new Date(exp * 1000).toISOString()
        : new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }
}

function generateRandomPassword(length = DEFAULT_PASSWORD_LENGTH): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%"
  const required = [
    randomChar("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    randomChar("abcdefghijklmnopqrstuvwxyz"),
    randomChar("0123456789"),
    randomChar("!@#$%"),
  ]
  const chars = [...required]

  while (chars.length < length) {
    chars.push(randomChar(alphabet))
  }

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = chars[i]
    chars[i] = chars[j] ?? ""
    chars[j] = tmp ?? ""
  }

  return chars.join("")
}

function randomChar(value: string): string {
  const index = Math.floor(Math.random() * value.length)
  return value[index] ?? value[0] ?? ""
}

function generateRandomUserInfo(): { name: string; birthdate: string } {
  const currentYear = new Date().getUTCFullYear()
  const birthYear =
    currentYear -
    (MIN_REGISTRATION_AGE +
      Math.floor(
        Math.random() * (MAX_REGISTRATION_AGE - MIN_REGISTRATION_AGE + 1)
      ))
  const birthMonth = Math.floor(Math.random() * 12) + 1
  const birthDay = Math.floor(Math.random() * 28) + 1

  return {
    name: FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)] ?? "Alex",
    birthdate: `${birthYear}-${String(birthMonth).padStart(2, "0")}-${String(
      birthDay
    ).padStart(2, "0")}`,
  }
}

function normalizePageType(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-/\s]+/g, "_")
}

function normalizeFlowUrl(
  url: unknown,
  authBase = "https://auth.openai.com"
): string {
  const value = String(url ?? "").trim()
  if (!value) {
    return ""
  }
  if (value.startsWith("//")) {
    return `https:${value}`
  }
  if (value.startsWith("/")) {
    return `${authBase.replace(/\/$/, "")}${value}`
  }
  return value
}

function inferPageTypeFromUrl(url: string): string {
  if (!url) {
    return ""
  }

  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    const path = parsed.pathname.toLowerCase()

    if (parsed.searchParams.get("code")) {
      return "oauth_callback"
    }
    if (host.includes("chatgpt.com") && path.includes("/api/auth/callback/")) {
      return "callback"
    }
    if (path.includes("create-account/password")) {
      return "create_account_password"
    }
    if (path.includes("email-verification") || path.includes("email-otp")) {
      return "email_otp_verification"
    }
    if (path.includes("about-you")) {
      return "about_you"
    }
    if (path.includes("log-in/password")) {
      return "login_password"
    }
    if (path.includes("sign-in-with-chatgpt") && path.includes("consent")) {
      return "consent"
    }
    if (path.includes("workspace") && path.includes("select")) {
      return "workspace_selection"
    }
    if (path.includes("callback")) {
      return "callback"
    }
    return normalizePageType(path.replace(/^\/+|\/+$/g, ""))
  } catch {
    return ""
  }
}

function extractFlowState(
  data: unknown,
  currentUrl = "",
  authBase = "https://auth.openai.com",
  defaultMethod = "GET"
): FlowState {
  const raw =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const page =
    raw.page && typeof raw.page === "object"
      ? (raw.page as Record<string, unknown>)
      : {}
  const payload =
    page.payload && typeof page.payload === "object"
      ? (page.payload as Record<string, unknown>)
      : {}

  const continueUrl = normalizeFlowUrl(
    raw.continue_url ?? payload.url ?? "",
    authBase
  )
  const effectiveCurrentUrl = continueUrl || currentUrl
  const normalizedCurrent = normalizeFlowUrl(effectiveCurrentUrl, authBase)
  const pageType =
    normalizePageType(page.type) ||
    inferPageTypeFromUrl(continueUrl || normalizedCurrent)
  const method = String(raw.method ?? payload.method ?? defaultMethod)
    .trim()
    .toUpperCase()

  return {
    pageType,
    continueUrl,
    method: method || "GET",
    currentUrl: normalizedCurrent,
    source: Object.keys(raw).length > 0 ? "api" : "url",
    payload,
    raw,
  }
}

function describeFlowState(state: FlowState): string {
  const target = state.continueUrl || state.currentUrl || "-"
  return `page=${state.pageType || "-"} method=${state.method || "-"} next=${target.slice(0, 80)}...`
}

function seedOaiDeviceCookie(cookieJar: CookieJar, deviceId: string): void {
  for (const domain of [
    "chatgpt.com",
    ".chatgpt.com",
    "openai.com",
    ".openai.com",
    "auth.openai.com",
    ".auth.openai.com",
  ]) {
    cookieJar.setCookie({
      name: "oai-did",
      value: deviceId,
      domain,
      path: "/",
      secure:
        domain.includes("auth.openai.com") || domain.includes("chatgpt.com"),
    })
  }
}

class CookieJar {
  private readonly cookies = new Map<string, CookieRecord>()

  setCookie(input: {
    name: string
    value: string
    domain: string
    path?: string
    secure?: boolean
    expiresAt?: number
    hostOnly?: boolean
  }): void {
    const domain = normalizeDomain(input.domain.replace(/^\./, ""))
    if (!input.name || !domain) {
      return
    }

    const record: CookieRecord = {
      name: input.name,
      value: input.value,
      domain,
      path: input.path || "/",
      secure: Boolean(input.secure),
      expiresAt: input.expiresAt,
      hostOnly: Boolean(input.hostOnly),
    }

    this.cookies.set(this.buildKey(record), record)
  }

  setFromHeader(setCookie: string, requestUrl: string): void {
    const parts = setCookie.split(";").map((part) => part.trim())
    const first = parts.shift()
    if (!first) {
      return
    }

    const separator = first.indexOf("=")
    if (separator <= 0) {
      return
    }

    const url = new URL(requestUrl)
    const name = first.slice(0, separator).trim()
    const value = first.slice(separator + 1)

    let domain = url.hostname
    let hostOnly = true
    let path = defaultCookiePath(url.pathname)
    let secure = url.protocol === "https:"
    let expiresAt: number | undefined

    for (const part of parts) {
      const [rawKey, ...rest] = part.split("=")
      const key = rawKey?.trim().toLowerCase() ?? ""
      const attrValue = rest.join("=").trim()

      switch (key) {
        case "domain":
          if (attrValue) {
            domain = normalizeDomain(attrValue.replace(/^\./, ""))
            hostOnly = false
          }
          break
        case "path":
          if (attrValue) {
            path = attrValue
          }
          break
        case "secure":
          secure = true
          break
        case "max-age": {
          const seconds = Number.parseInt(attrValue, 10)
          if (Number.isFinite(seconds)) {
            expiresAt = Date.now() + seconds * 1000
          }
          break
        }
        case "expires": {
          const parsed = Date.parse(attrValue)
          if (Number.isFinite(parsed)) {
            expiresAt = parsed
          }
          break
        }
        default:
          break
      }
    }

    if (expiresAt && expiresAt <= Date.now()) {
      this.cookies.delete(this.buildKey({ name, domain, path } as CookieRecord))
      return
    }

    this.setCookie({
      name,
      value,
      domain,
      path,
      secure,
      expiresAt,
      hostOnly,
    })
  }

  getCookieHeader(requestUrl: string): string {
    const url = new URL(requestUrl)
    const now = Date.now()
    const result: CookieRecord[] = []

    for (const [key, cookie] of this.cookies.entries()) {
      if (cookie.expiresAt && cookie.expiresAt <= now) {
        this.cookies.delete(key)
        continue
      }

      if (cookie.secure && url.protocol !== "https:") {
        continue
      }

      if (!domainMatches(url.hostname, cookie.domain, cookie.hostOnly)) {
        continue
      }

      if (!pathMatches(url.pathname, cookie.path)) {
        continue
      }

      result.push(cookie)
    }

    result.sort((a, b) => b.path.length - a.path.length)
    return result.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
  }

  get(name: string, requestUrl?: string): string | undefined {
    const now = Date.now()
    const candidates = Array.from(this.cookies.values()).filter((cookie) => {
      if (cookie.name !== name) {
        return false
      }
      if (cookie.expiresAt && cookie.expiresAt <= now) {
        return false
      }
      if (!requestUrl) {
        return true
      }
      const url = new URL(requestUrl)
      return (
        (!cookie.secure || url.protocol === "https:") &&
        domainMatches(url.hostname, cookie.domain, cookie.hostOnly) &&
        pathMatches(url.pathname, cookie.path)
      )
    })

    candidates.sort((a, b) => b.path.length - a.path.length)
    return candidates[0]?.value
  }

  private buildKey(
    record: Pick<CookieRecord, "name" | "domain" | "path">
  ): string {
    return `${record.name};${record.domain};${record.path}`
  }
}

function defaultCookiePath(pathname: string): string {
  if (!pathname || !pathname.startsWith("/")) {
    return "/"
  }
  if (pathname === "/") {
    return "/"
  }
  const lastSlash = pathname.lastIndexOf("/")
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash)
}

function domainMatches(
  hostname: string,
  domain: string,
  hostOnly: boolean
): boolean {
  const normalizedHost = hostname.toLowerCase()
  const normalizedDomain = domain.toLowerCase()

  if (hostOnly) {
    return normalizedHost === normalizedDomain
  }

  return (
    normalizedHost === normalizedDomain ||
    normalizedHost.endsWith(`.${normalizedDomain}`)
  )
}

function pathMatches(pathname: string, cookiePath: string): boolean {
  return (
    pathname === cookiePath ||
    pathname.startsWith(
      cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`
    ) ||
    cookiePath === "/"
  )
}

class HttpClient {
  readonly cookieJar = new CookieJar()
  readonly defaultHeaders: Record<string, string>
  private readonly dispatcher?: ProxyAgent

  constructor(
    proxyUrl?: string,
    defaultHeaders: Record<string, string> = {
      "User-Agent": DEFAULT_USER_AGENT,
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
    }
  ) {
    this.dispatcher = createProxyDispatcher(proxyUrl)
    this.defaultHeaders = defaultHeaders
  }

  async request(
    method: string,
    url: string,
    options: {
      headers?: Record<string, string>
      body?: string
      timeoutMs?: number
      followRedirects?: boolean
      maxRedirects?: number
      maxRetries?: number
      retryDelayMs?: number
    } = {}
  ): Promise<Response> {
    const maxRetries = options.maxRetries ?? 3
    const retryDelayMs = options.retryDelayMs ?? 1000

    let lastError: Error | null = null
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        const response = await this.executeRequest(method, url, options)
        if (response.status >= 500 && attempt < maxRetries - 1) {
          await sleep(retryDelayMs * (attempt + 1))
          continue
        }
        return response
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < maxRetries - 1) {
          await sleep(retryDelayMs * (attempt + 1))
        }
      }
    }

    throw lastError ?? new Error(`Request failed: ${method} ${url}`)
  }

  async checkIpLocation(): Promise<{ ok: boolean; location: string | null }> {
    try {
      const response = await this.request(
        "GET",
        "https://cloudflare.com/cdn-cgi/trace",
        {
          timeoutMs: 10_000,
          headers: {
            Accept: "text/plain",
          },
        }
      )
      const body = await response.text()
      const match = /loc=([A-Z]+)/.exec(body)
      const location = match?.[1] ?? null
      if (location && ["CN", "HK", "MO", "TW"].includes(location)) {
        return { ok: false, location }
      }
      return { ok: true, location }
    } catch {
      return { ok: false, location: null }
    }
  }

  private async executeRequest(
    method: string,
    url: string,
    options: {
      headers?: Record<string, string>
      body?: string
      timeoutMs?: number
      followRedirects?: boolean
      maxRedirects?: number
    }
  ): Promise<Response> {
    const followRedirects = options.followRedirects ?? true
    const maxRedirects = options.maxRedirects ?? 10
    const timeoutMs = options.timeoutMs ?? 30_000

    let currentMethod = method.toUpperCase()
    let currentUrl = url
    let currentBody = options.body
    let redirects = 0

    while (true) {
      const headers = new Headers(this.defaultHeaders)
      for (const [key, value] of Object.entries(options.headers ?? {})) {
        headers.set(key, value)
      }

      const cookieHeader = this.cookieJar.getCookieHeader(currentUrl)
      if (cookieHeader) {
        headers.set("cookie", cookieHeader)
      }

      const init: RequestInit & { dispatcher?: ProxyAgent } = {
        method: currentMethod,
        headers,
        body:
          currentMethod === "GET" || currentMethod === "HEAD"
            ? undefined
            : currentBody,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      }

      if (this.dispatcher) {
        init.dispatcher = this.dispatcher
      }

      const response = await fetch(currentUrl, init)
      this.captureCookies(response, currentUrl)

      if (
        !followRedirects ||
        ![301, 302, 303, 307, 308].includes(response.status)
      ) {
        return response
      }

      const location = response.headers.get("location")
      if (!location) {
        return response
      }

      redirects += 1
      if (redirects > maxRedirects) {
        throw new Error(`Too many redirects while requesting ${url}`)
      }

      currentUrl = new URL(location, currentUrl).toString()

      if (
        [301, 302, 303].includes(response.status) &&
        currentMethod !== "HEAD"
      ) {
        currentMethod = "GET"
        currentBody = undefined
      }
    }
  }

  private captureCookies(response: Response, requestUrl: string): void {
    const headers = response.headers as Headers & {
      getSetCookie?: () => string[]
    }
    const values =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : (() => {
            const single = response.headers.get("set-cookie")
            return single ? [single] : []
          })()

    for (const setCookie of values) {
      this.cookieJar.setFromHeader(setCookie, requestUrl)
    }
  }
}

class CFWorkerMailbox {
  private readonly apiUrl: string
  private readonly adminToken: string
  private readonly domain: string
  private readonly domains: string[]
  private readonly enabledDomains: string[]
  private readonly subdomain: string
  private readonly randomSubdomain: boolean
  private readonly fingerprint: string
  private readonly customAuth: string
  private readonly client: HttpClient
  private readonly log?: (message: string) => void
  private token?: string

  constructor(input: ChatGptRegisterInput, log?: (message: string) => void) {
    const allDomains = normalizeStringArray(input.domains).map(normalizeDomain)
    const enabledDomains = normalizeStringArray(input.enabledDomains).map(
      normalizeDomain
    )

    this.apiUrl = String(input.apiUrl ?? "")
      .trim()
      .replace(/\/$/, "")
    this.adminToken = String(input.adminToken ?? "").trim()
    this.domain = normalizeDomain(input.domain)
    this.domains = dedupe(allDomains)
    this.enabledDomains = this.domains.length
      ? enabledDomains.filter((item) => this.domains.includes(item))
      : dedupe(enabledDomains)
    this.subdomain = normalizeSubdomain(input.subdomain)
    this.randomSubdomain = toBoolean(input.randomSubdomain)
    this.fingerprint = String(input.fingerprint ?? "").trim()
    this.customAuth = String(input.customAuth ?? "").trim()
    this.client = new HttpClient(input.proxyUrl, {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "User-Agent": DEFAULT_USER_AGENT,
    })
    this.log = log
  }

  async getEmail(): Promise<MailboxAccount> {
    this.ensureConfigured()

    const payload: Record<string, unknown> = {
      enablePrefix: true,
      name:
        randomString("abcdefghijklmnopqrstuvwxyz", 6) +
        randomString("0123456789", 4),
    }

    const selectedDomain = this.composeDomain(this.pickDomain())
    if (selectedDomain) {
      payload.domain = selectedDomain
      this.log?.(`[CFWorker] using domain: ${selectedDomain}`)
    }

    const response = await this.requestJson(
      "POST",
      "/admin/new_address",
      payload,
      15_000
    )
    const email = String(response.email ?? response.address ?? "").trim()
    const token = String(response.token ?? response.jwt ?? "").trim()
    if (!email || !token) {
      throw new Error("CF Worker /admin/new_address missing email/jwt")
    }

    this.token = token
    this.log?.(`[CFWorker] created inbox: ${email}`)

    return {
      email,
      accountId: token,
      extra: selectedDomain ? { cfworker_domain: selectedDomain } : undefined,
    }
  }

  async getCurrentIds(account: MailboxAccount): Promise<Set<string>> {
    try {
      const mails = await this.getMails(account.email)
      return new Set(
        mails
          .map((mail) => String(mail.id ?? "").trim())
          .filter((value) => value.length > 0)
      )
    } catch {
      return new Set()
    }
  }

  async waitForCode(
    account: MailboxAccount,
    options: {
      timeout?: number
      beforeIds?: Set<string>
      otpSentAt?: number
      excludeCodes?: Set<string>
    } = {}
  ): Promise<string> {
    const seen = new Set(options.beforeIds ?? [])
    const excluded = new Set(
      Array.from(options.excludeCodes ?? [])
        .map((code) => code.trim())
        .filter(Boolean)
    )
    const otpCutoff = options.otpSentAt ? options.otpSentAt - 2_000 : 0
    const deadline = Date.now() + Math.max(options.timeout ?? 120_000, 1_000)

    while (Date.now() < deadline) {
      try {
        const mails = await this.getMails(account.email)
        mails.sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0))

        for (const mail of mails) {
          const mailId = String(mail.id ?? "").trim()
          if (!mailId || seen.has(mailId)) {
            continue
          }

          const createdAt = String(mail.created_at ?? "").trim()
          if (otpCutoff && createdAt) {
            const parsed = Date.parse(`${createdAt.replace(" ", "T")}Z`)
            if (Number.isFinite(parsed) && parsed < otpCutoff) {
              continue
            }
          }

          seen.add(mailId)

          const raw = String(mail.raw ?? "")
          const subject = String(mail.subject ?? "")
          const text = sanitizeMailText(
            `${subject} ${decodeRawMailContent(raw)}`
          )
          const code = extractOtpCode(text)
          if (!code || excluded.has(code)) {
            continue
          }

          this.log?.(`[CFWorker] received verification code: ${code}`)
          return code
        }
      } catch {
        // Keep polling.
      }

      await sleep(3_000)
    }

    throw new Error(
      `waiting for verification code timed out (${Math.round((options.timeout ?? 120_000) / 1000)}s)`
    )
  }

  private ensureConfigured(): void {
    if (!this.apiUrl) {
      throw new Error("CF Worker API URL is required")
    }
  }

  private pickDomain(): string {
    if (this.enabledDomains.length > 0) {
      return (
        this.enabledDomains[
          Math.floor(Math.random() * this.enabledDomains.length)
        ] ?? ""
      )
    }
    if (this.domains.length > 0) {
      return this.domains[0] ?? ""
    }
    return this.domain
  }

  private composeDomain(baseDomain: string): string {
    const normalized = normalizeDomain(baseDomain)
    if (!normalized) {
      return ""
    }

    const parts: string[] = []
    if (this.randomSubdomain) {
      parts.push(randomString("abcdefghijklmnopqrstuvwxyz0123456789", 6))
    }
    if (this.subdomain) {
      parts.push(this.subdomain)
    }

    return parts.length > 0 ? `${parts.join(".")}.${normalized}` : normalized
  }

  private async getMails(email: string): Promise<Record<string, unknown>[]> {
    const response = await this.requestJson(
      "GET",
      `/admin/mails?limit=20&offset=0&address=${encodeURIComponent(email)}`,
      undefined,
      10_000
    )

    if (Array.isArray(response)) {
      return response as Record<string, unknown>[]
    }

    if (response.results && Array.isArray(response.results)) {
      return response.results as Record<string, unknown>[]
    }

    return []
  }

  private async requestJson(
    method: "GET" | "POST",
    path: string,
    payload?: Record<string, unknown>,
    timeoutMs = 15_000
  ): Promise<Record<string, unknown>> {
    const response = await this.client.request(
      method,
      `${this.apiUrl}${path}`,
      {
        timeoutMs,
        followRedirects: true,
        headers: this.headers(),
        body: payload ? JSON.stringify(payload) : undefined,
      }
    )

    const body = await response.text()
    if (response.status >= 400) {
      if (body.toLowerCase().includes("private site password")) {
        throw new Error("CF Worker site password is required")
      }
      throw new Error(
        `CF Worker ${path} failed: HTTP ${response.status} ${(body || "<empty>").slice(0, 200)}`
      )
    }

    try {
      return JSON.parse(body) as Record<string, unknown>
    } catch {
      throw new Error(
        `CF Worker ${path} returned non-JSON: HTTP ${response.status} ${(body || "<empty>").slice(0, 200)}`
      )
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      "x-admin-auth": this.adminToken,
    }

    if (this.fingerprint) {
      headers["x-fingerprint"] = this.fingerprint
    }
    if (this.customAuth) {
      headers["x-custom-auth"] = this.customAuth
    }

    return headers
  }
}

class CFWorkerEmailService {
  readonly serviceType = { value: "cfworker" }
  private account?: MailboxAccount
  private beforeIds = new Set<string>()

  constructor(private readonly mailbox: CFWorkerMailbox) {}

  async createEmail(): Promise<Record<string, string>> {
    this.account = await this.mailbox.getEmail()
    this.beforeIds = await this.mailbox.getCurrentIds(this.account)

    return {
      email: this.account.email,
      service_id: this.account.accountId,
      token: this.account.accountId,
    }
  }

  async getVerificationCode(options: {
    timeout?: number
    otpSentAt?: number
    excludeCodes?: Set<string>
  }): Promise<string> {
    if (!this.account) {
      throw new Error("mailbox account not created yet")
    }

    return this.mailbox.waitForCode(this.account, {
      timeout: options.timeout,
      beforeIds: this.beforeIds,
      otpSentAt: options.otpSentAt,
      excludeCodes: options.excludeCodes,
    })
  }
}

class SentinelTokenGenerator {
  static readonly MAX_ATTEMPTS = 500000
  static readonly ERROR_PREFIX = "wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D"
  readonly deviceId: string
  readonly userAgent: string
  readonly requirementsSeed: string
  readonly sid: string

  constructor(deviceId?: string, userAgent?: string) {
    this.deviceId = deviceId || crypto.randomUUID()
    this.userAgent = userAgent || DEFAULT_USER_AGENT
    this.requirementsSeed = String(Math.random())
    this.sid = crypto.randomUUID()
  }

  generateToken(seed?: string, difficulty?: string): string {
    const activeSeed = seed || this.requirementsSeed
    const activeDifficulty = difficulty || "0"
    const startTime = Date.now()
    const config = this.getConfig()

    for (
      let nonce = 0;
      nonce < SentinelTokenGenerator.MAX_ATTEMPTS;
      nonce += 1
    ) {
      config[3] = nonce
      config[9] = Math.round(Date.now() - startTime)
      const data = base64EncodeJson(config)
      const hashHex = this.fnv1a32(activeSeed + data)
      if (hashHex.slice(0, activeDifficulty.length) <= activeDifficulty) {
        return `gAAAAAB${data}~S`
      }
    }

    return `gAAAAAB${SentinelTokenGenerator.ERROR_PREFIX}${base64EncodeJson(null)}`
  }

  generateRequirementsToken(): string {
    const config = this.getConfig()
    config[3] = 1
    config[9] = Math.round(5 + Math.random() * 45)
    return `gAAAAAC${base64EncodeJson(config)}`
  }

  private fnv1a32(text: string): string {
    let value = 2166136261 >>> 0
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index)
      value = Math.imul(value, 16777619) >>> 0
    }
    value ^= value >>> 16
    value = Math.imul(value, 2246822507) >>> 0
    value ^= value >>> 13
    value = Math.imul(value, 3266489909) >>> 0
    value ^= value >>> 16
    return value.toString(16).padStart(8, "0")
  }

  private getConfig(): Array<string | number | null> {
    const now = new Date()
    const perfNow = 1000 + Math.random() * 49_000
    const timeOrigin = Date.now() - perfNow

    return [
      "1920x1080",
      formatSentinelDate(now),
      4294705152,
      Math.random(),
      this.userAgent,
      "https://sentinel.openai.com/sentinel/20260124ceb8/sdk.js",
      null,
      null,
      "en-US",
      "en-US,en",
      Math.random(),
      "vendorSub−undefined",
      "location",
      "Object",
      perfNow,
      this.sid,
      "",
      [4, 8, 12, 16][Math.floor(Math.random() * 4)] ?? 4,
      timeOrigin,
    ]
  }
}

class ChatGptRegistrationEngine {
  private client: HttpClient
  private oauthStart?: OAuthStart
  private email?: string
  private password?: string
  private emailInfo?: Record<string, string>
  private sessionToken?: string
  private readonly logs: string[] = []
  private otpSentAt?: number
  private deviceId?: string
  private readonly usedVerificationCodes = new Set<string>()
  private isExistingAccount = false
  private tokenAcquiredViaRelogin = false
  private latestPostOtpState: FlowState = {
    pageType: "",
    continueUrl: "",
    method: "GET",
    currentUrl: "",
    source: "",
    payload: {},
    raw: {},
  }

  constructor(
    private readonly emailService: CFWorkerEmailService,
    private readonly input: ChatGptRegisterInput,
    private readonly onLog?: (message: string) => void
  ) {
    this.client = new HttpClient(input.proxyUrl)
  }

  async run(): Promise<RegistrationResult> {
    const result: RegistrationResult = {
      success: false,
      email: "",
      password: "",
      accountId: "",
      workspaceId: "",
      accessToken: "",
      refreshToken: "",
      idToken: "",
      sessionToken: "",
      errorMessage: "",
      logs: this.logs,
      source: "register",
    }

    try {
      this.isExistingAccount = false
      this.tokenAcquiredViaRelogin = false
      this.otpSentAt = undefined
      this.deviceId = undefined
      this.usedVerificationCodes.clear()

      this.log("============================================================")
      this.log("registration flow started")
      this.log("============================================================")

      this.log("1. checking IP location...")
      const ipInfo = await this.client.checkIpLocation()
      if (!ipInfo.ok) {
        result.errorMessage = `unsupported IP location: ${ipInfo.location ?? "unknown"}`
        this.log(`IP check failed: ${ipInfo.location ?? "unknown"}`, "error")
        return result
      }
      this.log(`IP location: ${ipInfo.location ?? "unknown"}`)

      this.log("2. creating mailbox...")
      if (!(await this.createEmail())) {
        result.errorMessage = "failed to create mailbox"
        return result
      }
      result.email = this.email ?? ""

      const authorize = await this.prepareAuthorizeFlow("initial authorization")
      if (!authorize.deviceId) {
        result.errorMessage = "failed to acquire device id"
        return result
      }
      if (!authorize.sentinelToken) {
        result.errorMessage = "failed to pass sentinel"
        return result
      }

      this.log("4. submitting signup email...")
      const signupResult = await this.submitSignupForm(
        authorize.deviceId,
        authorize.sentinelToken
      )
      if (!signupResult.success) {
        result.errorMessage = `failed to submit signup form: ${signupResult.errorMessage}`
        return result
      }

      if (this.isExistingAccount) {
        this.log("existing mailbox detected, switching to login flow")
      } else {
        this.log("5. creating password...")
        const passwordOk = await this.registerPassword()
        if (!passwordOk) {
          result.errorMessage = "failed to register password"
          return result
        }

        this.log("6. sending signup OTP...")
        if (!(await this.sendVerificationCode())) {
          result.errorMessage = "failed to send signup OTP"
          return result
        }

        this.log("7. waiting for signup OTP...")
        const signupCode = await this.getVerificationCode()
        if (!signupCode) {
          result.errorMessage = "failed to fetch signup OTP"
          return result
        }

        this.log("8. validating signup OTP...")
        const validateSignup = await this.validateVerificationCode(signupCode)
        if (!validateSignup.success) {
          result.errorMessage =
            validateSignup.errorMessage || "failed to validate signup OTP"
          return result
        }

        this.log("9. creating OpenAI account...")
        if (!(await this.createUserAccount())) {
          result.errorMessage = "failed to create OpenAI account"
          return result
        }

        const relogin = await this.restartLoginFlow()
        if (!relogin.ok) {
          result.errorMessage = relogin.error
          return result
        }
      }

      if (!(await this.completeTokenExchange(result))) {
        return result
      }

      this.log("============================================================")
      this.log("registration completed successfully")
      this.log(`email: ${result.email}`)
      this.log(`account id: ${result.accountId}`)
      this.log(`workspace id: ${result.workspaceId}`)
      this.log("============================================================")

      result.success = true
      result.metadata = {
        email_service: this.emailService.serviceType.value,
        proxy_used: this.input.proxyUrl ?? "",
        registered_at: new Date().toISOString(),
        is_existing_account: this.isExistingAccount,
        token_acquired_via_relogin: this.tokenAcquiredViaRelogin,
      }

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(`unexpected registration failure: ${message}`, "error")
      result.errorMessage = message
      return result
    }
  }

  private log(
    message: string,
    level: "info" | "warning" | "error" = "info"
  ): void {
    const timestamp = new Date().toTimeString().slice(0, 8)
    const entry = `[${timestamp}] ${message}`
    this.logs.push(entry)
    this.onLog?.(entry)
    if (level === "error") {
      console.error(message)
    } else if (level === "warning") {
      console.warn(message)
    }
  }

  private async createEmail(): Promise<boolean> {
    try {
      this.log(`creating ${this.emailService.serviceType.value} inbox...`)
      this.emailInfo = await this.emailService.createEmail()
      const email = String(this.emailInfo.email ?? "").trim()
      if (!email) {
        this.log("mailbox returned an empty email address", "error")
        return false
      }
      this.email = email
      this.emailInfo.email = email
      this.log(`created inbox: ${email}`)
      return true
    } catch (error) {
      this.log(
        `failed to create inbox: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      )
      return false
    }
  }

  private startOAuth(): boolean {
    try {
      this.log("starting OAuth flow...")
      const state = randomState()
      const codeVerifier = randomVerifier()
      const codeChallenge = sha256Base64UrlNoPad(codeVerifier)
      const params = new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        response_type: "code",
        redirect_uri: OAUTH_REDIRECT_URI,
        scope: OAUTH_SCOPE,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        prompt: "login",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
      })
      this.oauthStart = {
        authUrl: `${OAUTH_AUTH_URL}?${params.toString()}`,
        state,
        codeVerifier,
        redirectUri: OAUTH_REDIRECT_URI,
      }
      this.log(
        `generated OAuth URL: ${this.oauthStart.authUrl.slice(0, 80)}...`
      )
      return true
    } catch (error) {
      this.log(
        `failed to generate OAuth URL: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      )
      return false
    }
  }

  private initSession(): boolean {
    try {
      if (this.deviceId) {
        seedOaiDeviceCookie(this.client.cookieJar, this.deviceId)
      }
      return true
    } catch (error) {
      this.log(
        `failed to initialize session: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      )
      return false
    }
  }

  private async getDeviceId(): Promise<string | undefined> {
    if (!this.oauthStart) {
      return undefined
    }

    if (!this.deviceId) {
      this.deviceId = crypto.randomUUID()
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        seedOaiDeviceCookie(this.client.cookieJar, this.deviceId)
        const response = await this.client.request(
          "GET",
          this.oauthStart.authUrl,
          {
            timeoutMs: 20_000,
            followRedirects: true,
          }
        )
        if (response.status < 400) {
          this.log(`device id: ${this.deviceId}`)
          return this.deviceId
        }
        this.log(
          `failed to establish OAuth session: HTTP ${response.status} (${attempt}/3)`,
          attempt < 3 ? "warning" : "error"
        )
      } catch (error) {
        this.log(
          `failed to establish OAuth session: ${error instanceof Error ? error.message : String(error)} (${attempt}/3)`,
          attempt < 3 ? "warning" : "error"
        )
      }

      if (attempt < 3) {
        await sleep(attempt * 1000)
        this.client = new HttpClient(this.input.proxyUrl)
        if (this.deviceId) {
          seedOaiDeviceCookie(this.client.cookieJar, this.deviceId)
        }
      }
    }

    return undefined
  }

  private async getSentinelHeader(
    flow: string,
    deviceId?: string
  ): Promise<string | undefined> {
    const activeDeviceId =
      String(deviceId || this.deviceId || "").trim() || crypto.randomUUID()
    this.deviceId = activeDeviceId
    seedOaiDeviceCookie(this.client.cookieJar, activeDeviceId)

    const generator = new SentinelTokenGenerator(
      activeDeviceId,
      this.client.defaultHeaders["User-Agent"] || DEFAULT_USER_AGENT
    )
    const challengeBody = JSON.stringify({
      p: generator.generateRequirementsToken(),
      id: activeDeviceId,
      flow,
    })

    try {
      const response = await this.client.request(
        "POST",
        OPENAI_API_ENDPOINTS.sentinel,
        {
          timeoutMs: 20_000,
          followRedirects: false,
          headers: {
            "Content-Type": "text/plain;charset=UTF-8",
            Referer:
              "https://sentinel.openai.com/backend-api/sentinel/frame.html",
            Origin: "https://sentinel.openai.com",
            "User-Agent":
              this.client.defaultHeaders["User-Agent"] || DEFAULT_USER_AGENT,
            "sec-ch-ua": SENTINEL_SEC_CH_UA,
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
          },
          body: challengeBody,
        }
      )

      if (response.status !== 200) {
        this.log(`failed to acquire sentinel token (${flow})`, "warning")
        return undefined
      }

      const data = (await safeParseJson(await response.text())) as Record<
        string,
        unknown
      >
      const challengeToken = String(data.token ?? "").trim()
      if (!challengeToken) {
        this.log(`failed to acquire sentinel token (${flow})`, "warning")
        return undefined
      }

      const powData =
        data.proofofwork && typeof data.proofofwork === "object"
          ? (data.proofofwork as Record<string, unknown>)
          : {}

      const proof =
        powData.required && powData.seed
          ? generator.generateToken(
              String(powData.seed ?? ""),
              String(powData.difficulty ?? "0")
            )
          : generator.generateRequirementsToken()

      const token = JSON.stringify(
        {
          p: proof,
          t: "",
          c: challengeToken,
          id: activeDeviceId,
          flow,
        },
        null,
        0
      )

      this.log(`sentinel token acquired (${flow})`)
      return token
    } catch {
      this.log(`failed to acquire sentinel token (${flow})`, "warning")
      return undefined
    }
  }

  private async submitAuthStart(
    deviceId: string,
    sentinelToken: string | undefined,
    options: {
      screenHint: "signup" | "login"
      referer: string
      logLabel: string
      recordExistingAccount: boolean
    }
  ): Promise<SignupFormResult> {
    try {
      const url = OPENAI_API_ENDPOINTS.signup

      const response = await this.client.request("POST", url, {
        headers: {
          referer: options.referer,
          accept: "application/json",
          "content-type": "application/json",
          "oai-device-id": deviceId,
          ...(sentinelToken ? { "openai-sentinel-token": sentinelToken } : {}),
        },
        body: JSON.stringify({
          username: {
            value: this.email,
            kind: "email",
          },
          screen_hint: options.screenHint,
        }),
      })

      const bodyText = await response.text()
      this.log(`${options.logLabel} status: ${response.status}`)
      if (response.status !== 200) {
        return {
          success: false,
          pageType: "",
          isExistingAccount: false,
          errorMessage: `HTTP ${response.status}: ${bodyText.slice(0, 200)}`,
        }
      }

      const data = (await safeParseJson(bodyText)) as Record<string, unknown>
      const page =
        data.page && typeof data.page === "object"
          ? (data.page as Record<string, unknown>)
          : {}
      const pageType = String(page.type ?? "").trim()

      this.log(`response page type: ${pageType}`)
      const isExisting = pageType === OPENAI_PAGE_TYPES.emailOtpVerification
      if (isExisting) {
        this.otpSentAt = Date.now()
        if (options.recordExistingAccount) {
          this.log("existing account detected, switching to login flow")
          this.isExistingAccount = true
        } else {
          this.log("login flow reached OTP page")
        }
      }

      return {
        success: true,
        pageType,
        isExistingAccount: isExisting,
        responseData: data,
        errorMessage: "",
      }
    } catch (error) {
      return {
        success: false,
        pageType: "",
        isExistingAccount: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private submitSignupForm(
    deviceId: string,
    sentinelToken?: string
  ): Promise<SignupFormResult> {
    return this.submitAuthStart(deviceId, sentinelToken, {
      screenHint: "signup",
      referer: "https://auth.openai.com/create-account",
      logLabel: "submit signup email",
      recordExistingAccount: true,
    })
  }

  private submitLoginStart(
    deviceId: string,
    sentinelToken?: string
  ): Promise<SignupFormResult> {
    return this.submitAuthStart(deviceId, sentinelToken, {
      screenHint: "login",
      referer: "https://auth.openai.com/log-in",
      logLabel: "submit login email",
      recordExistingAccount: false,
    })
  }

  private async submitLoginPassword(): Promise<SignupFormResult> {
    try {
      const sentinelHeader = await this.getSentinelHeader("password_verify")
      const url = OPENAI_API_ENDPOINTS.passwordVerify

      const response = await this.client.request("POST", url, {
        headers: {
          referer: "https://auth.openai.com/log-in/password",
          accept: "application/json",
          "content-type": "application/json",
          "oai-device-id": this.deviceId || "",
          ...(sentinelHeader
            ? { "openai-sentinel-token": sentinelHeader }
            : {}),
        },
        body: JSON.stringify({ password: this.password }),
      })

      const bodyText = await response.text()
      this.log(`submit login password status: ${response.status}`)
      if (response.status !== 200) {
        return {
          success: false,
          pageType: "",
          isExistingAccount: false,
          errorMessage: `HTTP ${response.status}: ${bodyText.slice(0, 200)}`,
        }
      }

      const data = (await safeParseJson(bodyText)) as Record<string, unknown>
      const page =
        data.page && typeof data.page === "object"
          ? (data.page as Record<string, unknown>)
          : {}
      const pageType = String(page.type ?? "").trim()
      const isExisting = pageType === OPENAI_PAGE_TYPES.emailOtpVerification
      if (isExisting) {
        this.otpSentAt = Date.now()
        this.log("password accepted, waiting for login OTP")
      }

      return {
        success: true,
        pageType,
        isExistingAccount: isExisting,
        responseData: data,
        errorMessage: "",
      }
    } catch (error) {
      return {
        success: false,
        pageType: "",
        isExistingAccount: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private resetAuthFlow(): void {
    this.client = new HttpClient(this.input.proxyUrl)
    this.oauthStart = undefined
    this.sessionToken = undefined
    this.otpSentAt = undefined
    if (this.deviceId) {
      seedOaiDeviceCookie(this.client.cookieJar, this.deviceId)
    }
  }

  private async prepareAuthorizeFlow(label: string): Promise<{
    deviceId?: string
    sentinelToken?: string
  }> {
    this.log(`${label}: initialize session`)
    if (!this.initSession()) {
      return {}
    }

    this.log(`${label}: initialize OAuth`)
    if (!this.startOAuth()) {
      return {}
    }

    this.log(`${label}: acquire device id`)
    const deviceId = await this.getDeviceId()
    if (!deviceId) {
      return {}
    }

    this.log(`${label}: solve sentinel`)
    const sentinelToken = await this.getSentinelHeader(
      "authorize_continue",
      deviceId
    )
    if (!sentinelToken) {
      return { deviceId }
    }

    this.log(`${label}: sentinel passed`)
    return { deviceId, sentinelToken }
  }

  private async registerPassword(): Promise<boolean> {
    try {
      const password =
        String(this.password ?? "").trim() || generateRandomPassword()
      this.password = password
      this.log(`generated password: ${password}`)

      const sentinelHeader = await this.getSentinelHeader(
        "username_password_create"
      )
      const url = OPENAI_API_ENDPOINTS.register

      const response = await this.client.request("POST", url, {
        headers: {
          referer: "https://auth.openai.com/create-account/password",
          accept: "application/json",
          "content-type": "application/json",
          "oai-device-id": this.deviceId || "",
          ...(sentinelHeader
            ? { "openai-sentinel-token": sentinelHeader }
            : {}),
        },
        body: JSON.stringify({
          password,
          username: this.email,
        }),
      })

      const bodyText = await response.text()
      this.log(`submit password status: ${response.status}`)
      if (response.status !== 200) {
        this.log(
          `password registration failed: ${bodyText.slice(0, 200)}`,
          "warning"
        )
        return false
      }

      return true
    } catch (error) {
      this.log(
        `failed to register password: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      )
      return false
    }
  }

  private async sendVerificationCode(): Promise<boolean> {
    try {
      this.otpSentAt = Date.now()
      const url = OPENAI_API_ENDPOINTS.sendOtp
      const response = await this.client.request("GET", url, {
        headers: {
          referer: "https://auth.openai.com/create-account/password",
          accept: "application/json",
        },
      })
      this.log(`send OTP status: ${response.status}`)
      return response.status === 200
    } catch (error) {
      this.log(
        `failed to send OTP: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      )
      return false
    }
  }

  private async getVerificationCode(): Promise<string | undefined> {
    try {
      this.log(`waiting for verification email at ${this.email}...`)
      const code = await this.emailService.getVerificationCode({
        timeout: 30_000,
        otpSentAt: this.otpSentAt,
        excludeCodes: this.usedVerificationCodes,
      })
      const normalized = String(code ?? "").trim()
      if (normalized) {
        this.usedVerificationCodes.add(normalized)
        this.log(`received verification code: ${normalized}`)
        return normalized
      }
      return undefined
    } catch (error) {
      this.log(
        `failed to read verification code: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      )
      return undefined
    }
  }

  private async validateVerificationCode(
    code: string
  ): Promise<SignupFormResult> {
    try {
      const url = OPENAI_API_ENDPOINTS.validateOtp
      const response = await this.client.request("POST", url, {
        headers: {
          referer: "https://auth.openai.com/email-verification",
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ code }),
      })

      const bodyText = await response.text()
      this.log(`validate OTP status: ${response.status}`)
      if (response.status !== 200) {
        return {
          success: false,
          pageType: "",
          isExistingAccount: false,
          errorMessage: `HTTP ${response.status}: ${bodyText.slice(0, 200)}`,
        }
      }

      const data = (await safeParseJson(bodyText)) as Record<string, unknown>
      const state = extractFlowState(data, response.url || "")
      this.latestPostOtpState = state
      if (state.pageType || state.continueUrl || state.currentUrl) {
        this.log(`post OTP state: ${describeFlowState(state)}`)
      }

      return {
        success: true,
        pageType: state.pageType,
        isExistingAccount: false,
        responseData: data,
        errorMessage: "",
      }
    } catch (error) {
      return {
        success: false,
        pageType: "",
        isExistingAccount: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async createUserAccount(): Promise<boolean> {
    try {
      const profile = generateRandomUserInfo()
      this.log(
        `generated profile: ${profile.name}, birthdate: ${profile.birthdate}`
      )
      const sentinelHeader = await this.getSentinelHeader(
        "oauth_create_account"
      )

      const url = OPENAI_API_ENDPOINTS.createAccount

      const response = await this.client.request("POST", url, {
        headers: {
          referer: "https://auth.openai.com/about-you",
          accept: "application/json",
          "content-type": "application/json",
          "oai-device-id": this.deviceId || "",
          ...(sentinelHeader
            ? { "openai-sentinel-token": sentinelHeader }
            : {}),
        },
        body: JSON.stringify(profile),
      })

      const bodyText = await response.text()
      this.log(`create account status: ${response.status}`)
      if (response.status !== 200) {
        this.log(
          `account creation failed: ${bodyText.slice(0, 200)}`,
          "warning"
        )
        return false
      }

      return true
    } catch (error) {
      this.log(
        `failed to create user account: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      )
      return false
    }
  }

  private async fetchConsentPageHtml(consentUrl: string): Promise<string> {
    try {
      const response = await this.client.request("GET", consentUrl, {
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          referer: "https://auth.openai.com/email-verification",
        },
        followRedirects: false,
        timeoutMs: 30_000,
      })

      if (
        response.status === 200 &&
        (response.headers.get("content-type") || "")
          .toLowerCase()
          .includes("text/html")
      ) {
        return response.text()
      }
    } catch {
      return ""
    }

    return ""
  }

  private extractSessionDataFromConsentHtml(
    html: string
  ): Record<string, unknown> | undefined {
    if (!html || !html.includes("workspaces")) {
      return undefined
    }

    const firstMatch = (patterns: RegExp[], text: string): string => {
      for (const pattern of patterns) {
        const match = pattern.exec(text)
        if (match?.[1]) {
          return match[1]
        }
      }
      return ""
    }

    const buildFromText = (
      text: string
    ): Record<string, unknown> | undefined => {
      if (!text || !text.includes("workspaces")) {
        return undefined
      }

      const normalized = text.replace(/\\"/g, '"')
      let start = normalized.indexOf('"workspaces"')
      if (start < 0) {
        start = normalized.indexOf("workspaces")
      }
      if (start < 0) {
        return undefined
      }

      let end = normalized.indexOf('"openai_client_id"', start)
      if (end < 0) {
        end = Math.min(normalized.length, start + 4000)
      }

      const workspaceChunk = normalized.slice(start, end)
      const ids = Array.from(
        workspaceChunk.matchAll(/"id"(?:,|:)"([0-9a-fA-F-]{36})"/g)
      ).map((match) => match[1] ?? "")

      if (ids.length === 0) {
        return undefined
      }

      const kinds = Array.from(
        workspaceChunk.matchAll(/"kind"(?:,|:)"([^"]+)"/g)
      ).map((match) => match[1] ?? "")

      const workspaces: Array<Record<string, string>> = []
      const seen = new Set<string>()
      ids.forEach((id, index) => {
        if (!id || seen.has(id)) {
          return
        }
        seen.add(id)
        workspaces.push({
          id,
          ...(kinds[index] ? { kind: kinds[index] ?? "" } : {}),
        })
      })

      if (workspaces.length === 0) {
        return undefined
      }

      return {
        session_id: firstMatch(
          [/"session_id","([^"]+)"/s, /"session_id":"([^"]+)"/s],
          normalized
        ),
        openai_client_id: firstMatch(
          [/"openai_client_id","([^"]+)"/s, /"openai_client_id":"([^"]+)"/s],
          normalized
        ),
        workspaces,
      }
    }

    const candidates = [html]
    for (const match of html.matchAll(
      /streamController\.enqueue\(("(?:\\.|[^"\\])*")\)/gs
    )) {
      const quoted = match[1]
      if (!quoted) {
        continue
      }
      try {
        candidates.push(JSON.parse(quoted) as string)
      } catch {
        // Ignore malformed chunks.
      }
    }
    if (html.includes('\\"')) {
      candidates.push(html.replace(/\\"/g, '"'))
    }

    for (const candidate of candidates) {
      const parsed = buildFromText(candidate)
      if (
        parsed &&
        Array.isArray(parsed.workspaces) &&
        parsed.workspaces.length > 0
      ) {
        return parsed
      }
    }

    return undefined
  }

  private async loadWorkspaceSessionData(
    consentUrl: string
  ): Promise<Record<string, unknown> | undefined> {
    const html = await this.fetchConsentPageHtml(consentUrl)
    if (!html) {
      this.log(
        `failed to fetch consent html: ${consentUrl.slice(0, 120)}`,
        "warning"
      )
      return undefined
    }

    const parsed = this.extractSessionDataFromConsentHtml(html)
    if (
      parsed &&
      Array.isArray(parsed.workspaces) &&
      parsed.workspaces.length > 0
    ) {
      this.log(
        `extracted ${parsed.workspaces.length} workspace(s) from consent html`
      )
      return parsed
    }

    this.log("workspace not found in consent html", "warning")
    return undefined
  }

  private async getWorkspaceId(consentUrl = ""): Promise<string | undefined> {
    try {
      const authCookie = this.client.cookieJar.get(
        "oai-client-auth-session",
        "https://auth.openai.com/"
      )

      if (!authCookie) {
        this.log("authorization cookie missing", "error")
        return undefined
      }

      const segments = authCookie.split(".").filter(Boolean)
      for (let index = 0; index < Math.min(segments.length, 2); index += 1) {
        const authJson = decodeJwtSegment(segments[index] ?? "")
        const workspaces = Array.isArray(authJson.workspaces)
          ? (authJson.workspaces as Array<Record<string, unknown>>)
          : []
        const workspaceId = String(workspaces[0]?.id ?? "").trim()
        if (workspaceId) {
          this.log(`workspace id: ${workspaceId}`)
          return workspaceId
        }
      }

      const targetConsentUrl =
        String(consentUrl || "").trim() ||
        "https://auth.openai.com/sign-in-with-chatgpt/codex/consent"
      const sessionData = await this.loadWorkspaceSessionData(targetConsentUrl)
      const workspaces = Array.isArray(sessionData?.workspaces)
        ? (sessionData.workspaces as Array<Record<string, unknown>>)
        : []
      const workspaceId = String(workspaces[0]?.id ?? "").trim()
      if (workspaceId) {
        this.log(`workspace id: ${workspaceId}`)
        return workspaceId
      }

      return undefined
    } catch (error) {
      this.log(
        `failed to get workspace id: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      )
      return undefined
    }
  }

  private async selectWorkspace(
    workspaceId: string
  ): Promise<string | undefined> {
    try {
      const url = OPENAI_API_ENDPOINTS.selectWorkspace

      const response = await this.client.request("POST", url, {
        headers: {
          referer: "https://auth.openai.com/sign-in-with-chatgpt/codex/consent",
          "content-type": "application/json",
        },
        body: JSON.stringify({ workspace_id: workspaceId }),
      })

      const bodyText = await response.text()
      if (response.status !== 200) {
        this.log(`select workspace failed: ${response.status}`, "error")
        return undefined
      }

      const data = (await safeParseJson(bodyText)) as Record<string, unknown>
      const continueUrl = String(data.continue_url ?? "").trim()
      if (!continueUrl) {
        this.log("workspace response missing continue_url", "error")
        return undefined
      }

      this.log(`continue url: ${continueUrl.slice(0, 100)}...`)
      return continueUrl
    } catch (error) {
      this.log(
        `failed to select workspace: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      )
      return undefined
    }
  }

  private async followRedirects(startUrl: string): Promise<string | undefined> {
    try {
      let currentUrl = startUrl
      for (let index = 0; index < 6; index += 1) {
        this.log(`redirect ${index + 1}/6: ${currentUrl.slice(0, 100)}...`)
        const response = await this.client.request("GET", currentUrl, {
          followRedirects: false,
          timeoutMs: 15_000,
        })

        const location = response.headers.get("location") || ""
        if (![301, 302, 303, 307, 308].includes(response.status)) {
          break
        }
        if (!location) {
          break
        }

        const nextUrl = new URL(location, currentUrl).toString()
        if (nextUrl.includes("code=") && nextUrl.includes("state=")) {
          this.log(`found OAuth callback URL: ${nextUrl.slice(0, 100)}...`)
          return nextUrl
        }
        currentUrl = nextUrl
      }

      this.log("OAuth callback URL not found in redirect chain", "error")
      return undefined
    } catch (error) {
      this.log(
        `failed to follow redirects: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      )
      return undefined
    }
  }

  private async handleOAuthCallback(
    callbackUrl: string
  ): Promise<Record<string, string> | undefined> {
    if (!this.oauthStart) {
      this.log("OAuth flow not initialized", "error")
      return undefined
    }

    try {
      this.log("handling OAuth callback...")
      const callback = parseCallbackUrl(callbackUrl)
      if (callback.error) {
        throw new Error(
          `oauth error: ${callback.error}: ${callback.errorDescription}`.trim()
        )
      }
      if (!callback.code) {
        throw new Error("callback url missing ?code=")
      }
      if (!callback.state) {
        throw new Error("callback url missing ?state=")
      }
      if (callback.state !== this.oauthStart.state) {
        throw new Error("state mismatch")
      }

      const exchangeClient = new HttpClient(this.input.proxyUrl, {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": DEFAULT_USER_AGENT,
      })
      const response = await exchangeClient.request("POST", OAUTH_TOKEN_URL, {
        followRedirects: true,
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: OAUTH_CLIENT_ID,
          code: callback.code,
          redirect_uri: OAUTH_REDIRECT_URI,
          code_verifier: this.oauthStart.codeVerifier,
        }).toString(),
      })

      const bodyText = await response.text()
      if (response.status !== 200) {
        throw new Error(
          `token exchange failed: ${response.status}: ${bodyText.slice(0, 200)}`
        )
      }

      const data = (await safeParseJson(bodyText)) as Record<string, unknown>
      const idToken = String(data.id_token ?? "").trim()
      const claims = decodeJwtPayload(idToken)
      const authClaims = (claims["https://api.openai.com/auth"] ??
        {}) as Record<string, unknown>

      this.log("OAuth exchange succeeded")
      return {
        account_id: String(authClaims.chatgpt_account_id ?? "").trim(),
        access_token: String(data.access_token ?? "").trim(),
        refresh_token: String(data.refresh_token ?? "").trim(),
        id_token: idToken,
        email: String(claims.email ?? "").trim(),
      }
    } catch (error) {
      this.log(
        `failed to handle OAuth callback: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      )
      return undefined
    }
  }

  private async completeTokenExchange(
    result: RegistrationResult
  ): Promise<boolean> {
    this.log("waiting for login OTP...")
    const code = await this.getVerificationCode()
    if (!code) {
      result.errorMessage = "failed to fetch login OTP"
      return false
    }

    this.log("validating login OTP...")
    const validate = await this.validateVerificationCode(code)
    if (!validate.success) {
      result.errorMessage =
        validate.errorMessage || "failed to validate login OTP"
      return false
    }

    this.log("fetching workspace id...")
    const workspaceId = await this.getWorkspaceId(
      this.latestPostOtpState.continueUrl || this.latestPostOtpState.currentUrl
    )
    if (!workspaceId) {
      result.errorMessage = "failed to fetch workspace id"
      return false
    }
    result.workspaceId = workspaceId

    this.log("selecting workspace...")
    const continueUrl = await this.selectWorkspace(workspaceId)
    if (!continueUrl) {
      result.errorMessage = "failed to select workspace"
      return false
    }

    this.log("following redirect chain...")
    const callbackUrl = await this.followRedirects(continueUrl)
    if (!callbackUrl) {
      result.errorMessage = "failed to follow OAuth redirects"
      return false
    }

    this.log("exchanging authorization code...")
    const tokenInfo = await this.handleOAuthCallback(callbackUrl)
    if (!tokenInfo) {
      result.errorMessage = "failed to exchange authorization code"
      return false
    }

    result.accountId = tokenInfo.account_id || ""
    result.accessToken = tokenInfo.access_token || ""
    result.refreshToken = tokenInfo.refresh_token || ""
    result.idToken = tokenInfo.id_token || ""
    result.password = this.password || ""
    result.source = this.isExistingAccount ? "login" : "register"

    const sessionToken = this.client.cookieJar.get(
      "__Secure-next-auth.session-token",
      "https://chatgpt.com/"
    )
    if (sessionToken) {
      this.sessionToken = sessionToken
      result.sessionToken = sessionToken
      this.log("captured session token")
    }

    return true
  }

  private async restartLoginFlow(): Promise<{ ok: boolean; error: string }> {
    this.tokenAcquiredViaRelogin = true
    this.log(
      "registration finished, re-running login flow to acquire tokens..."
    )
    this.resetAuthFlow()

    const authorize = await this.prepareAuthorizeFlow("re-login")
    if (!authorize.deviceId) {
      return { ok: false, error: "failed to acquire device id for re-login" }
    }
    if (!authorize.sentinelToken) {
      return { ok: false, error: "failed to pass sentinel for re-login" }
    }

    const loginStart = await this.submitLoginStart(
      authorize.deviceId,
      authorize.sentinelToken
    )
    if (!loginStart.success) {
      return {
        ok: false,
        error: `re-login email submission failed: ${loginStart.errorMessage}`,
      }
    }
    if (loginStart.pageType !== OPENAI_PAGE_TYPES.loginPassword) {
      return {
        ok: false,
        error: `re-login did not reach password page: ${
          loginStart.pageType || "unknown"
        }`,
      }
    }

    const passwordResult = await this.submitLoginPassword()
    if (!passwordResult.success) {
      return {
        ok: false,
        error: `re-login password submission failed: ${passwordResult.errorMessage}`,
      }
    }
    if (!passwordResult.isExistingAccount) {
      return {
        ok: false,
        error: `re-login did not reach OTP page: ${
          passwordResult.pageType || "unknown"
        }`,
      }
    }

    return { ok: true, error: "" }
  }
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function randomString(alphabet: string, length: number): string {
  let result = ""
  for (let index = 0; index < length; index += 1) {
    result += randomChar(alphabet)
  }
  return result
}

function decodeRawMailContent(raw: string): string {
  let text = String(raw ?? "")
  if (!text) {
    return ""
  }

  if (text.includes("\r\n\r\n")) {
    text = text.split("\r\n\r\n", 2)[1] ?? text
  } else if (text.includes("\n\n")) {
    text = text.split("\n\n", 2)[1] ?? text
  }

  try {
    text = decodeQuotedPrintable(text)
  } catch {
    // Ignore decode errors.
  }

  text = decodeHtmlEntities(text)
  text = text
    .replace(/^content-(?:type|transfer-encoding):.*$/gim, " ")
    .replace(/^--+[_=\w.-]+$/gim, " ")
    .replace(/----=_part_[\w.]+/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  return text
}

function sanitizeMailText(text: string): string {
  return text
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "")
    .replace(/m=\+\d+\.\d+/g, "")
    .replace(/\bt=\d+\b/g, "")
    .trim()
}

function extractOtpCode(text: string): string | undefined {
  const patterns = [
    /(?:verification\s+code|one[-\s]*time\s+(?:password|code)|security\s+code|login\s+code|验证码|校验码|动态码|認證碼|驗證碼)[^0-9]{0,30}(\d{6})/is,
    /\bcode\b[^0-9]{0,12}(\d{6})/is,
    OTP_CODE_PATTERN,
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match?.[1]) {
      return match[1]
    }
    if (match?.[0] && OTP_CODE_PATTERN.test(match[0])) {
      return match[0]
    }
  }

  return undefined
}

function decodeQuotedPrintable(input: string): string {
  const normalized = input.replace(/=\r?\n/g, "")
  const bytes: number[] = []
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? ""
    if (
      char === "=" &&
      /^[0-9A-Fa-f]{2}$/.test(normalized.slice(index + 1, index + 3))
    ) {
      bytes.push(Number.parseInt(normalized.slice(index + 1, index + 3), 16))
      index += 2
    } else {
      bytes.push(char.charCodeAt(0))
    }
  }
  return Buffer.from(bytes).toString("utf-8")
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function base64EncodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64")
}

function formatSentinelDate(date: Date): string {
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ]

  return `${weekdays[date.getUTCDay()] ?? "Mon"} ${
    months[date.getUTCMonth()] ?? "Jan"
  } ${String(date.getUTCDate()).padStart(2, "0")} ${date.getUTCFullYear()} ${String(
    date.getUTCHours()
  ).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(
    date.getUTCSeconds()
  ).padStart(2, "0")} GMT+0000 (Coordinated Universal Time)`
}

function parseCallbackUrl(callbackUrl: string): {
  code: string
  state: string
  error: string
  errorDescription: string
} {
  let candidate = callbackUrl.trim()
  if (!candidate) {
    return { code: "", state: "", error: "", errorDescription: "" }
  }

  if (!candidate.includes("://")) {
    if (candidate.startsWith("?")) {
      candidate = `http://localhost${candidate}`
    } else if (/[/?#]/.test(candidate) || candidate.includes(":")) {
      candidate = `http://${candidate}`
    } else if (candidate.includes("=")) {
      candidate = `http://localhost/?${candidate}`
    }
  }

  const parsed = new URL(candidate)
  const query = new URLSearchParams(parsed.search)
  const fragment = new URLSearchParams(
    parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash
  )

  for (const [key, value] of fragment.entries()) {
    if (!query.get(key)?.trim()) {
      query.set(key, value)
    }
  }

  let code = query.get("code")?.trim() ?? ""
  let state = query.get("state")?.trim() ?? ""
  const error = query.get("error")?.trim() ?? ""
  let errorDescription = query.get("error_description")?.trim() ?? ""

  if (code && !state && code.includes("#")) {
    const [actualCode, actualState] = code.split("#", 2)
    code = actualCode ?? ""
    state = actualState ?? ""
  }

  if (!error && errorDescription) {
    return {
      code,
      state,
      error: errorDescription,
      errorDescription: "",
    }
  }

  return { code, state, error, errorDescription }
}

async function safeParseJson(
  text: string
): Promise<Record<string, unknown> | unknown[]> {
  try {
    return JSON.parse(text) as Record<string, unknown> | unknown[]
  } catch {
    return {}
  }
}

export async function registerChatGpt(
  input: ChatGptRegisterInput,
  onLog?: (line: string) => void
): Promise<ChatGptRegisterResult> {
  const mailbox = new CFWorkerMailbox(input, onLog)
  const emailService = new CFWorkerEmailService(mailbox)
  const engine = new ChatGptRegistrationEngine(emailService, input, onLog)
  const result = await engine.run()

  if (!result.success) {
    throw new Error(result.errorMessage || "ChatGPT registration failed")
  }

  const claims = parseJwtClaims(result.idToken)

  return {
    account: {
      email: claims.email || result.email,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      idToken: result.idToken,
      accountId: claims.accountId || result.accountId,
      expire: claims.expire,
      planType: claims.planType,
    },
    metadata: result.metadata,
    logs: [...result.logs],
  }
}
