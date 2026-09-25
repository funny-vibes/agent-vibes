import { BadRequestException, Injectable } from "@nestjs/common"
import { createHash } from "node:crypto"
import { PersistenceService } from "../../persistence"
import { CodexService } from "../../llm/openai/codex.service"
import { CodexApiError } from "../../llm/openai/codex-api-error"
import {
  createCodexRootProviderIdentity,
  type CodexRootProviderIdentity,
} from "../../llm/openai/codex-provider-identity"
import type {
  CodexInputItem,
  CodexNativeInputExecutionRequest,
  CodexRequest,
} from "../../llm/openai/codex-native-types"
import { runProviderPhysicalDispatchStream } from "../../llm/shared/provider-physical-dispatch"
import { ModelRouterService } from "../../llm/shared/model-router.service"
import type { OpenAiResponsesRequest } from "./openai-types"

export interface CodexResponsesContext {
  owner: string
  signal?: AbortSignal
}

interface StoredResponse {
  thread_id: string
  model: string
  input_json: string
  output_json: string
}

/**
 * A terminal Responses frame carries the whole response, `output` included:
 * clients such as the OpenAI Agents SDK read a turn's final output only from
 * `response.completed`. The codex backend leaves that `output` empty and sends
 * the items on the intermediate `response.output_item.done` events, so the
 * frame is completed from those before it leaves the bridge — the same
 * backfill `CodexWebSocketService.sendViaWebSocket` applies to non-streaming
 * calls. Without it a streaming caller sees a turn with no output and asks the
 * model again, until its turn limit.
 */
export function withTerminalOutput(
  response: Record<string, unknown>,
  collected: readonly Record<string, unknown>[]
): Record<string, unknown> {
  return Array.isArray(response.output) && response.output.length
    ? response
    : collected.length
      ? { ...response, output: [...collected] }
      : response
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_HISTORY_BYTES = 32 * 1024 * 1024

/** Native Responses never pass through the Anthropic content-block contract. */
@Injectable()
export class CodexResponsesService {
  constructor(
    private readonly codex: CodexService,
    private readonly persistence: PersistenceService,
    private readonly modelRouter: ModelRouterService
  ) {}

  usesCodex(model: string): boolean {
    return this.modelRouter.resolveModel(model).backend === "codex"
  }

  async create(
    req: OpenAiResponsesRequest,
    context: CodexResponsesContext
  ): Promise<Record<string, unknown>> {
    let response: Record<string, unknown> | undefined
    const output: Record<string, unknown>[] = []
    for await (const frame of this.stream(req, context)) {
      const event = JSON.parse(frame.split("\ndata: ")[1]!.trim()) as Record<
        string,
        unknown
      >
      if (event.type === "response.output_item.done" && event.item)
        output.push(event.item as Record<string, unknown>)
      if (
        [
          "response.completed",
          "response.failed",
          "response.incomplete",
        ].includes(String(event.type))
      )
        response = event.response as Record<string, unknown>
    }
    if (!response)
      throw new CodexApiError(
        502,
        "Codex stream ended without a terminal response",
        undefined,
        "stream_closed"
      )
    return withTerminalOutput(response, output)
  }

  async *stream(
    req: OpenAiResponsesRequest,
    context: CodexResponsesContext
  ): AsyncGenerator<string> {
    context.signal?.throwIfAborted()
    const model = this.modelRouter.resolveModel(req.model).model
    const ownerHash = createHash("sha256").update(context.owner).digest("hex")
    let identity = createCodexRootProviderIdentity()
    let input = normalizeInput(req.input)
    if (req.previous_response_id != null) {
      if (
        typeof req.previous_response_id !== "string" ||
        !req.previous_response_id.trim()
      )
        throw new BadRequestException(
          "previous_response_id must be a non-empty string"
        )
      const prior = this.persistence
        .prepare(
          "SELECT thread_id, model, input_json, output_json FROM codex_response_chains WHERE owner_hash = ? AND response_id = ? AND expires_at > ?"
        )
        .get(ownerHash, req.previous_response_id, Date.now()) as
        | StoredResponse
        | undefined
      if (!prior)
        throw new CodexApiError(
          400,
          "Previous response not found for this caller, expired, or was not stored",
          undefined,
          "previous_response_not_found"
        )
      if (prior.model !== model)
        throw new CodexApiError(
          400,
          "A native response chain must keep its model; send full input to start a different model",
          undefined,
          "model_mismatch"
        )
      identity = {
        sessionId: prior.thread_id,
        threadId: prior.thread_id,
        threadSource: "user",
      }
      input = [
        ...(JSON.parse(prior.input_json) as CodexInputItem[]),
        ...(JSON.parse(prior.output_json) as CodexInputItem[]),
        ...input,
      ]
    }
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_HISTORY_BYTES)
      throw new CodexApiError(
        413,
        "Responses input history exceeds the storage limit",
        undefined,
        "request_too_large"
      )
    const wire = {
      ...structuredClone(req),
      model,
      input,
      stream: true,
      store: false,
    } as unknown as CodexRequest
    delete wire.previous_response_id
    const request =
      this.codex.prepareBridgeNativeExecutionRequest<CodexNativeInputExecutionRequest>(
        {
          model,
          upstreamIdentity: identity,
          localProjectionKey: `responses:${ownerHash}:${identity.threadId}`,
          nativeInput: input,
          wireRequest: wire,
          responseFormat: "native",
          continuationPolicy: "isolated",
        }
      )
    let terminal = false
    const output: Record<string, unknown>[] = []
    for await (const frame of runProviderPhysicalDispatchStream({
      plan: {
        scope: request.localProjectionKey,
        backend: "codex",
        model,
        request,
      },
      signal: context.signal,
      execute: (dispatch) =>
        this.codex.sendMessageStream(dispatch, { abortSignal: context.signal }),
      // Once an event is visible to the caller, this attempt can never be replayed.
      acceptanceForValue: () => ({}),
    })) {
      const event = JSON.parse(frame.split("\ndata: ")[1]!.trim()) as Record<
        string,
        unknown
      >
      if (event.response && typeof event.response === "object") {
        const response = event.response as Record<string, unknown>
        response.store = req.store !== false
        response.previous_response_id = req.previous_response_id ?? null
      }
      if (event.type === "response.output_item.done" && event.item)
        output.push(structuredClone(event.item as Record<string, unknown>))
      if (
        [
          "response.completed",
          "response.failed",
          "response.incomplete",
        ].includes(String(event.type))
      ) {
        terminal = true
        if (event.response && typeof event.response === "object")
          event.response = withTerminalOutput(
            event.response as Record<string, unknown>,
            output
          )
        const response = event.response as Record<string, unknown>
        if (!response || typeof response.id !== "string")
          throw new CodexApiError(
            502,
            "Invalid native Responses terminal envelope",
            undefined,
            "invalid_response"
          )
        // Persist before exposing the ID: immediate continuation and restart see the same boundary.
        if (event.type === "response.completed" && req.store !== false) {
          this.store(
            ownerHash,
            identity,
            model,
            response.id,
            input,
            Array.isArray(response.output) ? response.output : output
          )
        }
        yield `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
        return
      }
      yield `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
    }
    if (!terminal)
      throw new CodexApiError(
        502,
        "Codex stream ended without a terminal response",
        undefined,
        "stream_closed"
      )
  }

  private store(
    owner: string,
    identity: CodexRootProviderIdentity,
    model: string,
    responseId: string,
    input: readonly CodexInputItem[],
    output: readonly unknown[]
  ): void {
    this.persistence.runInTransaction(() => {
      this.persistence
        .prepare("DELETE FROM codex_response_chains WHERE expires_at <= ?")
        .run(Date.now())
      this.persistence
        .prepare(
          "INSERT INTO codex_response_chains (owner_hash, response_id, thread_id, model, input_json, output_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          owner,
          responseId,
          identity.threadId,
          model,
          JSON.stringify(input),
          JSON.stringify(output),
          Date.now() + RETENTION_MS
        )
    })
  }
}

function normalizeInput(
  input: OpenAiResponsesRequest["input"]
): CodexInputItem[] {
  if (typeof input === "string")
    return [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: input }],
      },
    ]
  if (!Array.isArray(input))
    throw new BadRequestException(
      "Responses input must be text or an item array"
    )
  return input.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new BadRequestException("Responses input items must be objects")
    const item = structuredClone(raw) as unknown as Record<string, unknown>
    if (item.type === undefined && typeof item.role === "string")
      item.type = "message"
    if (item.type === "message" && typeof item.content === "string")
      item.content = [
        {
          type: item.role === "assistant" ? "output_text" : "input_text",
          text: item.content,
        },
      ]
    if (typeof item.type !== "string" || !item.type)
      throw new BadRequestException("Responses input item requires a type")
    return item as unknown as CodexInputItem
  })
}
