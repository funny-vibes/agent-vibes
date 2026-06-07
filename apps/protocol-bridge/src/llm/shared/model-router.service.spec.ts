/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { ModelRouterService } from "./model-router.service"

describe("ModelRouterService", () => {
  it("omits OpenAI-compatible fallback when the allowlist rejects the model", () => {
    const router = new ModelRouterService()
    router.setGptAvailabilityProviders({
      codex: () => true,
      openaiCompat: () => true,
      codexSupportsModel: () => true,
      openaiCompatSupportsModel: (model) => model === "gpt-5.5",
    })

    expect(router.getGptBackendCandidates("gpt-5.5")).toMatchObject({
      primary: {
        backend: "codex",
        model: "gpt-5.5",
      },
      fallbacks: [
        {
          backend: "openai-compat",
          model: "gpt-5.5",
        },
      ],
    })
    expect(router.getGptBackendCandidates("gpt-5.4")).toMatchObject({
      primary: {
        backend: "codex",
        model: "gpt-5.4",
      },
      fallbacks: [],
    })
    expect(router.resolveModel("gpt-5.5")).toMatchObject({
      backend: "codex",
      model: "gpt-5.5",
    })
    expect(router.resolveModel("gpt-5.4")).toMatchObject({
      backend: "codex",
      model: "gpt-5.4",
    })
  })

  it("routes Cursor gpt-5 display alias to OpenAI-compatible gpt-5.5", () => {
    const router = new ModelRouterService()
    router.setGptAvailabilityProviders({
      codex: () => false,
      openaiCompat: () => true,
      codexSupportsModel: () => false,
      openaiCompatSupportsModel: (model) =>
        model === "gpt-5" || model === "gpt-5.5",
    })

    expect(router.getGptBackendCandidates("gpt-5")).toMatchObject({
      primary: {
        backend: "openai-compat",
        model: "gpt-5.5",
      },
      fallbacks: [],
    })
    expect(router.resolveModel("gpt-5")).toMatchObject({
      backend: "openai-compat",
      model: "gpt-5.5",
    })
  })

  it("routes Cursor default model intent to OpenAI-compatible gpt-5.5", () => {
    const router = new ModelRouterService()
    router.setGptAvailabilityProviders({
      codex: () => false,
      openaiCompat: () => true,
      codexSupportsModel: () => false,
      openaiCompatSupportsModel: (model) => model === "gpt-5.5",
    })

    expect(router.resolveModel("default")).toMatchObject({
      backend: "openai-compat",
      model: "gpt-5.5",
    })
  })
})
