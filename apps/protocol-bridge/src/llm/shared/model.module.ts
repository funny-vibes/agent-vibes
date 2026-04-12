import { Module } from "@nestjs/common"
import { ModelRouterService } from "./model-router.service"

@Module({
  providers: [ModelRouterService],
  exports: [ModelRouterService],
})
export class ModelModule {}
