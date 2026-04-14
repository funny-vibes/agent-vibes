import { describe, expect, it } from "@jest/globals"
import {
  BASE_CODEX_CURSOR_DISPLAY_MODELS,
  buildCursorAvailableModel,
  buildCursorModelLabel,
  buildCursorUsableModel,
  buildLegacyCursorAvailableModels,
  resolveCursorDefaultSelection,
} from "./cursor-model-protocol"

describe("cursor-model-protocol", () => {
  const gpt54 = BASE_CODEX_CURSOR_DISPLAY_MODELS.find(
    (model) => model.name === "gpt-5.4"
  )

  it("基础模型在参数模式下保留 variants 配置", () => {
    expect(gpt54).toBeDefined()

    const availableModel = buildCursorAvailableModel(gpt54!, 0, {
      includeParameterDefinitions: true,
      includeVariants: true,
      defaultOn: true,
    })

    expect(availableModel.name).toBe("gpt-5.4")
    expect(availableModel.serverModelName).toBe("gpt-5.4")
    expect(availableModel.clientDisplayName).toBe("GPT-5.4")
    expect(availableModel.variants.length).toBeGreaterThan(1)

    const variantDisplayNames = availableModel.variants.map(
      (variant) => variant.displayName
    )
    // 官方 Cursor 格式：HTML span + :icon-brain: 标记
    expect(variantDisplayNames).toContain(
      'GPT-5.4 <span style="color: var(--cursor-text-tertiary); font-size: 0.85em;">:icon-brain: High Fast</span>'
    )
    expect(variantDisplayNames).toContain(
      'GPT-5.4 <span style="color: var(--cursor-text-tertiary); font-size: 0.85em;">:icon-brain: Extra high Fast</span>'
    )
  })

  it("React picker 路径不会把 GPT 变体错误铺开成顶层模型", () => {
    expect(gpt54).toBeDefined()

    const groupedModel = buildCursorAvailableModel(gpt54!, 0, {
      includeParameterDefinitions: false,
      includeVariants: true,
    })
    const explodedModels = buildLegacyCursorAvailableModels(gpt54!, 0)

    expect(groupedModel.name).toBe("gpt-5.4")
    expect(explodedModels.length).toBeGreaterThan(1)
    expect(
      explodedModels.some((model) => model.name === "gpt-5.4-high-fast")
    ).toBe(true)
    expect(groupedModel.name).not.toBe("gpt-5.4-high-fast")
  })

  it("设置页顶层模型会投影默认变体效果", () => {
    expect(gpt54).toBeDefined()

    const availableModel = buildCursorAvailableModel(gpt54!, 0, {
      includeParameterDefinitions: false,
      includeVariants: true,
    })

    expect(availableModel.name).toBe("gpt-5.4")
    expect(availableModel.tagline).toBe("Low reasoning")
    expect(availableModel.inputboxShortModelName).toBe("GPT-5.4")
  })

  it("模型标签会为设置页投影默认变体效果", () => {
    expect(gpt54).toBeDefined()

    const modelLabel = buildCursorModelLabel(gpt54!)

    expect(modelLabel.name).toBe("gpt-5.4")
    expect(modelLabel.label).toBe("GPT-5.4")
    expect(modelLabel.shortLabel).toBe("Low reasoning")
  })

  it("聊天可用模型保持 canonical base model identity", () => {
    expect(gpt54).toBeDefined()

    const usableModel = buildCursorUsableModel(gpt54!)

    expect(usableModel.modelId).toBe("gpt-5.4")
    expect(usableModel.displayModelId).toBe("gpt-5.4")
    expect(usableModel.displayName).toBe("GPT-5.4")
    expect(usableModel.maxMode).toBe(false)
  })

  it("默认模型选择与 grouped model identity 保持一致", () => {
    const selection = resolveCursorDefaultSelection(
      BASE_CODEX_CURSOR_DISPLAY_MODELS.map((model) => ({
        name: model.name,
        family: model.family,
        isThinking: model.isThinking,
      })),
      ["gpt-5.4", "gpt-5", "gpt-5.2"]
    )

    expect(selection.model).toBe("gpt-5.4")
    expect(selection.thinkingModel).toBe("gpt-5.4")
    expect(selection.maxMode).toBe(false)
  })
})
