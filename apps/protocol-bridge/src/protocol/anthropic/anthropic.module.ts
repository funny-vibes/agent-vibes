import { Module } from "@nestjs/common"
import { ClaudeApiModule } from "../../llm/claude-api/claude-api.module"
import { HistoryModule } from "../../context/history.module"
import { TokenizerModule } from "../../context/tokenizer.module"
import { CodexModule } from "../../llm/codex/codex.module"
import { GoogleModule } from "../../llm/google/google.module"
import { ModelModule } from "../../llm/model.module"
import { OpenaiCompatModule } from "../../llm/openai-compat/openai-compat.module"
import { MessagesController } from "./messages.controller"
import { MessagesService } from "./messages.service"

@Module({
  imports: [
    ClaudeApiModule,
    CodexModule,
    GoogleModule,
    HistoryModule,
    ModelModule,
    OpenaiCompatModule,
    TokenizerModule,
  ],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [
    ClaudeApiModule,
    CodexModule,
    GoogleModule,
    MessagesService,
    OpenaiCompatModule,
  ],
})
export class AnthropicModule {}
