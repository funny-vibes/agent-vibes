import { createHash, randomBytes } from "crypto"
import { v4 as uuidv4 } from "uuid"

/**
 * Generate blob ID using SHA-256 hash of the content
 * Returns base64-encoded hash (44 characters)
 */
export function generateBlobId(content: string | Buffer): string {
  const hash = createHash("sha256")
  hash.update(typeof content === "string" ? Buffer.from(content) : content)
  return hash.digest("base64")
}

/**
 * Generate trace ID (32 hex characters)
 * Format: lowercase hexadecimal string
 */
export function generateTraceId(): string {
  return randomBytes(16).toString("hex")
}

/**
 * Generate span ID (16 hex characters)
 * Format: lowercase hexadecimal string
 */
export function generateSpanId(): string {
  return randomBytes(8).toString("hex")
}

/**
 * Generate exec ID in UUID format
 * Format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 */
export function generateExecId(): string {
  return uuidv4()
}

/**
 * Generate tool call ID with 'tool_' prefix
 * Format: tool_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 */
export function generateToolCallId(): string {
  return `tool_${uuidv4()}`
}

/**
 * Create span context for distributed tracing
 */
export function createSpanContext(
  traceId?: string,
  _parentSpanId?: string
): {
  traceId: string
  spanId: string
  traceFlags: number
} {
  return {
    traceId: traceId || generateTraceId(),
    spanId: generateSpanId(),
    traceFlags: 0,
  }
}

/**
 * Estimate token count for text (simple approximation)
 * Uses rough estimate: 1 token ≈ 4 characters
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0
  // Simple approximation: ~4 chars per token
  return Math.ceil(text.length / 4)
}
