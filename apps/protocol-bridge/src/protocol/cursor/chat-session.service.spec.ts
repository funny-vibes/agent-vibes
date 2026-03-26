import { afterEach, describe, expect, it } from "@jest/globals"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { ParsedCursorRequest } from "./cursor-request-parser"
import { ChatSessionManager } from "./chat-session.service"

function makeParsedRequest(
  overrides: Partial<ParsedCursorRequest> = {}
): ParsedCursorRequest {
  return {
    conversation: [],
    newMessage: "",
    model: "claude-sonnet-4-20250514",
    thinkingLevel: 0,
    unifiedMode: "AGENT",
    isAgentic: true,
    supportedTools: [],
    useWeb: false,
    ...overrides,
  }
}

describe("ChatSessionManager.getOrCreateSession", () => {
  const originalHome = process.env.HOME
  let tempHome: string | undefined
  let manager: ChatSessionManager | undefined

  afterEach(() => {
    manager?.onModuleDestroy()
    manager = undefined

    process.env.HOME = originalHome

    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true })
      tempHome = undefined
    }
  })

  it("clears per-turn cursor commands and custom system prompt when omitted", () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-manager-"))
    process.env.HOME = tempHome
    manager = new ChatSessionManager()

    manager.getOrCreateSession(
      "conv-1",
      makeParsedRequest({
        cursorCommands: [{ name: "/fix", content: "Apply the fix" }],
        customSystemPrompt: "Follow the release checklist.",
      })
    )

    const session = manager.getOrCreateSession("conv-1", makeParsedRequest())

    expect(session.cursorCommands).toBeUndefined()
    expect(session.customSystemPrompt).toBeUndefined()
  })
})
