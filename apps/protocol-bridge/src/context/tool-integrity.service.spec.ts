import { describe, expect, it } from "@jest/globals"
import { TokenCounterService } from "./token-counter.service"
import { ToolIntegrityService } from "./tool-integrity.service"
import { UnifiedMessage } from "./types"

describe("ToolIntegrityService.sanitizeMessages", () => {
  const service = new ToolIntegrityService(new TokenCounterService())

  it("preserves pending assistant tool invocations without results", () => {
    const messages: UnifiedMessage[] = [
      {
        role: "user",
        content: "Run the check",
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "read_file",
            input: { path: "src/app.ts" },
          },
        ],
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-2",
            type: "function",
            function: {
              name: "grep",
              arguments: JSON.stringify({ pattern: "TODO" }),
            },
          },
        ],
      },
    ]

    const sanitized = service.sanitizeMessages(messages)

    expect(sanitized.removedOrphanToolUses).toBe(0)
    expect(sanitized.messages).toHaveLength(3)
    expect(sanitized.messages[1]?.content).toEqual(messages[1]?.content)
    expect(sanitized.messages[2]?.tool_calls).toEqual(messages[2]?.tool_calls)
  })

  it("keeps valid image-only messages", () => {
    const messages: UnifiedMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "ZmFrZS1pbWFnZS1ieXRlcw==",
            },
          },
        ],
      },
    ]

    const sanitized = service.sanitizeMessages(messages)

    expect(sanitized.removedEmptyMessages).toBe(0)
    expect(sanitized.messages).toEqual(messages)
  })
})
