import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { McpCursorToolsProvider } from "../../protocol/mcp/mcp-cursor-tools.provider"
import type { McpToolResult } from "../../protocol/mcp/mcp-types"
import {
  ChatGptWebConversationService,
  type ChatGptWebEvent,
} from "./chatgpt-web-conversation.service"
import { webGptTarget } from "../shared/model-registry"
import { ChatGptWebError } from "./chatgpt-web-conversation.service"
import { ChatGptWebTurnSession } from "./chatgpt-web-turn-session"

/**
 * Runs a Cursor turn on ChatGPT Web.
 *
 * Holds the ChatGPT turn across the several provider requests Cursor makes for
 * one exchange, and owns the correspondence between them:
 *
 *   - The first request starts a ChatGPT turn and claims the MCP tool sink, so
 *     a tool call arriving from ChatGPT is routed to this conversation.
 *   - A tool call becomes a `tool_use` in the segment Cursor is reading; that
 *     segment ends, Cursor runs the tool, and comes back.
 *   - The next request hands Cursor's result to the waiting MCP call and
 *     returns the next segment of the same ChatGPT turn.
 *
 * Why a single sink rather than a lookup: the bridge serialises turns, so at
 * most one ChatGPT turn is ever in flight. There is
 * nothing to disambiguate — and an MCP request carries no Cursor identity to
 * disambiguate with, which is what made every attempt to key this by
 * conversation fail.
 */

const IDLE_SESSION_MS = 10 * 60 * 1_000

/**
 * The model that parks a Cursor turn as a tool host.
 *
 * A tool call can only run inside a live Cursor turn — the editor executes its
 * tools in the stream it opened, and nothing can push one in from outside. So
 * a conversation started in ChatGPT's own web UI, which has no Cursor turn
 * behind it, needs one held open on its behalf: pick this model, send
 * anything, and the turn parks with the sink attached, handing each incoming
 * call to the editor until it is stopped or goes idle.
 */
export const CHATGPT_WEB_TOOL_HOST_MODEL = "tool-host"

interface ActiveTurn {
  readonly conversationId: string
  readonly session: ChatGptWebTurnSession
  readonly detachSink: () => void
  /**
   * Cancels the ChatGPT turn, and only the ChatGPT turn.
   *
   * It has to be the turn's own, not the signal that came with whichever
   * provider request started it: that one is aborted the moment Cursor
   * finishes reading its segment, which — for a turn with a tool call in it —
   * is immediately. The response read would then stop before the editor had
   * even answered.
   */
  readonly abort: AbortController
  touchedAt: number
}

/**
 * How long a Cursor conversation keeps its ChatGPT thread.
 *
 * Long enough that coming back to a chat after lunch continues where it left
 * off, rather than starting a thread that repeats everything.
 */
const THREAD_MEMORY_MS = 24 * 60 * 60 * 1_000

@Injectable()
export class ChatGptWebCursorBridge {
  private readonly logger = new Logger(ChatGptWebCursorBridge.name)
  private active: ActiveTurn | null = null
  /**
   * Each Cursor conversation owns a separate temporary ChatGPT thread.
   * Parent message ids are retained by ChatGptWebConversationService rather
   * than loaded from the account's saved chat history.
   */
  /** Why the most recent turn ended, for the refusal message below. */
  private lastEnd: { conversationId: string; reason: string } | null = null

  private readonly threads = new Map<
    string,
    {
      chatGptConversationId: string
      /**
       * How much of what the user has said is already in that thread.
       *
       * Counted in blocks rather than turns because Cursor hands over the
       * history as a growing list of text blocks. A continuation types only
       * the tail past this mark; without it every turn repeats everything
       * said before it, in one bubble.
       */
      sentBlocks: number
      /** The last thing typed into it, so a repeat is not typed twice. */
      lastMessage?: string
      touchedAt: number
    }
  >()

  constructor(
    private readonly configService: ConfigService,
    private readonly conversation: ChatGptWebConversationService,
    private readonly cursorTools: McpCursorToolsProvider
  ) {}

  /**
   * One ChatGPT turn, as raw SSE, over the plain HTTP transport.
   *
   * A fresh sentinel and the per-account HTTP session authorize each turn.
   * The configured MCP connector delivers tool calls to this bridge.
   *
   * The conversation id still has to be learned from the frames, because a
   * thread that did not exist before is named by the response rather than by
   * the request.
   */
  private async *turnSource(params: {
    conversationId: string
    prompt: string
    model: string
    thinkingEffort?: string
    thread?: string | null
    signal: AbortSignal
    /** Called once the thread has demonstrably received the prompt. */
    onDelivered: () => void
  }): AsyncGenerator<ChatGptWebEvent> {
    // Continuing a thread has to name the message it follows, or the turn is
    // grafted onto the wrong branch.
    const parentMessageId = params.thread
      ? await this.conversation.currentNode(params.thread).catch(() => null)
      : null
    let delivered = false
    for await (const event of this.conversation.stream({
      model: params.model,
      messages: [{ role: "user", content: params.prompt }],
      thinkingEffort: params.thinkingEffort ?? null,
      conversationId: params.thread ?? null,
      parentMessageId,
      signal: params.signal,
    })) {
      // The first frame is the proof that the post landed. Until one arrives
      // the prompt is not in the thread — an account on cooldown, a 403, an
      // abort before the request went out all fail before this point — and
      // recording it as said would make the retry that follows type nothing.
      if (!delivered) {
        delivered = true
        params.onDelivered()
      }
      // The end frame names the thread, which is how a conversation that did
      // not exist before becomes one the next turn can continue.
      if (event.kind === "done" && event.conversationId) {
        this.rememberThread(params.conversationId, event.conversationId)
      }
      yield event
    }
  }

  /**
   * Tool call ids this conversation has issued, across turns.
   *
   * A turn only knows the calls it made itself, and Cursor keeps resending
   * every result it holds — so once a turn ends, its answers looked like ids
   * nobody had ever asked for. The count said "for calls this turn never made"
   * about fifty replays of calls it had just answered.
   */
  private readonly dispatchedByConversation = new Map<string, Set<string>>()

  private noteDispatched(conversationId: string, toolCallId: string): void {
    let seen = this.dispatchedByConversation.get(conversationId)
    if (!seen) {
      seen = new Set()
      this.dispatchedByConversation.set(conversationId, seen)
    }
    seen.add(toolCallId)
  }

  private everDispatched(conversationId: string, toolCallId: string): boolean {
    return (
      this.dispatchedByConversation.get(conversationId)?.has(toolCallId) ??
      false
    )
  }

  private connectorId(): string {
    const id = this.configService
      .get<string>("CHATGPT_WEB_CONNECTOR_ID", "")
      .trim()
    if (!id) {
      throw new ChatGptWebError(
        503,
        "chatgpt_web_connector_unset",
        "Running a Cursor turn on ChatGPT Web needs CHATGPT_WEB_CONNECTOR_ID — " +
          "the connector that carries Cursor's tools"
      )
    }
    return id
  }

  /**
   * Anthropic SSE for one Cursor provider request.
   *
   * `toolResults` are the outcomes Cursor produced for the previous segment's
   * tool calls; handing them over is what unblocks the MCP requests still
   * holding ChatGPT's connector open.
   */
  async *stream(params: {
    conversationId: string
    model: string
    /** The rung Cursor asked for, if any: low / medium / high / xhigh / max. */
    thinkingLevel?: string | null
    /**
     * What the user just typed, as the request parser read it.
     *
     * This is what a turn continuing an existing thread types, because the
     * thread already holds everything before it.
     */
    newMessage?: string
    /**
     * Everything the user has said, oldest first, one block per thing. Used
     * only to seed a thread that does not exist yet.
     */
    promptBlocks: readonly string[]
    toolResults: { toolCallId: string; result: McpToolResult }[]
  }): AsyncGenerator<string, void, unknown> {
    const turn = this.resume(params) ?? this.begin(params)

    // Cursor resends every result it has accumulated on each continuation, so
    // most of these are for calls already answered. Ignored rather than
    // treated as an error — a duplicate must not tear down a healthy turn —
    // and counted rather than logged one by one, which grew as the square of
    // the tools in a turn and buried everything else in the log.
    let released = 0
    let replayed = 0
    const unknown: string[] = []
    for (const { toolCallId, result } of params.toolResults) {
      if (turn.session.submitToolResult(toolCallId, result)) {
        released += 1
        this.noteDispatched(params.conversationId, toolCallId)
      } else if (this.everDispatched(params.conversationId, toolCallId)) {
        replayed += 1
      } else {
        unknown.push(toolCallId.slice(0, 14))
      }
    }
    if (released > 0 || unknown.length > 0) {
      this.logger.warn(
        `Tool results for ${params.conversationId.slice(0, 8)}…: ` +
          `${released} released, ${replayed} replayed` +
          (unknown.length > 0
            ? `, ${unknown.length} for calls this turn never made ` +
              `(${unknown.slice(0, 5).join(", ")}…)`
            : "")
      )
    }

    turn.touchedAt = Date.now()
    try {
      yield* turn.session.segment()
    } catch (error) {
      this.end(turn, `segment failed: ${describe(error)}`)
      throw error
    } finally {
      // In a `finally` because Cursor does not drain this generator: it stops
      // pulling the moment it has the segment's `message_stop` and closes the
      // stream, so anything written after the `yield*` never runs. A spent
      // turn left standing here is the one the next request resumes, and it
      // has nothing to give — which the IDE reports as a provider that
      // completed without assistant content.
      //
      // `finished` already accounts for tool calls still waiting on the
      // editor, so a turn paused mid-tool is not torn down.
      turn.touchedAt = Date.now()
      if (this.active === turn && turn.session.finished) {
        this.end(turn, "turn complete")
      }
    }
  }

  /** Continue the turn already in flight for this conversation, if any. */
  private resume(params: { conversationId: string }): ActiveTurn | null {
    const turn = this.active
    if (!turn) return null
    if (turn.conversationId !== params.conversationId) {
      // Another conversation wants the sink, which only one turn can hold.
      // The older turn is ended rather than left half-read with MCP requests
      // hanging off it.
      this.end(turn, "another conversation took the tool sink")
      return null
    }
    if (Date.now() - turn.touchedAt > IDLE_SESSION_MS) {
      this.end(turn, "idle too long")
      return null
    }
    if (turn.session.finished) {
      // Nothing left to hand out. Resuming it would answer with an empty
      // segment instead of starting the turn the request actually asked for.
      this.end(turn, "turn already complete")
      return null
    }
    return turn
  }

  private begin(params: {
    conversationId: string
    model: string
    thinkingLevel?: string | null
    newMessage?: string
    promptBlocks: readonly string[]
  }): ActiveTurn {
    // A host turn opens no ChatGPT turn and needs no connector of its own: the
    // conversation it serves lives in ChatGPT's UI and already carries one.
    // Its source never yields, so the segment parks in the reader until a tool
    // call arrives or the turn is aborted.
    const host = isToolHost(params.model)
    const target = webGptTarget(params.model, params.thinkingLevel)
    const abort = new AbortController()
    const known = this.threads.get(params.conversationId)
    const thread = this.threadFor(params.conversationId)
    // Cursor repeats the user's message on every request of a turn, including
    // the ones that only carry a tool result back. Typing it again asks the
    // same question twice in the same thread.
    const repeat =
      !!params.newMessage && params.newMessage === known?.lastMessage
    // A thread that already holds the history needs only what was just typed.
    // A new one holds nothing, so it is seeded with everything said so far.
    //
    // The block tail is the fallback for a turn that arrives without a parsed
    // message — a resume, say. It counts blocks rather than messages because
    // Cursor packs a chat's turns into one user message as several of them.
    const blocks = thread
      ? repeat
        ? []
        : params.newMessage
          ? [params.newMessage]
          : params.promptBlocks.slice(known?.sentBlocks ?? 0)
      : params.promptBlocks
    if (!host && blocks.every((block) => !block.trim())) {
      // Nothing new to say and no live turn to continue. Posting this would
      // put an empty message in the thread and come back with nothing, which
      // the editor reports as a provider that completed without assistant
      // content — the same symptom with none of the cause in it. The shape
      // that gets here is a continuation for a turn already torn down.
      throw new ChatGptWebError(
        409,
        "chatgpt_web_no_live_turn",
        `The ChatGPT turn for ${params.conversationId.slice(0, 8)}… has ` +
          `already ended, and this request carries nothing new to ask` +
          (this.lastEnd?.conversationId === params.conversationId
            ? ` (it ended: ${this.lastEnd.reason})`
            : "") +
          "."
      )
    }
    // What the thread has heard is recorded only once it has actually heard
    // it. A host turn types nothing at all, so it records immediately.
    const markSent = () =>
      this.noteSentBlocks(
        params.conversationId,
        params.promptBlocks.length,
        params.newMessage
      )
    if (host) markSent()
    const session = new ChatGptWebTurnSession({
      source: host
        ? parked(abort.signal)
        : this.turnSource({
            conversationId: params.conversationId,
            prompt: blocks.join("\n\n"),
            // Which model answers and how hard it thinks travel together:
            // the top rung asks for the Pro model, not a deeper effort.
            model: target.slug,
            thinkingEffort: target.thinkingEffort ?? undefined,
            thread,
            signal: abort.signal,
            onDelivered: markSent,
          }),
    })

    const turn: ActiveTurn = {
      conversationId: params.conversationId,
      session,
      abort,
      touchedAt: Date.now(),
      detachSink: this.cursorTools.attach({
        dispatch: (name, args) => {
          this.logger.warn(`ChatGPT asked for ${name}; waiting on the editor`)
          return session.dispatchTool(name, args, (id) =>
            this.noteDispatched(params.conversationId, id)
          )
        },
      }),
    }
    this.active = turn
    const prompt = blocks.join("\n\n")
    this.logger.warn(
      `${host ? "Tool host" : "ChatGPT Web turn"} started for ` +
        `${params.conversationId.slice(0, 8)}… — sending ${prompt.length} chars ` +
        `into ${thread ? "thread " + thread.slice(0, 8) + "…" : "a new thread"}: ` +
        JSON.stringify(prompt.slice(0, 80))
    )
    return turn
  }

  /** The ChatGPT thread this Cursor conversation has been using, if recent. */
  private threadFor(conversationId: string): string | null {
    const known = this.threads.get(conversationId)
    if (!known?.chatGptConversationId) return null
    if (Date.now() - known.touchedAt > THREAD_MEMORY_MS) {
      this.threads.delete(conversationId)
      return null
    }
    return known.chatGptConversationId
  }

  /** Mark how much of the conversation this thread has now heard. */
  private noteSentBlocks(
    conversationId: string,
    sentBlocks: number,
    lastMessage?: string
  ): void {
    const known = this.threads.get(conversationId)
    this.threads.set(conversationId, {
      chatGptConversationId: known?.chatGptConversationId ?? "",
      sentBlocks,
      lastMessage: lastMessage ?? known?.lastMessage,
      touchedAt: Date.now(),
    })
  }

  private rememberThread(
    conversationId: string,
    chatGptConversationId: string
  ): void {
    const known = this.threads.get(conversationId)
    if (known?.chatGptConversationId !== chatGptConversationId) {
      this.logger.warn(
        `${conversationId.slice(0, 8)}… is thread ${chatGptConversationId}`
      )
    }
    this.threads.set(conversationId, {
      chatGptConversationId,
      sentBlocks: known?.sentBlocks ?? 0,
      lastMessage: known?.lastMessage,
      touchedAt: Date.now(),
    })
    // Bounded by hand: a long-lived bridge would otherwise remember every
    // conversation it ever served.
    if (this.threads.size > 200) {
      for (const [key, value] of this.threads) {
        if (Date.now() - value.touchedAt > THREAD_MEMORY_MS) {
          this.threads.delete(key)
        }
      }
    }
  }

  private end(turn: ActiveTurn, reason: string): void {
    // Kept so that a later request refused for having nothing to ask can name
    // the failure that actually stranded it, rather than only its own symptom.
    this.lastEnd = { conversationId: turn.conversationId, reason }
    if (this.active === turn) this.active = null
    turn.detachSink()
    turn.abort.abort(new Error(reason))
    turn.session.abort(reason)
    this.logger.warn(
      `ChatGPT Web turn ended for ${turn.conversationId.slice(0, 8)}…: ${reason}`
    )
  }

  /** Drop the active turn if it belongs to this conversation. */
  release(conversationId: string, reason: string): void {
    if (this.active?.conversationId === conversationId) {
      this.end(this.active, reason)
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether this backend model asks for a parked tool host. */
function isToolHost(model: string): boolean {
  return model.trim().toLowerCase() === CHATGPT_WEB_TOOL_HOST_MODEL
}

/**
 * A source that yields nothing and ends only when the turn is abandoned.
 *
 * The session treats the end of its source as the end of the turn, so this is
 * what keeps a host segment open: Cursor's stream stays parked, kept alive by
 * the heartbeat wrapper every other backend relies on, until the editor aborts
 * it.
 */
// Yielding nothing is the point: the turn produces no assistant output, it
// only stays open.
// eslint-disable-next-line require-yield
async function* parked(signal?: AbortSignal): AsyncGenerator<ChatGptWebEvent> {
  await new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    signal?.addEventListener("abort", () => resolve(), { once: true })
  })
}
