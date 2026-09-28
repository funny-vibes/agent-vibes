/**
 * OpenAI Chat Completions / Completions wire types.
 *
 * These describe the *inbound* OpenAI-compatible protocol surface the
 * bridge exposes at `/v1/chat/completions` and `/v1/completions`. They are
 * deliberately permissive (extra fields allowed via index signatures) so
 * unknown client params don't break parsing — the translator only reads the
 * fields it understands and forwards the rest as no-ops.
 *
 * Reference: https://platform.openai.com/docs/api-reference/chat
 */

// ── Chat Completions: request ───────────────────────────────────────────

export interface OpenAiTextPart {
  type: "text"
  text: string
}

export interface OpenAiImagePart {
  type: "image_url"
  image_url: { url: string; detail?: string }
}

export type OpenAiContentPart = OpenAiTextPart | OpenAiImagePart

export interface OpenAiToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
  /** Present only inside streaming deltas. */
  index?: number
}

export interface OpenAiChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool"
  content?: string | OpenAiContentPart[] | null
  name?: string
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
}

export interface OpenAiFunctionTool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export type OpenAiToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } }

export interface OpenAiStreamOptions {
  include_usage?: boolean
}

export interface OpenAiChatCompletionRequest {
  model: string
  messages: OpenAiChatMessage[]
  tools?: OpenAiFunctionTool[]
  tool_choice?: OpenAiToolChoice
  stream?: boolean
  stream_options?: OpenAiStreamOptions
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  n?: number
  stop?: string | string[]
  reasoning_effort?: string
  service_tier?: string
  response_format?: { type: string; [key: string]: unknown }
  [key: string]: unknown
}

// ── Chat Completions: response ──────────────────────────────────────────

export interface OpenAiResponseMessage {
  role: "assistant"
  content: string | null
  reasoning_content?: string
  tool_calls?: OpenAiToolCall[]
}

export type OpenAiFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | null

export interface OpenAiChatChoice {
  index: number
  message: OpenAiResponseMessage
  finish_reason: OpenAiFinishReason
  logprobs: null
}

export interface OpenAiUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
}

export interface OpenAiChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: OpenAiChatChoice[]
  usage: OpenAiUsage
}

// ── Chat Completions: streaming chunk ───────────────────────────────────

export interface OpenAiChatDelta {
  role?: "assistant"
  content?: string | null
  reasoning_content?: string
  tool_calls?: OpenAiToolCall[]
}

export interface OpenAiChatChunkChoice {
  index: number
  delta: OpenAiChatDelta
  finish_reason: OpenAiFinishReason
  logprobs: null
}

export interface OpenAiChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: OpenAiChatChunkChoice[]
  usage?: OpenAiUsage | null
}

// ── Responses API ───────────────────────────────────────────────────────

export interface OpenAiResponseInputTextPart {
  type: "input_text" | "output_text"
  text: string
}

export interface OpenAiResponseInputImagePart {
  type: "input_image"
  image_url: string
  detail?: string
}

export type OpenAiResponseInputContentPart =
  | OpenAiResponseInputTextPart
  | OpenAiResponseInputImagePart

export interface OpenAiResponseInputMessage {
  type?: "message"
  role: "system" | "developer" | "user" | "assistant"
  content: string | OpenAiResponseInputContentPart[]
}

export interface OpenAiResponseFunctionCallInput {
  type: "function_call"
  id?: string
  call_id: string
  name: string
  arguments: string
}

export interface OpenAiResponseFunctionCallOutputInput {
  type: "function_call_output"
  call_id: string
  output: string
}

export type OpenAiResponseInputItem =
  | OpenAiResponseInputMessage
  | OpenAiResponseFunctionCallInput
  | OpenAiResponseFunctionCallOutputInput

export interface OpenAiResponseFunctionTool {
  type: "function"
  name: string
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean
}

export type OpenAiResponseToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; name: string }

export interface OpenAiResponsesRequest {
  model: string
  input: string | OpenAiResponseInputItem[]
  instructions?: string
  tools?: OpenAiResponseFunctionTool[]
  tool_choice?: OpenAiResponseToolChoice
  stream?: boolean
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  reasoning?: { effort?: string; summary?: string }
  service_tier?: string
  parallel_tool_calls?: boolean
  previous_response_id?: string | null
  store?: boolean
  metadata?: Record<string, string>
  [key: string]: unknown
}

export interface OpenAiResponseOutputText {
  type: "output_text"
  text: string
  annotations: Array<Record<string, unknown>>
  logprobs?: unknown[]
}

export interface OpenAiResponseMessageOutput {
  id: string
  type: "message"
  status: "in_progress" | "completed"
  role: "assistant"
  content: [OpenAiResponseOutputText]
}

export interface OpenAiResponseFunctionCallOutput {
  id: string
  type: "function_call"
  status: "in_progress" | "completed"
  call_id: string
  name: string
  arguments: string
}

export type OpenAiResponseOutputItem =
  | OpenAiResponseMessageOutput
  | OpenAiResponseFunctionCallOutput

export interface OpenAiResponsesUsage {
  input_tokens: number
  input_tokens_details: { cached_tokens: number }
  output_tokens: number
  output_tokens_details: { reasoning_tokens: number }
  total_tokens: number
}

export interface OpenAiResponsesResponse {
  id: string
  object: "response"
  created_at: number
  status: "in_progress" | "completed" | "incomplete"
  error: null
  incomplete_details: { reason: string } | null
  instructions: string | null
  max_output_tokens: number | null
  model: string
  output: OpenAiResponseOutputItem[]
  parallel_tool_calls: boolean
  previous_response_id: string | null
  reasoning: { effort?: string; summary?: string } | null
  store: boolean
  temperature: number | null
  tool_choice: OpenAiResponseToolChoice
  tools: OpenAiResponseFunctionTool[]
  top_p: number | null
  metadata: Record<string, string>
  usage: OpenAiResponsesUsage
}

// ── Legacy Completions (text) ───────────────────────────────────────────

export interface OpenAiCompletionRequest {
  model: string
  prompt: string | string[]
  stream?: boolean
  stream_options?: OpenAiStreamOptions
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string | string[]
  [key: string]: unknown
}

export interface OpenAiCompletionChoice {
  index: number
  text: string
  finish_reason: OpenAiFinishReason
  logprobs: null
}

export interface OpenAiCompletionResponse {
  id: string
  object: "text_completion"
  created: number
  model: string
  choices: OpenAiCompletionChoice[]
  usage: OpenAiUsage
}

export interface OpenAiCompletionChunk {
  id: string
  object: "text_completion"
  created: number
  model: string
  choices: Array<{
    index: number
    text: string
    finish_reason: OpenAiFinishReason
    logprobs: null
  }>
  usage?: OpenAiUsage | null
}

// ── Error envelope ──────────────────────────────────────────────────────

export interface OpenAiErrorEnvelope {
  error: {
    message: string
    type: string
    param: string | null
    code: string | null
  }
}
