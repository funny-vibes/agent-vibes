/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { isCursorAgentHost } from "./forward-proxy"

describe("isCursorAgentHost", () => {
  it("redirects Cursor 3.5 agent, auth, and auxiliary hosts to the bridge", () => {
    for (const host of [
      "api2.cursor.sh",
      "api5.cursor.sh",
      "agent.api5.cursor.sh",
      "api3.cursor.sh",
      "api4.cursor.sh",
      "authentication.cursor.sh",
      "prod.authentication.cursor.sh",
      "authenticator.cursor.sh",
      "repo42.cursor.sh",
    ]) {
      expect(isCursorAgentHost(host)).toBe(true)
    }
  })

  it("does not redirect unrelated Cursor web properties", () => {
    for (const host of [
      "cursor.com",
      "downloads.cursor.com",
      "marketplace.cursorapi.com",
      "example.com",
    ]) {
      expect(isCursorAgentHost(host)).toBe(false)
    }
  })
})
