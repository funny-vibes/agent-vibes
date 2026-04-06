import { Module } from "@nestjs/common"
import { UsageStatsModule } from "../../usage/usage-stats.module"
import { ClaudeApiService } from "./claude-api.service"

@Module({
  imports: [UsageStatsModule],
  providers: [ClaudeApiService],
  exports: [ClaudeApiService],
})
export class ClaudeApiModule {}
