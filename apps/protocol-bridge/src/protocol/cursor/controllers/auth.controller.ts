import { Body, Controller, Get, Logger, Post } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { createHash, randomUUID } from "crypto"
import { AntigravityIdeSyncService } from "../antigravity-ide-sync.service"
import { CursorAuthService } from "../cursor-auth.service"

interface CursorGainRequest {
  token?: string
  [key: string]: unknown
}

interface CursorIdentity {
  id: string
  email: string
  membershipType: string
  subscriptionStatus: string
}

@Controller("api")
export class AuthController {
  private readonly logger = new Logger(AuthController.name)
  private readonly tokenSalt = randomUUID()

  constructor(
    private readonly configService: ConfigService,
    private readonly cursorAuthService: CursorAuthService,
    private readonly antigravityIdeSyncService: AntigravityIdeSyncService
  ) {}

  private getCursorIdentity(): CursorIdentity {
    const configuredId =
      this.configService.get<string>("CURSOR_AUTH_USER_ID") || ""
    const configuredEmail =
      this.configService.get<string>("CURSOR_AUTH_EMAIL") || ""
    const configuredMembership =
      this.configService.get<string>("CURSOR_AUTH_MEMBERSHIP") || ""

    const localAuth = this.cursorAuthService.getAuthTokens()
    const localUserId =
      localAuth.accessToken &&
      this.cursorAuthService.getUserIdFromToken(localAuth.accessToken)

    return {
      id: configuredId || localUserId || "protocol-bridge",
      email: configuredEmail || localAuth.email || "protocol-bridge@local",
      membershipType:
        configuredMembership || localAuth.membershipType || "ultra",
      subscriptionStatus: localAuth.subscriptionStatus || "active",
    }
  }

  private issueProxyToken(scope: "gain" | "gain-new", inputToken?: string) {
    const seed = `${scope}:${inputToken || ""}:${this.tokenSalt}`
    const digest = createHash("sha256").update(seed).digest("hex")
    return `proxy_${scope}_${digest.slice(0, 40)}`
  }

  @Get("users/whoami")
  whoami() {
    const identity = this.getCursorIdentity()
    return {
      id: identity.id,
      email: identity.email,
      plan: identity.membershipType,
      emailVerified: true,
      membershipType: identity.membershipType,
      subscription: {
        status: identity.subscriptionStatus,
        plan: identity.membershipType,
      },
      usage: {
        requests: 0,
        maxRequests: 999999,
      },
    }
  }

  @Post("cursor/gain")
  gain(@Body() body: CursorGainRequest) {
    const hasInputToken =
      typeof body.token === "string" && body.token.length > 0
    this.logger.log(`Cursor gain request received (hasToken=${hasInputToken})`)
    return {
      token: this.issueProxyToken(
        "gain",
        hasInputToken ? body.token : undefined
      ),
      valid: true,
      globalRateLimit: 999999,
      issuedAt: new Date().toISOString(),
    }
  }

  @Post("cursor/gain-new")
  gainNew(@Body() body: CursorGainRequest) {
    const hasInputToken =
      typeof body.token === "string" && body.token.length > 0
    this.logger.log(
      `Cursor gain-new request received (hasToken=${hasInputToken})`
    )
    return {
      token: this.issueProxyToken(
        "gain-new",
        hasInputToken ? body.token : undefined
      ),
      valid: true,
      issuedAt: new Date().toISOString(),
    }
  }

  // Cursor clients also check this endpoint in startup flow.
  @Get("auth/me")
  me() {
    return this.whoami()
  }

  @Post("antigravity/sync-ide")
  syncAntigravityIdeCredentials() {
    return {
      synced: true,
      ...this.antigravityIdeSyncService.syncCredentialsFromIde(),
    }
  }
}
