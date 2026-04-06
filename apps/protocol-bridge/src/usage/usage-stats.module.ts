import { Global, Module } from "@nestjs/common"
import { UsageStatsService } from "./usage-stats.service"

@Global()
@Module({
  providers: [UsageStatsService],
  exports: [UsageStatsService],
})
export class UsageStatsModule {}
