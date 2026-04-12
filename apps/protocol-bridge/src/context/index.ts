/**
 * Context Module Exports
 *
 * Provides conversation history management, projection, and compaction.
 */

// Types
export * from "./types"

// Context services
export { TokenCounterService } from "./token-counter.service"
export { ToolIntegrityService } from "./tool-integrity.service"
export { ToolResultCompactionService } from "./tool-result-compaction.service"
export { ContextAttachmentBuilderService } from "./context-attachment-builder.service"
export type {
  ContextAttachmentSnapshot,
  SessionTodoAttachmentLike,
} from "./context-attachment-builder.service"
export { ContextCompactionService } from "./context-compaction.service"
export type { ContextCompactionResult } from "./context-compaction.service"
export { ContextManagerService } from "./context-manager.service"
export { ContextProjectionService } from "./context-projection.service"
export { ContextSummaryService } from "./context-summary.service"
export { ContextUsageLedgerService } from "./context-usage-ledger.service"
export { normalizeToolProtocolMessages } from "./tool-protocol-normalizer"
export type { ToolProtocolNormalizationResult } from "./tool-protocol-normalizer"
export { enforceToolProtocol, assertIntegrity } from "./tool-protocol-integrity"
export type {
  RepairResult,
  IntegrityViolation,
} from "./tool-protocol-integrity"

// Modules
export { ContextModule } from "./context.module"
