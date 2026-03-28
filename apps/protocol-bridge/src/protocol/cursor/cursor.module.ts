import { Module } from "@nestjs/common"
import { HistoryModule } from "../../context/history.module"
import { AnthropicModule } from "../anthropic/anthropic.module"
import { CodexModule } from "../../llm/codex/codex.module"
import { GoogleModule } from "../../llm/google/google.module"
import { ModelModule } from "../../llm/model.module"
import { OpenaiCompatModule } from "../../llm/openai-compat/openai-compat.module"
import { AiserverMockController } from "./aiserver-mock.controller"
import { AuthController } from "./auth.controller"
import { ChatSessionManager } from "./chat-session.service"
import { ClientSideToolV2ExecutorService } from "./client-side-tool-v2-executor.service"
import { CursorAdapterController } from "./cursor-adapter.controller"
import { CursorAuthService } from "./cursor-auth.service"
import { CursorConnectStreamService } from "./cursor-connect-stream.service"
import { CursorGrpcService } from "./cursor-grpc.service"
import { KvStorageService } from "./kv-storage.service"
import { SemanticSearchProviderService } from "./semantic-search-provider.service"
import { KnowledgeBaseService } from "./knowledge-base.service"

@Module({
  imports: [
    AnthropicModule,
    CodexModule,
    GoogleModule,
    HistoryModule,
    ModelModule,
    OpenaiCompatModule,
  ],
  controllers: [
    CursorAdapterController,
    AuthController,
    AiserverMockController,
  ],
  providers: [
    ChatSessionManager,
    ClientSideToolV2ExecutorService,
    CursorAuthService,
    CursorConnectStreamService,
    CursorGrpcService,
    KvStorageService,
    SemanticSearchProviderService,
    KnowledgeBaseService,
  ],
  exports: [CursorAuthService, CursorConnectStreamService],
})
export class CursorModule {}
