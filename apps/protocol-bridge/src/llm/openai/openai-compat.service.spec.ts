/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { ConfigService } from "@nestjs/config"
import { OpenaiCompatService } from "./openai-compat.service"
import type { PersistenceService } from "../../persistence"
import type { UsageStatsService } from "../../usage"

describe("OpenaiCompatService", () => {
  const originalSkylinkOnly = process.env.AGENT_VIBES_SKYLINK_ONLY

  afterEach(() => {
    if (originalSkylinkOnly === undefined) {
      delete process.env.AGENT_VIBES_SKYLINK_ONLY
    } else {
      process.env.AGENT_VIBES_SKYLINK_ONLY = originalSkylinkOnly
    }
  })

  function createService(): OpenaiCompatService {
    return new OpenaiCompatService(
      new ConfigService(),
      {} as PersistenceService,
      {} as UsageStatsService
    )
  }

  it("forces every account to Skylink when Skylink-only mode is enabled", () => {
    process.env.AGENT_VIBES_SKYLINK_ONLY = "true"

    const service = createService() as unknown as {
      buildAccountRecord(params: {
        label?: string
        apiKey: string
        baseUrl: string
        source: "env" | "file"
      }): { baseUrl: string; stateKey: string }
    }

    const editedFileAccount = service.buildAccountRecord({
      label: "edited-file",
      apiKey: "sk-test",
      baseUrl: "https://api.example.com/v1",
      source: "file",
    })
    const skylinkAccount = service.buildAccountRecord({
      label: "skylink",
      apiKey: "sk-test",
      baseUrl: "https://skylink-gateway.com/api/v1",
      source: "file",
    })

    expect(editedFileAccount.baseUrl).toBe("https://skylink-gateway.com/api/v1")
    expect(editedFileAccount.stateKey).toBe(skylinkAccount.stateKey)
  })

  it("keeps configured account URLs outside Skylink-only mode", () => {
    delete process.env.AGENT_VIBES_SKYLINK_ONLY

    const service = createService() as unknown as {
      buildAccountRecord(params: {
        apiKey: string
        baseUrl: string
        source: "env" | "file"
      }): { baseUrl: string }
    }

    expect(
      service.buildAccountRecord({
        apiKey: "sk-test",
        baseUrl: "https://api.example.com/v1",
        source: "file",
      }).baseUrl
    ).toBe("https://api.example.com/v1")
  })
})
