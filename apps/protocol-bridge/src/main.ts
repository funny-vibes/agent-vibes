import fastifyCors from "@fastify/cors"
import {
  BadRequestException,
  Logger,
  type LogLevel,
  ValidationPipe,
} from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify"
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger"
import { execSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { AppModule } from "./app.module"
import { ModelRouterService } from "./llm/shared/model-router.service"
import { registerContentTypeParsers } from "./shared/content-type-parsers"
import { registerRequestHooks } from "./shared/request-hooks"

// ── Auto-configure NODE_EXTRA_CA_CERTS for mkcert CA ──────────────────
// Electron/Node.js does NOT read macOS System Keychain for TLS trust.
// This ensures the mkcert root CA is trusted by all Node.js HTTPS clients.
if (!process.env.NODE_EXTRA_CA_CERTS) {
  try {
    const caRoot = execSync("mkcert -CAROOT", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim()
    const caRootPem = path.join(caRoot, "rootCA.pem")
    if (fs.existsSync(caRootPem)) {
      process.env.NODE_EXTRA_CA_CERTS = caRootPem
    }
  } catch {
    // mkcert not installed or not in PATH — ignore
  }
}

async function bootstrap() {
  // ── Debug Mode ─────────────────────────────────────────────────────
  // npm run start       → quiet (warn + error only, no file tee)
  // npm run start:debug → verbose (all levels + full file logging)
  const isDebug = process.env.LOG_DEBUG === "true"
  const nestLogLevels: LogLevel[] = isDebug
    ? ["verbose", "debug", "log", "warn", "error"]
    : ["warn", "error"]

  // ── File Logging (debug mode only) ─────────────────────────────────
  const logDir = path.join(os.tmpdir(), "agent-vibes-logs")
  fs.mkdirSync(logDir, { recursive: true })

  const timestampForFilename = () =>
    new Date().toISOString().replace(/[:.]/g, "-")
  const logFileName = `protocol-bridge-${timestampForFilename()}.log`
  const logFilePath = path.join(logDir, logFileName)
  const latestLogPath = path.join(logDir, "protocol-bridge.log")

  const logStream = fs.createWriteStream(logFilePath, { flags: "a" })
  try {
    if (fs.existsSync(latestLogPath)) {
      fs.unlinkSync(latestLogPath)
    }
    fs.symlinkSync(logFileName, latestLogPath)
  } catch {
    fs.copyFileSync(logFilePath, latestLogPath)
  }

  logStream.write(
    `\n${"=".repeat(60)}\n[${new Date().toISOString()}] Agent Vibes server starting (debug=${isDebug})\n${"=".repeat(60)}\n`
  )

  const origStdoutWrite = process.stdout.write.bind(process.stdout)
  const origStderrWrite = process.stderr.write.bind(process.stderr)

  if (isDebug) {
    // Debug: tee ALL stdout to log file
    process.stdout.write = ((
      chunk: string | Uint8Array,
      ...args: unknown[]
    ): boolean => {
      logStream.write(chunk)
      return origStdoutWrite(chunk, ...(args as []))
    }) as typeof process.stdout.write
  } else {
    // Normal: only capture warnings/errors/stack traces to log file
    const ISSUE_PATTERN = /\b(WARN|ERROR|Error|Exception|FATAL|reject|fail)/i
    const STACK_PATTERN = /^\s+at\s/
    let lastWasError = false

    process.stdout.write = ((
      chunk: string | Uint8Array,
      ...args: unknown[]
    ): boolean => {
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
      if (ISSUE_PATTERN.test(text)) {
        lastWasError = true
        logStream.write(chunk)
      } else if (lastWasError && STACK_PATTERN.test(text)) {
        logStream.write(chunk)
      } else {
        lastWasError = false
      }
      return origStdoutWrite(chunk, ...(args as []))
    }) as typeof process.stdout.write
  }

  // stderr always goes to log file (crash diagnostics)
  process.stderr.write = ((
    chunk: string | Uint8Array,
    ...args: unknown[]
  ): boolean => {
    logStream.write(chunk)
    return origStderrWrite(chunk, ...(args as []))
  }) as typeof process.stderr.write
  // ── End File Logging ───────────────────────────────────────────────

  const logger = new Logger("Bootstrap")

  // Check if SSL certificates exist for HTTP/2
  // Priority: ~/.agent-vibes/certs/ (extension-generated) > apps/protocol-bridge/certs/ (mkcert)
  const agentVibesCertsDir = path.join(
    process.env.AGENT_VIBES_DATA_DIR || path.join(os.homedir(), ".agent-vibes"),
    "certs"
  )
  const certCandidates = [
    {
      cert: path.join(agentVibesCertsDir, "server.pem"),
      key: path.join(agentVibesCertsDir, "server-key.pem"),
    },
    {
      cert: path.join(__dirname, "..", "certs", "localhost.crt"),
      key: path.join(__dirname, "..", "certs", "localhost.key"),
    },
  ]
  const foundCerts = certCandidates.find(
    (c) => fs.existsSync(c.cert) && fs.existsSync(c.key)
  )
  const certPath = foundCerts?.cert
  const keyPath = foundCerts?.key
  const useHttp2 =
    certPath != null && keyPath != null && process.env.USE_HTTP2 !== "false"

  // Create Fastify adapter with HTTP/2 support
  const fastifyAdapter = new FastifyAdapter(
    useHttp2
      ? {
          logger: false,
          bodyLimit: 52428800, // 50MB
          http2: true,
          https: {
            allowHTTP1: true, // Allow HTTP/1.1 fallback (required for pf rdr on lo0)
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
          },
          // CRITICAL: Disable response buffering for SSE streaming
          // This ensures chunks are sent immediately to prevent Cursor timeout
          disableRequestLogging: true,
          requestIdHeader: false,
        }
      : {
          logger: false,
          bodyLimit: 52428800, // 50MB
          // CRITICAL: Disable response buffering for SSE streaming
          disableRequestLogging: true,
          requestIdHeader: false,
        }
  )

  // Get Fastify instance BEFORE creating NestJS app
  const fastifyInstance = fastifyAdapter.getInstance()

  // Register custom content type parsers for gRPC/ConnectRPC BEFORE NestJS initialization
  // This must be done before NestFactory.create() to avoid conflicts with NestJS default parsers
  registerContentTypeParsers(fastifyInstance, logger)

  // Create NestJS application
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    fastifyAdapter,
    { logger: nestLogLevels }
  )
  app.enableShutdownHooks()

  // Enable CORS
  await fastifyInstance.register(fastifyCors, {
    origin: "*",
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: "*",
    credentials: false,
  })

  // Register request logging hooks
  registerRequestHooks(fastifyInstance, logger)

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      skipMissingProperties: true,
      exceptionFactory: (errors) => {
        logger.error(`[ValidationPipe] Validation failed:`)
        errors.forEach((error, index) => {
          logger.error(
            `[ValidationPipe] Error ${index + 1}: property=${error.property}, ` +
              `constraints=${JSON.stringify(error.constraints)}, ` +
              `value type=${typeof error.value}`
          )
        })
        // Return default BadRequestException
        return new BadRequestException(errors)
      },
    })
  )

  // Swagger documentation (skip in SEA mode to avoid circular dep in bundled code)
  const isSea = (() => {
    try {
      return require("node:sea").isSea()
    } catch {
      return false
    }
  })()
  if (!isSea) {
    const config = new DocumentBuilder()
      .setTitle("Agent Vibes Proxy")
      .setDescription(
        "Unified Claude Code API Proxy with Antigravity and Gemini WebSearch"
      )
      .setVersion("1.0")
      .addApiKey({ type: "apiKey", name: "x-api-key", in: "header" }, "api-key")
      .build()

    const document = SwaggerModule.createDocument(app, config)
    SwaggerModule.setup("docs", app, document)
  }

  const port = process.env.PORT || 2026
  await app.listen(port, "0.0.0.0")

  const protocol = useHttp2 ? "https" : "http"
  const http2Status = useHttp2
    ? "ENABLED (HTTP/2 only)"
    : "DISABLED (HTTP/1.1 only)"

  // ── Startup Banner ─────────────────────────────────────────────────
  // Brand colors from design-vibes (24-bit true color ANSI)
  const c = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    white: "\x1b[97m",
    // design-vibes brand palette
    red: "\x1b[38;2;242;78;30m", // #F24E1E
    orange: "\x1b[38;2;255;114;98m", // #FF7262
    purple: "\x1b[38;2;162;89;255m", // #A259FF
    blue: "\x1b[38;2;26;188;254m", // #1ABCFE
    green: "\x1b[38;2;10;207;131m", // #0ACF83
    yellow: "\x1b[38;2;255;199;0m", // #FFC700
  }
  const W = 62 // inner width (between ║ chars)
  // eslint-disable-next-line no-control-regex
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")
  const pad = (s: string, w = W) =>
    s + " ".repeat(Math.max(0, w - strip(s).length))
  const line = (content: string) =>
    `${c.blue}║${c.reset} ${pad(content, W - 1)}${c.blue}║${c.reset}`
  const empty = line("")
  const sep = `${c.blue}╠${"═".repeat(W)}╣${c.reset}`

  const serverUrl = `${protocol}://localhost:${port}`

  // Funny Vibes ASCII Art Logo (medium size)
  const logo = [
    `${c.bold}${c.red} ██▀▀▀ ${c.orange}█  █ ${c.red}█▄  █ ${c.orange}█▄  █ ${c.red}█  █${c.reset}   ${c.bold}${c.blue}█  █ ${c.green}█ ${c.blue}██▀▀▄ ${c.green}██▀▀▀ ${c.blue}██▀▀▀${c.reset}`,
    `${c.bold}${c.red} █▀▀   ${c.orange}█  █ ${c.red}█ █ █ ${c.orange}█ █ █ ${c.red} ▀▀█${c.reset}   ${c.bold}${c.blue}▀▄▄▀ ${c.green}█ ${c.blue}█▀▀▄  ${c.green}█▀▀   ${c.blue}▀▀▀█${c.reset}`,
    `${c.bold}${c.red} ▀    ${c.orange}▀▀▀▀ ${c.red}▀  ▀▀ ${c.orange}▀  ▀▀ ${c.red}  ▀${c.reset}    ${c.bold}${c.blue} ▀▀  ${c.green}▀ ${c.blue}▀▀▀   ${c.green}▀▀▀▀  ${c.blue}▀▀▀▀${c.reset}`,
  ]

  // Get backend availability from ModelRouterService
  const modelRouter = app.get(ModelRouterService)
  const ok = `${c.green}✓${c.reset}`
  const no = `${c.red}✗${c.reset}`

  const googleStatus = modelRouter.isGoogleAvailable ? ok : no
  const openaiCompatStatus = modelRouter.isOpenaiCompatAvailable ? ok : no
  const codexStatus = modelRouter.isCodexAvailable ? ok : no

  // Determine GPT routing target
  const responsesApiMode = (() => {
    const m = (process.env.OPENAI_COMPAT_USE_RESPONSES_API || "")
      .trim()
      .toLowerCase()
    if (["always", "true", "1"].includes(m)) return "always" as const
    if (["never", "false", "0"].includes(m)) return "never" as const
    return "auto" as const
  })()

  let gptRoute = `${c.red}NOT CONFIGURED${c.reset}`
  if (modelRouter.isOpenaiCompatAvailable) {
    const modeHint =
      responsesApiMode === "always"
        ? " (Responses API)"
        : responsesApiMode === "auto"
          ? " (Auto Fallback)"
          : ""
    gptRoute = `${c.green}OpenAI-Compat${c.reset}${c.dim}${modeHint}${c.reset}`
  } else if (modelRouter.isCodexAvailable) {
    gptRoute = `${c.green}Codex${c.reset}`
  }

  console.log(`
${logo.join("\n")}

${c.blue}╔${"═".repeat(W)}╗${c.reset}
${c.blue}║${c.reset}${pad("", Math.floor((W - 30) / 2))}${c.bold}${c.blue}⚡ Agent Vibes Proxy Server ⚡${c.reset}${pad("", Math.ceil((W - 30) / 2))}${c.blue}║${c.reset}
${sep}
${empty}
${line(`${c.green}▸${c.reset} Server    ${c.bold}${c.green}${serverUrl}${c.reset}`)}
${line(`${c.green}▸${c.reset} API Docs  ${c.bold}${c.green}${serverUrl}/docs${c.reset}`)}
${line(`${c.green}▸${c.reset} HTTP/2    ${c.bold}${c.white}${http2Status}${c.reset}`)}
${line(`${c.green}▸${c.reset} Mode      ${c.bold}${c.white}${isDebug ? "DEBUG (verbose + file log)" : "NORMAL (quiet)"}${c.reset}`)}
${empty}
${sep}
${line(`${c.yellow}${c.bold}Backends${c.reset}`)}
${line(`  ${googleStatus} Google Cloud Code    ${c.dim}(Gemini + Claude)${c.reset}`)}
${line(`  ${openaiCompatStatus} OpenAI-Compatible    ${c.dim}(GPT/O-series)${c.reset} ${responsesApiMode === "always" ? `${c.yellow}[Responses API]${c.reset}` : responsesApiMode === "never" ? `${c.dim}[Chat Completions]${c.reset}` : `${c.green}[Auto Fallback]${c.reset}`}`)}
${modelRouter.isCodexAvailable ? line(`  ${codexStatus} Codex (OpenAI)       ${c.dim}(GPT/O-series reverse proxy)${c.reset}`) : line(`  ${c.dim}· Codex (OpenAI)       (covered by OpenAI-Compat)${c.reset}`)}
${empty}
${sep}
${line(`${c.yellow}${c.bold}Model Routing${c.reset}`)}
${line(`  Gemini / Claude     ${c.dim}→${c.reset}  ${c.green}Google Cloud Code${c.reset}`)}
${line(`  GPT / O-series      ${c.dim}→${c.reset}  ${gptRoute}`)}
${empty}
${sep}
${line(`${c.orange}${c.bold}API Endpoints${c.reset}`)}
${line(`  ${c.purple}POST${c.reset} /v1/messages ${c.dim}·· Anthropic Messages API${c.reset}`)}
${line(`  ${c.purple}GET ${c.reset} /v1/models   ${c.dim}·· List available models${c.reset}`)}
${line(`  ${c.purple}POST${c.reset} /agent.v1.*  ${c.dim}·· Cursor gRPC endpoints${c.reset}`)}
${line(`  ${c.purple}GET ${c.reset} /health      ${c.dim}·· Health check${c.reset}`)}
${empty}
${c.blue}╚${"═".repeat(W)}╝${c.reset}
`)
}

bootstrap().catch((error: unknown) => {
  console.error("Failed to start server:", error)
  process.exit(1)
})
