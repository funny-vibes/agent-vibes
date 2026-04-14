import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator"

class MessageContentDto {
  @ApiProperty()
  @IsString()
  type: string

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  text?: string

  // Additional fields for tool_use and tool_result
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  id?: string

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  name?: string

  @ApiPropertyOptional()
  @IsOptional()
  input?: Record<string, unknown>

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  tool_use_id?: string

  // image block source (base64 data + media type)
  @ApiPropertyOptional()
  @IsOptional()
  source?: Record<string, unknown>

  // tool_result nested content (string or array of content blocks)
  @ApiPropertyOptional()
  @IsOptional()
  content?: string | Array<Record<string, unknown>>
}

class MessageDto {
  @ApiProperty({ enum: ["user", "assistant"] })
  @IsString()
  role: string

  // Content can be string or array of content blocks - use @IsOptional to allow any type
  @ApiProperty({ oneOf: [{ type: "string" }, { type: "array" }] })
  @IsOptional()
  content: string | MessageContentDto[]
}

class ToolDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  type?: string

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  name?: string

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string

  @ApiPropertyOptional()
  @IsOptional()
  input_schema?: Record<string, unknown>
}

/**
 * Anthropic API extended thinking configuration
 * Reference: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
 */
class ThinkingDto {
  @ApiProperty({ enum: ["enabled", "disabled", "adaptive", "auto"] })
  @IsString()
  type: string

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  budget_tokens?: number
}

class OutputConfigDto {
  @ApiPropertyOptional({ example: "medium" })
  @IsString()
  @IsOptional()
  effort?: string
}

export type ThinkingIntentEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

export type ThinkingIntent =
  | { mode: "disabled" }
  | { mode: "adaptive"; effort?: ThinkingIntentEffort }
  | { mode: "explicit_effort"; effort: ThinkingIntentEffort }
  | { mode: "explicit_budget"; budgetTokens: number }

export class CreateMessageDto {
  @ApiProperty({ example: "gemini-2.5-flash" })
  @IsString()
  model: string

  @ApiProperty({ type: [MessageDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MessageDto)
  messages: MessageDto[]

  @ApiPropertyOptional({ example: 4096 })
  @IsNumber()
  @IsOptional()
  max_tokens?: number

  @ApiPropertyOptional()
  @IsOptional()
  system?: string | MessageContentDto[]

  @ApiPropertyOptional({ type: [ToolDto] })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ToolDto)
  tools?: ToolDto[]

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  stream?: boolean

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  temperature?: number

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  top_p?: number

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  top_k?: number

  @ApiPropertyOptional({ description: "Extended thinking configuration" })
  @IsOptional()
  @ValidateNested()
  @Type(() => ThinkingDto)
  thinking?: ThinkingDto

  @ApiPropertyOptional({
    oneOf: [{ type: "string" }, { type: "object" }],
    description:
      "Claude tool choice. Supports string forms like auto/none/any or object form { type, name }.",
  })
  @IsOptional()
  tool_choice?: string | Record<string, unknown>

  @ApiPropertyOptional({
    type: [String],
    description:
      "Additional stop sequences to append to the default backend set.",
  })
  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  stop_sequences?: string[]

  @ApiPropertyOptional({
    type: OutputConfigDto,
    description:
      "Claude output config. Used for adaptive thinking effort alignment.",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => OutputConfigDto)
  output_config?: OutputConfigDto

  @ApiPropertyOptional({
    type: Object,
    description: "Opaque request metadata such as metadata.user_id.",
  })
  @IsOptional()
  metadata?: Record<string, unknown>

  @ApiPropertyOptional({
    oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }],
    description:
      "Optional Anthropic beta flags. Preserved for Claude compatibility even when the backend ignores them.",
  })
  @IsOptional()
  betas?: string[] | string

  @ApiPropertyOptional({
    description:
      "Optional Anthropic service tier hint. Accepted for compatibility and may be ignored by the backend.",
  })
  @IsString()
  @IsOptional()
  service_tier?: string

  /**
   * Internal conversation identifier (not part of Anthropic API).
   * Used to track per-conversation state in backends (e.g., Gemini requestId UUID).
   * Set by CursorConnectStreamService before routing to backends.
   */
  @IsOptional()
  @IsString()
  _conversationId?: string

  /**
   * Internal context token budget (not part of Anthropic API).
   * Computed by CursorConnectStreamService.resolveMessageBudget() and passed
   * to GoogleService.enforceTokenBudget() so both layers use a consistent
   * soft limit instead of the raw 200k hard cap.
   */
  @IsOptional()
  @IsNumber()
  _contextTokenBudget?: number

  /**
   * Internal list of live pending tool_use IDs.
   * Used to avoid rewriting in-flight tool calls into synthetic failures
   * during normalization and truncation.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  _pendingToolUseIds?: string[]

  /**
   * Internal count of leading context messages that must survive any
   * backend-side payload shrink pass.
   */
  @IsOptional()
  @IsNumber()
  _protectedContextMessageCount?: number

  /**
   * Internal backend-agnostic thinking intent.
   * Cursor-side thinking semantics are captured here first, then each backend
   * serializes them into its own wire format.
   */
  @IsOptional()
  _thinkingIntent?: ThinkingIntent

  /**
   * Internal original model identifier before backend routing canonicalizes it.
   * This keeps suffix-style thinking hints attached to the original request.
   */
  @IsOptional()
  @IsString()
  _requestedModel?: string
}
