import { Module } from "@nestjs/common"
import { ClaudeApiService } from "./claude-api.service"

@Module({
  providers: [ClaudeApiService],
  exports: [ClaudeApiService],
})
export class ClaudeApiModule {}
