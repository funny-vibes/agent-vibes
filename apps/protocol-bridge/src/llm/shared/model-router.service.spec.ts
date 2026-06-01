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
})
