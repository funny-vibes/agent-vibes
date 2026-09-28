import { Module } from "@nestjs/common"
import { UsageStatsModule } from "../../usage"
import { McpModule } from "../../protocol/mcp/mcp.module"
import { CodexAuthService } from "./codex-auth.service"
import { CodexCacheService } from "./codex-cache.service"
import { CodexClientIdentityService } from "./codex-client-identity.service"
import { CodexWebSocketService } from "./codex-websocket.service"
import { CodexService } from "./codex.service"
import { ChatGptWebRealtimeService } from "./chatgpt-web-realtime.service"
import { CodexVoiceCallService } from "./codex-voice-call.service"
import { ChatGptWebVoiceTransport } from "./chatgpt-web-transport"
import { ChatGptWebSessionStore } from "./chatgpt-web-session"
import { ChatGptWebConversationService } from "./chatgpt-web-conversation.service"
import { ChatGptWebCursorBridge } from "./chatgpt-web-cursor-bridge.service"

@Module({
  imports: [UsageStatsModule, McpModule],
  providers: [
    CodexAuthService,
    CodexCacheService,
    CodexClientIdentityService,
    CodexWebSocketService,
    CodexService,
    ChatGptWebVoiceTransport,
    ChatGptWebRealtimeService,
    CodexVoiceCallService,
    ChatGptWebSessionStore,
    ChatGptWebConversationService,
    ChatGptWebCursorBridge,
  ],
  exports: [
    CodexAuthService,
    CodexCacheService,
    CodexClientIdentityService,
    CodexWebSocketService,
    CodexService,
    ChatGptWebRealtimeService,
    CodexVoiceCallService,
    ChatGptWebSessionStore,
    ChatGptWebConversationService,
    ChatGptWebCursorBridge,
  ],
})
export class CodexModule {}
