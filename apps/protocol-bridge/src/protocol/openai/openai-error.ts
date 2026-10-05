import { GptRequestError } from "../../llm/shared/gpt-api-contract"
import { CodexApiError } from "../../llm/openai/codex-api-error"
import { ChatGptWebError } from "../../llm/openai/chatgpt-web-conversation.service"
import { ChatGptWebSessionError } from "../../llm/openai/chatgpt-web-session"
/**
 * OpenAI-compatible error envelope mapper.
 *
 * The bridge's canonical error taxonomy is rendered by
 * `renderAnthropicError` (BackendErrorClass → status + spec-compliant
 * message). For the OpenAI inbound surface we reuse that classification so
 * status codes and prose stay identical to the Anthropic endpoint, then
 * reshape the envelope into OpenAI's `{ error: { message, type, param, code } }`
 * form and map the HTTP status to the matching OpenAI `error.type`.
 *
 * Reference: https://platform.openai.com/docs/guides/error-codes/api-errors
 */

import { renderAnthropicError } from "../anthropic/anthropic-error"
import type { OpenAiErrorEnvelope } from "./openai-types"

export interface OpenAiErrorRendering {
  status: number
  body: OpenAiErrorEnvelope
  retryAfterSeconds?: number
}

/**
 * Map an HTTP status code to the canonical OpenAI API `error.type`.
 */
export function openAiErrorTypeFromStatus(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request_error"
    case 401:
      return "authentication_error"
    case 403:
      return "permission_error"
    case 404:
      return "not_found_error"
    case 408:
    case 504:
      return "timeout_error"
    case 413:
      return "invalid_request_error"
    case 422:
      return "invalid_request_error"
    case 429:
      return "rate_limit_error"
    default:
      if (status >= 500) {
        return "api_error"
      }
      return "invalid_request_error"
  }
}

/**
 * Optional `error.code` for the statuses where OpenAI clients commonly
 * branch on the machine-readable code rather than the type.
 */
function openAiErrorCodeFromStatus(status: number): string | null {
  switch (status) {
    case 401:
      return "invalid_api_key"
    case 413:
      return "request_too_large"
    case 429:
      return "rate_limit_exceeded"
    default:
      return null
  }
}

/**
 * Render any error captured by the OpenAI controller layer into the
 * canonical OpenAI envelope shape. Used by both the non-streaming JSON
 * response and the SSE error writer so they stay in sync.
 */
export function renderOpenAiError(error: unknown): OpenAiErrorRendering {
  // The ChatGPT Web backend carries its own diagnosis — which model list it
  // checked, that upstream ignores `tools`, that every account is cooling
  // down. The generic taxonomy would flatten those into "request shape is
  // invalid", so pass the original message and code straight through.
  if (
    error instanceof GptRequestError ||
    error instanceof ChatGptWebError ||
    error instanceof ChatGptWebSessionError
  ) {
    return {
      status: error.statusCode,
      body: {
        error: {
          message: error.message,
          type: openAiErrorTypeFromStatus(error.statusCode),
          param: error instanceof GptRequestError ? error.param : null,
          code: error.code,
        },
      },
    }
  }

  const anthropic = renderAnthropicError(error)
  const status = anthropic.status
  return {
    status,
    body: {
      error: {
        message: anthropic.body.error.message,
        type: openAiErrorTypeFromStatus(status),
        param: null,
        code:
          error instanceof CodexApiError
            ? (error.providerCode ?? openAiErrorCodeFromStatus(status))
            : openAiErrorCodeFromStatus(status),
      },
    },
    retryAfterSeconds: anthropic.retryAfterSeconds,
  }
}
