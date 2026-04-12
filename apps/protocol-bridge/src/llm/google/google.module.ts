import { Module } from "@nestjs/common"
import { ContextModule } from "../../context/context.module"
import { UsageStatsModule } from "../../usage"
import { GoogleModelCacheService } from "./google-model-cache.service"
import { GoogleService } from "./google.service"
import { ProcessPoolService } from "./process-pool.service"
import { ToolThoughtSignatureService } from "./tool-thought-signature.service"

@Module({
  imports: [ContextModule, UsageStatsModule],
  providers: [
    GoogleModelCacheService,
    GoogleService,
    ProcessPoolService,
    ToolThoughtSignatureService,
  ],
  exports: [
    GoogleService,
    GoogleModelCacheService,
    ProcessPoolService,
    ToolThoughtSignatureService,
  ],
})
export class GoogleModule {}
