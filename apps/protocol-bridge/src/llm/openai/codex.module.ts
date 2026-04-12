import { Module } from "@nestjs/common"
import { UsageStatsModule } from "../../usage"
import { CodexAuthService } from "./codex-auth.service"
import { CodexCacheService } from "./codex-cache.service"
import { CodexWebSocketService } from "./codex-websocket.service"
import { CodexService } from "./codex.service"

@Module({
  imports: [UsageStatsModule],
  providers: [
    CodexAuthService,
    CodexCacheService,
    CodexWebSocketService,
    CodexService,
  ],
  exports: [
    CodexAuthService,
    CodexCacheService,
    CodexWebSocketService,
    CodexService,
  ],
})
export class CodexModule {}
