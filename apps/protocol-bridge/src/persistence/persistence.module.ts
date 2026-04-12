import { Global, Module } from "@nestjs/common"
import { PersistenceService } from "./persistence.service"

/**
 * Global persistence module — provides the shared SQLite-backed PersistenceService
 * to all modules without explicit imports.
 */
@Global()
@Module({
  providers: [PersistenceService],
  exports: [PersistenceService],
})
export class PersistenceModule {}
