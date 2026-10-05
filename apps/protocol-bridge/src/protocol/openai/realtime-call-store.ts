import { Injectable } from "@nestjs/common"
import { PersistenceService } from "../../persistence"
import {
  ChatGptWebConversationService,
  ChatGptWebError,
} from "../../llm/openai/chatgpt-web-conversation.service"
import type { ChatGptWebRealtimeCallResult } from "../../llm/openai/chatgpt-web-realtime"
import type {
  GptHistoryPolicy,
  GptProvider,
} from "../../llm/shared/gpt-api-contract"

interface CallRecord {
  call_id: string
  provider: GptProvider
  history_policy: GptHistoryPolicy
  account_key: string | null
  conversation_id: string | null
  status: "signaled" | "linked" | "closed" | "cleanup_failed"
  last_error: string | null
  created_at: number
  updated_at: number
}

/** Stores only identifiers. OAuth credentials are re-leased when cleaning up. */
@Injectable()
export class RealtimeCallStore {
  private readonly closing = new Map<string, Promise<Record<string, unknown>>>()
  constructor(
    private readonly persistence: PersistenceService,
    private readonly conversations: ChatGptWebConversationService
  ) {}

  register(
    result: ChatGptWebRealtimeCallResult,
    provider: GptProvider,
    policy: GptHistoryPolicy
  ): void {
    const now = Date.now()
    this.persistence
      .prepare(
        "DELETE FROM realtime_calls WHERE status = 'closed' AND updated_at < ?"
      )
      .run(now - 30 * 60_000)
    this.persistence
      .prepare(
        `INSERT INTO realtime_calls (call_id, provider, history_policy, account_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(result.callId, provider, policy, result.accountKey ?? null, now, now)
  }

  private read(id: string): CallRecord {
    const record = this.persistence
      .prepare("SELECT * FROM realtime_calls WHERE call_id = ?")
      .get(id) as unknown as CallRecord | undefined
    if (!record)
      throw new ChatGptWebError(
        404,
        "realtime_call_not_found",
        "Unknown realtime call"
      )
    return record
  }

  get(id: string): Record<string, unknown> {
    const call = this.read(id)
    return {
      id: call.call_id,
      object: "realtime.call",
      provider: call.provider,
      history_policy: call.history_policy,
      status: call.status,
      protocol:
        call.provider === "codex"
          ? "codex-realtime-v3"
          : "chatgpt-web-data-message",
      data_channel:
        call.provider === "codex"
          ? { label: "oai-events", negotiated: false }
          : { label: "oai-events", negotiated: true, id: 0 },
      conversation_id: call.conversation_id,
      created_at: Math.floor(call.created_at / 1000),
      ...(call.last_error
        ? {
            error: {
              code: "realtime_cleanup_failed",
              message: call.last_error,
            },
          }
        : {}),
    }
  }

  /** The authenticated peer reports the id from startup_telemetry/conversation_update. */
  bind(id: string, conversationId: unknown): Record<string, unknown> {
    const call = this.read(id)
    if (call.provider !== "chatgpt-web")
      throw new ChatGptWebError(
        400,
        "realtime_binding_unsupported",
        "Only ChatGPT Web calls require a conversation binding"
      )
    if (
      typeof conversationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        conversationId
      )
    ) {
      throw new ChatGptWebError(
        400,
        "realtime_conversation_invalid",
        "conversation_id must be a UUID returned by this call's data channel"
      )
    }
    if (call.conversation_id === conversationId) return this.get(id)
    if (
      call.conversation_id ||
      call.status === "closed" ||
      this.closing.has(id)
    )
      throw new ChatGptWebError(
        409,
        "realtime_binding_conflict",
        "A realtime call's conversation binding cannot be replaced"
      )
    this.persistence
      .prepare(
        "UPDATE realtime_calls SET conversation_id = ?, status = 'linked', updated_at = ? WHERE call_id = ? AND conversation_id IS NULL"
      )
      .run(conversationId, Date.now(), id)
    return this.get(id)
  }

  /** The peer closes its RTCPeerConnection first; this completes gateway cleanup. */
  async close(id: string): Promise<Record<string, unknown>> {
    const pending = this.closing.get(id)
    if (pending) return pending
    const task = this.closeOnce(id)
    this.closing.set(id, task)
    try {
      return await task
    } finally {
      this.closing.delete(id)
    }
  }

  private async closeOnce(id: string): Promise<Record<string, unknown>> {
    const call = this.read(id)
    if (call.status === "closed") return this.get(id)
    if (call.provider === "chatgpt-web") {
      if (!call.conversation_id)
        throw new ChatGptWebError(
          409,
          "realtime_conversation_not_bound",
          "Report the conversation_id from this call's data channel before requesting cleanup"
        )
      if (!call.account_key)
        throw new ChatGptWebError(
          500,
          "realtime_account_missing",
          "The call's account binding is missing"
        )
      try {
        await this.conversations.deleteConversationForAccount(
          call.account_key,
          call.conversation_id
        )
      } catch (error) {
        this.persistence
          .prepare(
            "UPDATE realtime_calls SET status = 'cleanup_failed', last_error = ?, updated_at = ? WHERE call_id = ?"
          )
          .run(
            error instanceof Error ? error.message : String(error),
            Date.now(),
            id
          )
        throw error
      }
    }
    this.persistence
      .prepare(
        "UPDATE realtime_calls SET status = 'closed', last_error = NULL, updated_at = ? WHERE call_id = ?"
      )
      .run(Date.now(), id)
    return this.get(id)
  }
}
