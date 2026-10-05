import * as crypto from "node:crypto"
import type { ChatGptWebEvent } from "./chatgpt-web-conversation.service"
import type { McpToolResult } from "../../protocol/mcp/mcp-types"

/**
 * One ChatGPT turn, served to Cursor as several provider turns.
 *
 * The two protocols disagree about how long a turn lasts. ChatGPT keeps a
 * single response open across every tool call it makes. Cursor's assistant
 * turn ends *at* the tool call: the IDE runs the tool and comes back with a
 * fresh provider request carrying the result. So one ChatGPT turn has to be
 * handed out in segments, one per Cursor request, with the response stream
 * still open in between.
 *
 * The tool call itself does not arrive on the response stream — ChatGPT calls
 * the MCP connector, which reaches the bridge over HTTP. `dispatchTool` is
 * that entry point: it emits a `tool_use` into the segment Cursor is currently
 * reading, ends the segment, and blocks until the IDE's result arrives through
 * `submitToolResult`. That blocking is what lets the MCP request answer
 * synchronously, and the bidi input pump is built to allow it — terminal
 * frames are routed independently of continuations for exactly this reason.
 *
 * Segments are Anthropic SSE strings, the contract every other backend already
 * meets, so nothing downstream of the provider stream changes.
 */

const IDLE_SEGMENT_END_MS = 250

export interface ChatGptWebTurnSessionOptions {
  /**
   * One ChatGPT turn, already decoded.
   *
   * Only text and the end of the turn are read from here. A tool call does not
   * arrive on this stream at all — it reaches the bridge as an MCP request
   * from the connector, which is why the raw frames are not needed.
   */
  readonly source: AsyncIterable<ChatGptWebEvent>
  /** Bounds how long a tool call may wait for the editor. */
  readonly toolTimeoutMs?: number
}

interface PendingTool {
  readonly toolCallId: string
  resolve: (result: McpToolResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type Segment =
  | { readonly kind: "text"; readonly delta: string }
  | {
      readonly kind: "tool"
      readonly toolCallId: string
      readonly name: string
      readonly input: Record<string, unknown>
    }
  | { readonly kind: "end" }

export class ChatGptWebTurnSession {
  private readonly toolTimeoutMs: number
  private readonly source: AsyncIterable<ChatGptWebEvent>
  private readonly queue: Segment[] = []
  private readonly pending = new Map<string, PendingTool>()
  private wake: (() => void) | null = null
  private reading = false
  private sourceDone = false
  /**
   * Set when the turn's end has been handed out, which is not the same as the
   * source iterator finishing: a segment can consume the end marker before the
   * reader's cleanup runs, and a caller asking `finished` in between would be
   * told the turn is still live.
   */
  private ended = false
  /** The end marker is queued once, whoever notices the end first. */
  private endQueued = false
  private failure: Error | null = null

  constructor(options: ChatGptWebTurnSessionOptions) {
    this.source = options.source
    this.toolTimeoutMs = options.toolTimeoutMs ?? 300_000
  }

  /** True once the turn ended and nothing is left to hand out. */
  get finished(): boolean {
    return (
      (this.ended || this.sourceDone) &&
      this.queue.length === 0 &&
      this.pending.size === 0
    )
  }

  /**
   * ChatGPT asked for a Cursor tool.
   *
   * Queues it for the segment Cursor is reading and waits for the editor. The
   * caller is an MCP request, so this promise is what keeps that HTTP request
   * open until there is a real answer to give.
   */
  dispatchTool(
    name: string,
    input: Record<string, unknown>,
    onDispatched?: (toolCallId: string) => void
  ): Promise<McpToolResult> {
    const toolCallId = `toolu_${crypto.randomBytes(12).toString("hex")}`
    onDispatched?.(toolCallId)
    return new Promise<McpToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolCallId)
        reject(
          new Error(
            `The editor did not return a result for ${name} within ${this.toolTimeoutMs}ms`
          )
        )
      }, this.toolTimeoutMs)
      this.pending.set(toolCallId, { toolCallId, resolve, reject, timer })
      this.push({ kind: "tool", toolCallId, name, input })
    })
  }

  /** The editor answered; release the MCP request that was waiting. */
  submitToolResult(toolCallId: string, result: McpToolResult): boolean {
    const waiter = this.pending.get(toolCallId)
    if (!waiter) return false
    this.pending.delete(toolCallId)
    clearTimeout(waiter.timer)
    waiter.resolve(result)
    return true
  }

  /** Fail every waiter, so an abandoned turn cannot strand an MCP request. */
  abort(reason: string): void {
    this.failure ??= new Error(reason)
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(reason))
    }
    this.pending.clear()
    this.wake?.()
  }

  /**
   * Anthropic SSE for one Cursor provider request.
   *
   * Ends after a tool call, because that is where Cursor's turn ends; the next
   * call continues the same ChatGPT turn.
   */
  async *segment(): AsyncGenerator<string, void, unknown> {
    this.startReading()
    const messageId = `msg_${crypto.randomBytes(12).toString("hex")}`
    yield frame("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: "chatgpt-web",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })

    let blockIndex = 0
    let textOpen = false
    let stopReason = "end_turn"

    for (;;) {
      const next = await this.take()
      if (!next) break

      if (next.kind === "text") {
        if (!textOpen) {
          yield frame("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "text", text: "" },
          })
          textOpen = true
        }
        yield frame("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text: next.delta },
        })
        continue
      }

      if (textOpen) {
        yield frame("content_block_stop", {
          type: "content_block_stop",
          index: blockIndex,
        })
        textOpen = false
        blockIndex += 1
      }

      if (next.kind === "tool") {
        yield frame("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: {
            type: "tool_use",
            id: next.toolCallId,
            name: next.name,
            input: {},
          },
        })
        yield frame("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(next.input),
          },
        })
        yield frame("content_block_stop", {
          type: "content_block_stop",
          index: blockIndex,
        })
        stopReason = "tool_use"
        break
      }
      break // "end"
    }

    if (textOpen) {
      yield frame("content_block_stop", {
        type: "content_block_stop",
        index: blockIndex,
      })
    }
    yield frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 0 },
    })
    yield frame("message_stop", { type: "message_stop" })
  }

  // ── upstream turn ─────────────────────────────────────────────────────

  /** Drain the turn once, in the background, into the queue. */
  private startReading(): void {
    if (this.reading) return
    this.reading = true
    void (async () => {
      try {
        for await (const event of this.source) {
          if (event.kind === "text")
            this.push({ kind: "text", delta: event.delta })
          else if (event.kind === "done") this.queueEnd()
        }
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error))
      } finally {
        this.sourceDone = true
        // The decoder usually saw [DONE] first; queueing a second end would
        // leave one behind and make the turn look unfinished forever.
        this.queueEnd()
      }
    })()
  }

  private queueEnd(): void {
    if (this.endQueued) return
    this.endQueued = true
    this.push({ kind: "end" })
  }

  private push(segment: Segment): void {
    this.queue.push(segment)
    this.wake?.()
  }

  /** Next segment item, or null when this Cursor turn should end. */
  private async take(): Promise<Segment | null> {
    for (;;) {
      if (this.failure) throw this.failure
      const next = this.queue.shift()
      if (next) {
        if (next.kind !== "end") return next
        this.ended = true
        return null
      }
      if (this.sourceDone) {
        this.ended = true
        return null
      }
      // Wait for the next push, with a short timer in case one raced the
      // assignment below.
      //
      // Both halves have to belong to *this* iteration. An earlier version let
      // a timer from a previous one fire late, find whatever `wake` was
      // current, and clear it — leaving the promise it belonged to with no way
      // to be resolved: no wake to call, and its own timer already spent
      // looking at someone else's. The reader stopped there with segments
      // still queued, which is a turn that never ends.
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (this.wake === wake) this.wake = null
          resolve()
        }
        const wake = (): void => finish()
        const timer = setTimeout(finish, IDLE_SEGMENT_END_MS)
        this.wake = wake
      })
    }
  }
}

/** One Anthropic SSE frame, in the wire shape the projector parses. */
function frame(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}
