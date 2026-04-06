import { Module } from "@nestjs/common"
import { UsageStatsModule } from "../../usage/usage-stats.module"
import { OpenaiCompatService } from "./openai-compat.service"

@Module({
  imports: [UsageStatsModule],
  providers: [OpenaiCompatService],
  exports: [OpenaiCompatService],
})
export class OpenaiCompatModule {}
