/**
 * Cloud Code API Type Definitions
 *
 * Complete TypeScript interfaces for Google Cloud Code (Antigravity) API
 * request and response payloads. Replaces scattered `Record<string, unknown>`
 * casts throughout the codebase.
 */

// ---------------------------------------------------------------------------
// Request Types
// ---------------------------------------------------------------------------

/** A single part within a Cloud Code content message */
export interface CloudCodePart {
  /** Plain text content */
  text?: string
  /** Whether this part is a thinking/reasoning step */
  thought?: boolean
  /** Thought signature for cross-turn signature propagation */
  thoughtSignature?: string
  /** Function call request from the model */
  functionCall?: CloudCodeFunctionCall
  /** Function response from the user/tool */
  functionResponse?: CloudCodeFunctionResponse
  /** Inline binary data (e.g. images) */
  inlineData?: CloudCodeInlineData
}

/** Function call emitted by the model */
export interface CloudCodeFunctionCall {
  name: string
  args: Record<string, unknown>
  id?: string
}

/** Function response provided by the user */
export interface CloudCodeFunctionResponse {
  name: string
  response: CloudCodeFunctionResponseBody
  id?: string
}

/** Body of a function response */
export interface CloudCodeFunctionResponseBody {
  output?: string
  result?: string
  is_error?: boolean
  content?: unknown[]
}

/** Inline binary data (base64-encoded) */
export interface CloudCodeInlineData {
  mimeType: string
  data: string
}

/** A content message (user or model turn) */
export interface CloudCodeContent {
  role: "user" | "model"
  parts: CloudCodePart[]
}

/** System instruction block */
export interface CloudCodeSystemInstruction {
  role: "user"
  parts: Array<{ text: string }>
}

/** Generation configuration */
export interface CloudCodeGenerationConfig {
  temperature: number
  topP: number
  topK: number
  candidateCount: number
  maxOutputTokens: number
  stopSequences: string[]
  thinkingConfig?: CloudCodeThinkingConfig
}

/** Thinking/reasoning configuration */
export interface CloudCodeThinkingConfig {
  includeThoughts: boolean
  /** Official Cloud Code wire shape uses a model-specific thinking budget. */
  thinkingBudget?: number
}

/** Safety setting entry */
export interface CloudCodeSafetySetting {
  category: string
  threshold: string
}

/** Tool declaration wrapper (each tool in its own group) */
export interface CloudCodeToolDeclaration {
  functionDeclarations: CloudCodeFunctionDeclarationEntry[]
}

/** A single function declaration */
export interface CloudCodeFunctionDeclarationEntry {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Google Search tool configuration */
export interface CloudCodeGoogleSearchTool {
  googleSearch: {
    enhancedContent?: {
      imageSearch?: {
        maxResultCount: number
      }
    }
  }
}

/** Tool calling configuration */
export interface CloudCodeToolConfig {
  functionCallingConfig: {
    mode: "VALIDATED" | "AUTO" | "NONE"
    allowedFunctionNames?: string[]
  }
}

/** The inner request object within a Cloud Code payload */
export interface CloudCodeInnerRequest {
  contents: CloudCodeContent[]
  generationConfig: CloudCodeGenerationConfig
  systemInstruction?: CloudCodeSystemInstruction
  tools?: Array<CloudCodeToolDeclaration | CloudCodeGoogleSearchTool>
  toolConfig?: CloudCodeToolConfig
  safetySettings?: CloudCodeSafetySetting[]
}

/** Top-level Cloud Code API request payload */
export interface CloudCodeRequestPayload {
  project: string
  model: string
  request: CloudCodeInnerRequest
  userAgent: string
  requestType: "agent" | "web_search"
  requestId: string
}

// ---------------------------------------------------------------------------
// Response Types
// ---------------------------------------------------------------------------

/** A response part from the model */
export interface CloudCodeResponsePart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: CloudCodeFunctionCall
}

/** Content within a response candidate */
export interface CloudCodeResponseContent {
  parts?: CloudCodeResponsePart[]
}

/** Grounding chunk from web search */
export interface CloudCodeGroundingChunk {
  web?: {
    uri?: string
    url?: string
    title?: string
    displayName?: string
    snippet?: string
    chunk?: string
  }
}

/** Grounding metadata from web search */
export interface CloudCodeGroundingMetadata {
  groundingChunks?: CloudCodeGroundingChunk[]
}

/** A response candidate */
export interface CloudCodeCandidate {
  content?: CloudCodeResponseContent
  finishReason?: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER"
  groundingMetadata?: CloudCodeGroundingMetadata
}

/** Usage metadata in response */
export interface CloudCodeUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

/** Cloud Code API response (inner, after unwrapping) */
export interface CloudCodeResponseData {
  candidates?: CloudCodeCandidate[]
  usageMetadata?: CloudCodeUsageMetadata
  responseId?: string
}

/** Cloud Code API response (outer wrapper) */
export interface CloudCodeResponse {
  response?: CloudCodeResponseData
  candidates?: CloudCodeCandidate[]
  usageMetadata?: CloudCodeUsageMetadata
  responseId?: string
}

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

/** Cloud Code error detail entry */
export interface CloudCodeErrorDetail {
  "@type"?: string
  retryDelay?: string
  metadata?: {
    quotaResetDelay?: string
  }
}

/** Cloud Code error response body */
export interface CloudCodeErrorResponse {
  error?: {
    message?: string
    status?: string
    code?: number
    details?: CloudCodeErrorDetail[]
  }
}

/** Nested Anthropic-style error within Cloud Code error message */
export interface CloudCodeNestedAnthropicError {
  type?: string
  error?: {
    type?: string
    message?: string
  }
  request_id?: string
}

// ---------------------------------------------------------------------------
// Web Search Types
// ---------------------------------------------------------------------------

/** Web search reference extracted from grounding metadata */
export interface WebSearchReference {
  title: string
  url: string
  chunk: string
}

// ---------------------------------------------------------------------------
// Prompt Shrink Types
// ---------------------------------------------------------------------------

/** Result of parsing a prompt-too-long error */
export interface PromptTooLongInfo {
  actual: number
  max: number
}

/** Result of shrinking payload contents */
export interface ShrinkResult {
  dropped: number
  remaining: number
  removedFunctionResponses: number
}
