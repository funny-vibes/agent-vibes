/**
 * Bridges sub-agent ExecServerMessage tool calls onto the existing
 * parent BiDi stream and back.
 *
 * Architecture:
 *   - When a sub-agent's LLM emits a tool call that requires an
 *     ExecServerMessage round-trip (run_terminal_command, read_file,
 *     list_directory, grep_search, edit_file_v2, delete_file, ...), the
 *     sub-agent worker registers a promise here keyed by toolCallId,
 *     yields the ExecServerMessage on the BiDi stream the parent owns,
 *     and `await`s the resolver.
 *   - When the IDE replies with the matching ExecClientMessage, the
 *     top-level handleToolResult() router checks the pending tool call's
 *     `subagentOwner` flag. If set, it forwards the raw resultData here
 *     (instead of feeding it into the parent's tool-result continuation
 *     pipeline) and `resolve(...)` fires, unblocking the sub-agent
 *     worker.
 *   - On abort / proto error / orphan cleanup, `rejectAll()` walks the
 *     pending map and rejects every outstanding waiter so no sub-agent
 *     turn is permanently stuck.
 *
 * The bridge keeps no per-conversation state beyond the toolCallId →
 * waiter map; conversation-level state lives in
 * `ChatSession.subAgentContexts` (one entry per concurrent sub-agent,
 * keyed by subagentId).
 */

import { fromBinary } from "@bufbuild/protobuf"
import { Injectable, Logger } from "@nestjs/common"
import { ExecClientMessageSchema, ShellStream } from "../../../gen/agent/v1_pb"

/**
 * Result delivered to a sub-agent waiter.
 *
 * Two shapes share the same envelope:
 *
 *   1. `single` — terminal ExecClientMessage cases that arrive as a
 *      single message: read_result / grep_result / ls_result /
 *      shell_result / write_result / delete_result / mcp_result /
 *      diagnostics_result / fetch_result / etc. `resultData` is the
 *      raw ExecClientMessage payload, `resultCase` is its oneof case.
 *
 *   2. `streamed_shell` — Cursor's shellStreamArgs path: the IDE emits
 *      multiple shellStream chunks (start, stdout/stderr deltas, exit)
 *      followed by no shellResult. The bridge buffers chunks until the
 *      `exit` chunk arrives, synthesises a shell-result-shaped payload
 *      (status + exit code + accumulated stdout/stderr), and delivers
 *      it to the waiter as a single result. From the waiter's
 *      perspective this looks identical to a synchronous shellResult,
 *      so callers do not need a separate decode path.
 */
export interface SubagentExecResult {
  /** Raw ExecClientMessage protobuf bytes the IDE returned (for case
   * `single`), or undefined when this is a synthesised streamed shell
   * result (case `streamed_shell`). */
  resultData?: Buffer
  /** ExecClientMessage oneof case for `single`, or "shellResult" for
   * `streamed_shell` so downstream formatting code keeps working
   * uniformly. */
  resultCase: string
  /** Populated only for streamed_shell. Concatenated stdout. */
  streamedStdout?: string
  /** Populated only for streamed_shell. Concatenated stderr. */
  streamedStderr?: string
  /** Populated only for streamed_shell. Process exit code (0 = success). */
  streamedExitCode?: number
  /** Populated only for streamed_shell. Coarse status to mirror the
   * shellResult result oneof so formatSubAgentExecResultAsText can
   * render uniformly. */
  streamedStatus?:
    | "success"
    | "failure"
    | "rejected"
    | "permission_denied"
    | "spawn_error"
    | "timeout"
}

interface SubagentExecWaiter {
  conversationId: string
  subagentId: string
  resolve: (result: SubagentExecResult) => void
  reject: (reason: Error) => void
  timeoutHandle?: NodeJS.Timeout
  /** Buffered stdout chunks accumulated while the IDE streams a
   * shellStream sequence; flushed into resolve() when the terminal
   * `exit` event arrives. */
  shellStdout: string[]
  /** Buffered stderr chunks; flushed alongside shellStdout. */
  shellStderr: string[]
  /** Whether the IDE has ever sent a shellStream chunk for this
   * waiter. Used to distinguish "single shellResult" arrival from the
   * streamed case if both were possible — they aren't on the same
   * exec_id, but the flag keeps the dispatch unambiguous. */
  shellStreamStarted: boolean
}

@Injectable()
export class SubagentExecBridgeService {
  private readonly logger = new Logger(SubagentExecBridgeService.name)
  private readonly waiters = new Map<string, SubagentExecWaiter>()

  private clearTimeout(waiter: SubagentExecWaiter): void {
    if (!waiter.timeoutHandle) return
    clearTimeout(waiter.timeoutHandle)
    waiter.timeoutHandle = undefined
  }

  /**
   * Register a waiter for an ExecClientMessage that the sub-agent worker
   * is about to wait on. Returns a promise that resolves when
   * `deliverResult(toolCallId, ...)` is called by handleToolResult, or
   * rejects when the conversation aborts before the result arrives.
   */
  awaitResult(
    conversationId: string,
    subagentId: string,
    toolCallId: string,
    options?: {
      timeoutMs?: number
      timeoutMessage?: string
    }
  ): Promise<SubagentExecResult> {
    if (this.waiters.has(toolCallId)) {
      // Should never happen — toolCallId is generated by the model and
      // collision-resistant — but throw rather than silently overwriting
      // so a bug surfaces loudly.
      const previous = this.waiters.get(toolCallId)!
      this.clearTimeout(previous)
      previous.reject(
        new Error(
          `Sub-agent exec waiter for toolCallId=${toolCallId} replaced by ` +
            `a new registration; original waiter rejected`
        )
      )
      this.waiters.delete(toolCallId)
    }
    return new Promise<SubagentExecResult>((resolve, reject) => {
      const waiter: SubagentExecWaiter = {
        conversationId,
        subagentId,
        resolve,
        reject,
        shellStdout: [],
        shellStderr: [],
        shellStreamStarted: false,
      }
      this.waiters.set(toolCallId, waiter)
      const timeoutMs = options?.timeoutMs
      if (typeof timeoutMs === "number" && timeoutMs > 0) {
        waiter.timeoutHandle = setTimeout(() => {
          const current = this.waiters.get(toolCallId)
          if (!current) return
          this.waiters.delete(toolCallId)
          current.timeoutHandle = undefined
          current.reject(
            new Error(
              options?.timeoutMessage ||
                `Timed out waiting for sub-agent exec result ` +
                  `toolCallId=${toolCallId}`
            )
          )
        }, timeoutMs)
      }
    })
  }

  /**
   * Forward a TERMINAL ExecClientMessage payload to the sub-agent
   * waiter that registered for `toolCallId`.
   *
   * "Terminal" = a single-message result case: read_result /
   * grep_result / ls_result / shell_result / write_result /
   * delete_result / mcp_result / diagnostics_result / fetch_result /
   * etc. shellStream chunks are NOT terminal and must instead be fed
   * through `deliverShellStreamChunk`.
   *
   * Returns true when a waiter was found (caller can short-circuit the
   * parent's result-handling pipeline); false otherwise.
   */
  deliverResult(toolCallId: string, result: SubagentExecResult): boolean {
    const waiter = this.waiters.get(toolCallId)
    if (!waiter) return false
    this.waiters.delete(toolCallId)
    this.clearTimeout(waiter)
    try {
      waiter.resolve(result)
    } catch (error) {
      this.logger.warn(
        `Sub-agent exec waiter resolve threw for toolCallId=${toolCallId} ` +
          `(subagent=${waiter.subagentId}): ${String(error)}`
      )
    }
    return true
  }

  /**
   * Feed a streamed shellStream chunk into the waiter's buffer. The
   * waiter is only RESOLVED when the chunk's event case is `exit` /
   * `rejected` / `permissionDenied`; intermediate `start` / `stdout` /
   * `stderr` chunks are accumulated and the promise stays pending.
   *
   * Returns:
   *   - true when the waiter was found and the chunk was processed
   *     (caller short-circuits the parent's pipeline regardless of
   *     whether the chunk was terminal or intermediate);
   *   - false when no waiter exists for `toolCallId` (caller may treat
   *     this as a stale chunk and ignore).
   *
   * Why not just decode the ExecClientMessage in handleToolResult and
   * pass the decoded ShellStream here? Two reasons:
   *
   *   - Symmetric encoding boundary. The single-result path
   *     (`deliverResult`) hands raw bytes; keeping the streamed path
   *     hand raw bytes too means the caller needs only one branch
   *     (`if (resultCase === "shellStream") { ... }`) and never needs
   *     a second proto decode in the hot path.
   *
   *   - Future cases. Other ExecClientMessage cases may also become
   *     streaming (e.g. progressive read of huge files). Doing decode
   *     here keeps the per-case state machine local to the bridge.
   */
  deliverShellStreamChunk(toolCallId: string, resultData: Buffer): boolean {
    const waiter = this.waiters.get(toolCallId)
    if (!waiter) return false

    let stream: ShellStream
    try {
      const execMsg = fromBinary(ExecClientMessageSchema, resultData)
      if (execMsg.message.case !== "shellStream") {
        this.logger.warn(
          `deliverShellStreamChunk got non-shellStream payload for ` +
            `toolCallId=${toolCallId} (case=${
              execMsg.message.case || "(empty)"
            }); ignoring`
        )
        return true
      }
      stream = execMsg.message.value
    } catch (error) {
      this.logger.error(
        `deliverShellStreamChunk failed to decode payload for ` +
          `toolCallId=${toolCallId}: ${String(error)}`
      )
      return true
    }

    waiter.shellStreamStarted = true

    const event = stream.event
    switch (event.case) {
      case "start":
        // No payload to accumulate. Just remember the stream began.
        return true

      case "stdout":
        // ShellStream stdout chunk schema. Append text; ignore empty.
        if (event.value.data) {
          waiter.shellStdout.push(event.value.data)
        }
        return true

      case "stderr":
        if (event.value.data) {
          waiter.shellStderr.push(event.value.data)
        }
        return true

      case "exit": {
        // Terminal — synthesise the result and resolve.
        const code = event.value.code ?? 0
        this.waiters.delete(toolCallId)
        this.clearTimeout(waiter)
        try {
          waiter.resolve({
            resultCase: "shellResult",
            streamedStdout: waiter.shellStdout.join(""),
            streamedStderr: waiter.shellStderr.join(""),
            streamedExitCode: code,
            streamedStatus: code === 0 ? "success" : "failure",
          })
        } catch (error) {
          this.logger.warn(
            `Sub-agent exec waiter resolve (shellStream exit) threw for ` +
              `toolCallId=${toolCallId} (subagent=${waiter.subagentId}): ` +
              `${String(error)}`
          )
        }
        return true
      }

      case "rejected": {
        this.waiters.delete(toolCallId)
        this.clearTimeout(waiter)
        try {
          waiter.resolve({
            resultCase: "shellResult",
            streamedStdout: waiter.shellStdout.join(""),
            streamedStderr: waiter.shellStderr.join(""),
            streamedExitCode: -1,
            streamedStatus: "rejected",
          })
        } catch (error) {
          this.logger.warn(
            `Sub-agent exec waiter resolve (shellStream rejected) threw ` +
              `for toolCallId=${toolCallId} (subagent=${waiter.subagentId}): ` +
              `${String(error)}`
          )
        }
        return true
      }

      case "permissionDenied": {
        this.waiters.delete(toolCallId)
        this.clearTimeout(waiter)
        try {
          waiter.resolve({
            resultCase: "shellResult",
            streamedStdout: waiter.shellStdout.join(""),
            streamedStderr: waiter.shellStderr.join(""),
            streamedExitCode: -1,
            streamedStatus: "permission_denied",
          })
        } catch (error) {
          this.logger.warn(
            `Sub-agent exec waiter resolve (shellStream permissionDenied) ` +
              `threw for toolCallId=${toolCallId} ` +
              `(subagent=${waiter.subagentId}): ${String(error)}`
          )
        }
        return true
      }

      default:
        // Unknown event — log but treat as intermediate (don't resolve).
        this.logger.warn(
          `deliverShellStreamChunk: unknown event case ` +
            `"${event.case || "(empty)"}" for toolCallId=${toolCallId}; ` +
            `treating as intermediate`
        )
        return true
    }
  }

  /**
   * Reject every outstanding waiter for the given conversation. Called
   * when the BiDi stream aborts, the sub-agent is killed, or the parent
   * task tool gets a protocol error before its sub-agent finishes.
   */
  rejectConversation(conversationId: string, reason: string): void {
    for (const [toolCallId, waiter] of this.waiters) {
      if (waiter.conversationId !== conversationId) continue
      this.waiters.delete(toolCallId)
      this.clearTimeout(waiter)
      try {
        waiter.reject(new Error(reason))
      } catch (error) {
        this.logger.warn(
          `Sub-agent exec waiter reject threw for toolCallId=${toolCallId} ` +
            `(subagent=${waiter.subagentId}): ${String(error)}`
        )
      }
    }
  }

  /**
   * Reject a single outstanding waiter, identified by toolCallId.
   * Returns true when a waiter was found and rejected, false otherwise.
   *
   * Used by the BiDi recovery path
   * (`interruptPendingToolCallsForRecovery` in CursorConnectStreamService)
   * to surface a stream-closed abort to the sub-agent worker the moment
   * its pending tool call is cleared. Without this, the worker would
   * stay parked on `awaitResult()` forever, emitting heartbeats while
   * the IDE-side BiDi stream is already gone.
   */
  rejectToolCall(toolCallId: string, reason: Error): boolean {
    const waiter = this.waiters.get(toolCallId)
    if (!waiter) return false
    this.waiters.delete(toolCallId)
    this.clearTimeout(waiter)
    try {
      waiter.reject(reason)
    } catch (error) {
      this.logger.warn(
        `Sub-agent exec waiter reject threw for toolCallId=${toolCallId} ` +
          `(subagent=${waiter.subagentId}): ${String(error)}`
      )
    }
    return true
  }

  /** Whether the given toolCallId has an outstanding sub-agent waiter. */
  hasWaiter(toolCallId: string): boolean {
    return this.waiters.has(toolCallId)
  }

  /** Sub-agent id that owns the given toolCallId, or undefined when no
   * waiter exists. Used by handleToolResult for diagnostic logging. */
  getOwnerSubagentId(toolCallId: string): string | undefined {
    return this.waiters.get(toolCallId)?.subagentId
  }
}
