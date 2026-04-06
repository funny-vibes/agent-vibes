import { Module } from "@nestjs/common"
import { UsageStatsModule } from "../../usage/usage-stats.module"
import { ProcessPoolService } from "./process-pool.service"

@Module({
  imports: [UsageStatsModule],
  providers: [ProcessPoolService],
  exports: [ProcessPoolService],
})
export class NativeModule {}
