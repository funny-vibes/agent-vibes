import { Injectable, type ExecutionContext } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { RequiredApiKeyGuard } from "./required-api-key.guard"

/** An explicit Web provider has the same auth boundary as /v1/web-gpt/*. */
@Injectable()
export class ExplicitWebProviderGuard extends RequiredApiKeyGuard {
  constructor(config: ConfigService) {
    super(config)
  }
  override canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ body?: { provider?: unknown } }>()
    return request.body?.provider === "chatgpt-web"
      ? super.canActivate(context)
      : true
  }
}
