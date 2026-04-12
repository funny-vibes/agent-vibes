import { Module } from "@nestjs/common"
import { AnthropicApiModule } from "../../llm/anthropic/anthropic-api.module"
import { ContextModule } from "../../context/context.module"
import { CodexModule } from "../../llm/openai/codex.module"
import { GoogleModule } from "../../llm/google/google.module"
import { ModelModule } from "../../llm/shared/model.module"
import { OpenaiCompatModule } from "../../llm/openai/openai-compat.module"
import { MessagesController } from "./messages.controller"
import { MessagesService } from "./messages.service"
import { TokenizerService } from "./tokenizer.service"

@Module({
  imports: [
    AnthropicApiModule,
    CodexModule,
    GoogleModule,
    ContextModule,
    ModelModule,
    OpenaiCompatModule,
  ],
  controllers: [MessagesController],
  providers: [MessagesService, TokenizerService],
  exports: [
    AnthropicApiModule,
    CodexModule,
    GoogleModule,
    MessagesService,
    OpenaiCompatModule,
  ],
})
export class AnthropicModule {}
