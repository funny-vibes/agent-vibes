/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { MessagesService } from "./messages.service"

function createMessagesService(params: {
  openaiCompatSupportsModel: (model: string) => boolean
}): MessagesService {
  return new MessagesService(
    {} as never,
    {
      getAllModelIds: () => [],
      isValidModel: () => false,
    } as never,
    {
      isGoogleAvailable: false,
      isKiroAvailable: false,
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {
      isAvailable: () => false,
      supportsModel: () => false,
      getModelTier: () => null,
    } as never,
    {
      isAvailable: () => true,
      supportsModel: params.openaiCompatSupportsModel,
    } as never,
    {
      supportsModel: () => false,
      getPublicModels: () => [],
    } as never,
    {
      getPublicModelIds: () => [],
    } as never
  )
}

describe("MessagesService", () => {
  it("advertises only OpenAI-compatible GPT models allowed by the account allowlist", () => {
    const service = createMessagesService({
      openaiCompatSupportsModel: (model) => model === "gpt-5.5",
    })

    const ids = service.listModels().data.map((model) => model.id)

    expect(ids).toContain("gpt-5.5")
    expect(ids).not.toContain("gpt-5.4")
    expect(ids).not.toContain("gpt-5.4-mini")
  })
})
