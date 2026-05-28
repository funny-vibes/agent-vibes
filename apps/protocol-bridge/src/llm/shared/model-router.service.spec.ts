/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { ModelRouterService } from "./model-router.service"

describe("ModelRouterService", () => {
  it("routes branded OpenAI-compatible model ids to the underlying GPT model", () => {
    const router = new ModelRouterService()
    router.setGptAvailabilityProviders({
      codex: () => false,
      openaiCompat: () => true,
      openaiCompatSupportsModel: () => true,
    })

    expect(router.resolveModel("openai/gpt-5.5")).toMatchObject({
      backend: "openai-compat",
      model: "gpt-5.5",
    })
  })
})
