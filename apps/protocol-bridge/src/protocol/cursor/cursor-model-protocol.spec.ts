/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import {
  applyGptModelDisplayPrefix,
  buildCursorModelLabel,
} from "./cursor-model-protocol"
import type { CursorDisplayModel } from "../../llm/shared/model-registry"

describe("applyGptModelDisplayPrefix", () => {
  it("brands only GPT display labels without changing model ids", () => {
    const models: CursorDisplayModel[] = [
      {
        name: "gpt-5.5",
        displayName: "GPT-5.5",
        shortName: "GPT-5.5",
        family: "gpt",
        isThinking: true,
      },
      {
        name: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        shortName: "Sonnet 4.6",
        family: "claude",
        isThinking: false,
      },
    ]

    expect(applyGptModelDisplayPrefix(models, "Touka")).toEqual([
      {
        ...models[0],
        displayName: "Touka GPT-5.5",
        shortName: "Touka GPT-5.5",
      },
      models[1],
    ])
  })

  it("does not double-prefix already branded GPT labels", () => {
    const model: CursorDisplayModel = {
      name: "gpt-5.5",
      displayName: "Touka GPT-5.5",
      shortName: "Touka GPT-5.5",
      family: "gpt",
      isThinking: true,
    }

    expect(applyGptModelDisplayPrefix([model], "Touka")).toEqual([model])
  })
})

describe("buildCursorModelLabel", () => {
  it("keeps branded GPT context in the short label", () => {
    const model: CursorDisplayModel = {
      name: "gpt-5.5",
      displayName: "Touka GPT-5.5",
      shortName: "Touka GPT-5.5",
      family: "gpt",
      isThinking: true,
    }

    const label = buildCursorModelLabel(model)

    expect(label).toMatchObject({
      name: "gpt-5.5",
      label: "Touka GPT-5.5",
    })
    expect(label.shortLabel).toMatch(/^Touka GPT-5\.5 /)
  })
})
