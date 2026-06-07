/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { SubagentExecBridgeService } from "./subagent-exec-bridge.service"

describe("SubagentExecBridgeService", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("rejects a waiter when its timeout elapses", async () => {
    const bridge = new SubagentExecBridgeService()

    const result = bridge.awaitResult(
      "conversation-1",
      "subagent-1",
      "call-1",
      {
        timeoutMs: 100,
        timeoutMessage: "waited too long",
      }
    )

    jest.advanceTimersByTime(100)

    await expect(result).rejects.toThrow("waited too long")
    expect(bridge.hasWaiter("call-1")).toBe(false)
  })

  it("clears the timeout when a result is delivered", async () => {
    const bridge = new SubagentExecBridgeService()

    const result = bridge.awaitResult(
      "conversation-1",
      "subagent-1",
      "call-1",
      {
        timeoutMs: 100,
        timeoutMessage: "waited too long",
      }
    )

    expect(
      bridge.deliverResult("call-1", {
        resultCase: "mcpResult",
        resultData: Buffer.from("ok"),
      })
    ).toBe(true)

    await expect(result).resolves.toMatchObject({
      resultCase: "mcpResult",
    })

    jest.advanceTimersByTime(100)
    expect(bridge.hasWaiter("call-1")).toBe(false)
  })
})
