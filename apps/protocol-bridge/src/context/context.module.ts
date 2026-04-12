import { Module } from "@nestjs/common"
import { TokenCounterService } from "./token-counter.service"
import { ToolIntegrityService } from "./tool-integrity.service"
import { ContextAttachmentBuilderService } from "./context-attachment-builder.service"
import { ContextCompactionService } from "./context-compaction.service"
import { ContextManagerService } from "./context-manager.service"
import { ContextProjectionService } from "./context-projection.service"
import { ContextSummaryService } from "./context-summary.service"
import { ToolResultCompactionService } from "./tool-result-compaction.service"
import { ContextUsageLedgerService } from "./context-usage-ledger.service"

/**
 * Context Module
 *
 * Provides unified context management for proxy request paths.
 *
 * Components:
 * - TokenCounterService: Accurate token counting (tiktoken)
 * - ToolIntegrityService: Tool use/result pair integrity
 * - ContextProjectionService: Read-time API view over transcript + compaction boundary
 * - ContextSummaryService: Structured compaction summary generation
 * - ContextCompactionService: Boundary-based compaction + final hard fit
 * - ContextManagerService: Single orchestration entry point for session and stateless requests
 *
 * Design:
 * - Maintain a canonical transcript or ephemeral transcript state
 * - Project backend-facing messages at send time
 * - Record compaction as first-class state instead of ad hoc truncation
 */
@Module({
  providers: [
    TokenCounterService,
    ToolIntegrityService,
    ToolResultCompactionService,
    ContextAttachmentBuilderService,
    ContextProjectionService,
    ContextSummaryService,
    ContextUsageLedgerService,
    ContextCompactionService,
    ContextManagerService,
  ],
  exports: [
    TokenCounterService,
    ToolIntegrityService,
    ToolResultCompactionService,
    ContextAttachmentBuilderService,
    ContextProjectionService,
    ContextSummaryService,
    ContextUsageLedgerService,
    ContextCompactionService,
    ContextManagerService,
  ],
})
export class ContextModule {}
