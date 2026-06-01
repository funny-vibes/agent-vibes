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

  it("prefers OpenAI-compatible GPT routing over Codex when both are available", () => {
    const router = new ModelRouterService()
    router.setGptAvailabilityProviders({
      codex: () => true,
      openaiCompat: () => true,
      codexSupportsModel: () => true,
      openaiCompatSupportsModel: () => true,
    })

    const candidates = router.getGptBackendCandidates("gpt-5.5")

    expect(candidates?.primary).toMatchObject({
      backend: "openai-compat",
      model: "gpt-5.5",
    })
    expect(candidates?.fallbacks[0]).toMatchObject({
      backend: "codex",
      model: "gpt-5.5",
    })
    expect(router.resolveModel("gpt-5.5")).toMatchObject({
      backend: "openai-compat",
      model: "gpt-5.5",
    })
  })

  it("falls back to Codex when OpenAI-compatible allowlist rejects the model", () => {
    const router = new ModelRouterService()
    router.setGptAvailabilityProviders({
      codex: () => true,
      openaiCompat: () => true,
      codexSupportsModel: () => true,
      openaiCompatSupportsModel: (model) => model === "gpt-5.5",
    })

    expect(router.resolveModel("gpt-5.5")).toMatchObject({
      backend: "openai-compat",
      model: "gpt-5.5",
    })
    expect(router.resolveModel("gpt-5.4")).toMatchObject({
      backend: "codex",
      model: "gpt-5.4",
    })
  })
})
