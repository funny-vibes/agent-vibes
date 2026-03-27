/**
 * Context Module Exports
 *
 * Provides conversation history management, tokenization, and context truncation.
 */

// Types
export * from "./types"

// History services
export { ConversationTruncatorService } from "./conversation-truncator.service"
export { SummaryCacheService } from "./summary-cache.service"
export { SummaryGeneratorService } from "./summary-generator.service"
export { TokenCounterService } from "./token-counter.service"
export { ToolIntegrityService } from "./tool-integrity.service"
export { normalizeToolProtocolMessages } from "./tool-protocol-normalizer"
export type { ToolProtocolNormalizationResult } from "./tool-protocol-normalizer"
export { enforceToolProtocol, assertIntegrity } from "./message-integrity-guard"
export type {
  RepairResult,
  IntegrityViolation,
} from "./message-integrity-guard"

// Tokenizer service
export { TokenizerService } from "./tokenizer.service"

// Modules
export { HistoryModule } from "./history.module"
export { TokenizerModule } from "./tokenizer.module"
