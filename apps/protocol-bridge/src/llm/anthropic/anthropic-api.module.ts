import { Module } from "@nestjs/common"
import { UsageStatsModule } from "../../usage"
import { AnthropicApiService } from "./anthropic-api.service"

@Module({
  imports: [UsageStatsModule],
  providers: [AnthropicApiService],
  exports: [AnthropicApiService],
})
export class AnthropicApiModule {}
