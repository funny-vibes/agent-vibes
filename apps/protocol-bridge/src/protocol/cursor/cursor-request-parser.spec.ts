import { create, toBinary } from "@bufbuild/protobuf"
import { describe, expect, it } from "@jest/globals"
import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  ConversationActionSchema,
  CustomSubagentSchema,
  ModelDetailsSchema,
  RequestContextSchema,
  UserMessageActionSchema,
  UserMessageSchema,
} from "../../gen/agent/v1_pb"
import { CursorRequestParser } from "./cursor-request-parser"

describe("CursorRequestParser", () => {
  it("filters disabled web tools out of declared custom subagent tools", () => {
    const parser = new CursorRequestParser()
    const request = create(AgentClientMessageSchema, {
      message: {
        case: "runRequest",
        value: create(AgentRunRequestSchema, {
          conversationId: "conv-1",
          modelDetails: create(ModelDetailsSchema, {
            modelId: "claude-sonnet-4-20250514",
          }),
          action: create(ConversationActionSchema, {
            action: {
              case: "userMessageAction",
              value: create(UserMessageActionSchema, {
                userMessage: create(UserMessageSchema, {
                  text: "hello",
                }),
                requestContext: create(RequestContextSchema, {
                  webSearchEnabled: false,
                  webFetchEnabled: false,
                  customSubagents: [
                    create(CustomSubagentSchema, {
                      name: "worker",
                      tools: [
                        "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
                        "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
                        "CLIENT_SIDE_TOOL_V2_READ_FILE_V2",
                      ],
                    }),
                  ],
                }),
              }),
            },
          }),
        }),
      },
    })

    const parsed = parser.parseRequest(
      Buffer.from(toBinary(AgentClientMessageSchema, request))
    )

    expect(parsed).not.toBeNull()
    expect(parsed?.useWeb).toBe(false)
    expect(parsed?.supportedTools).toContain("CLIENT_SIDE_TOOL_V2_READ_FILE_V2")
    expect(parsed?.supportedTools).not.toContain(
      "CLIENT_SIDE_TOOL_V2_WEB_SEARCH"
    )
    expect(parsed?.supportedTools).not.toContain(
      "CLIENT_SIDE_TOOL_V2_WEB_FETCH"
    )
  })
})
