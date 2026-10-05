import {
  GptRequestError,
  resolveGptHistoryPolicy,
  type GptHistoryPolicy,
} from "../shared/gpt-api-contract"
import { Injectable, Logger } from "@nestjs/common"
import * as fs from "fs/promises"
import * as path from "path"
import { GoogleService } from "../google/google.service"
import { CodexService } from "../openai/codex.service"
import { ChatGptWebConversationService } from "../openai/chatgpt-web-conversation.service"
import { readImageUrl } from "../openai/chatgpt-web-image"
import {
  CODEX_IMAGE_MAX_REFERENCES,
  CODEX_IMAGE_MODEL,
  type CodexImageBackground,
} from "../openai/codex-standalone-image"
import { normalizeImageAspectRatio } from "./image-aspect-ratio"

/** Gemini's inline reference budget; Codex edits take CODEX_IMAGE_MAX_REFERENCES. */
const GEMINI_IMAGE_MAX_REFERENCES = 3

export type ImageGenerationProvider = "codex" | "gemini" | "chatgpt-web"

export interface ImageGenerationReference {
  path: string
  mimeType: string
  data: string
}

export interface ImageGenerationInput {
  prompt: string
  provider?: ImageGenerationProvider
  /** Web image tools need a saved conversation, deleted after download. */
  allowTemporaryHistory?: boolean
  historyPolicy?: GptHistoryPolicy
  model?: string
  conversationId?: string
  outputFormat?: string
  aspectRatio?: string
  /** Only Codex honours it: "transparent" yields genuine RGBA PNG output. */
  background?: CodexImageBackground
  referenceImagePaths?: string[]
  referenceImages?: ImageGenerationReference[]
}

export interface ImageGenerationResult {
  imageData: string
  revisedPrompt?: string
  status?: string
  provider: ImageGenerationProvider
  mimeType?: string
  background?: CodexImageBackground
  generationId?: string
}

@Injectable()
export class ImageGenerationService {
  private readonly logger = new Logger(ImageGenerationService.name)

  constructor(
    private readonly codexService: CodexService,
    private readonly googleService: GoogleService,
    private readonly chatGptWeb: ChatGptWebConversationService
  ) {}

  async generateImage(
    input: ImageGenerationInput
  ): Promise<ImageGenerationResult> {
    const prompt = input.prompt.trim()
    if (!prompt) {
      throw new Error("Image generation prompt is required")
    }
    const request = {
      ...input,
      prompt,
      aspectRatio: normalizeImageAspectRatio(input.aspectRatio),
    }

    // An explicit provider is a routing contract, not a fallback preference.
    if (request.provider === "chatgpt-web")
      return this.generateWithChatGptWeb(request)
    if (request.provider === "codex") {
      if (request.aspectRatio)
        throw new Error("Codex images do not support an exact aspect ratio")
      return this.generateWithCodex(request)
    }
    if (request.provider === "gemini") {
      if (request.background === "transparent")
        throw new Error(
          "Transparent backgrounds require the Codex image provider"
        )
      return this.generateWithGemini(request)
    }

    let lastError: unknown
    for (const provider of this.resolveProviderOrder(request)) {
      try {
        return provider === "gemini"
          ? await this.generateWithGemini(request)
          : await this.generateWithCodex(request)
      } catch (error) {
        lastError = error
        const normalized = this.toError(error)
        this.logger.warn(
          `${provider} image generation failed${
            provider === "codex" ? "; trying next provider" : ""
          }: ${normalized.message}`
        )
      }
    }

    throw lastError
  }

  private resolveProviderOrder(
    input: ImageGenerationInput
  ): ImageGenerationProvider[] {
    // Do not silently drop an exact aspect ratio during provider fallback;
    // Codex draws only its own shapes.
    if (input.aspectRatio) {
      return ["gemini"]
    }
    // Only Codex can return a genuinely transparent picture.
    if (input.background === "transparent") {
      return ["codex"]
    }
    // Codex edits carry up to CODEX_IMAGE_MAX_REFERENCES references; beyond
    // that only Gemini (with its own smaller budget) remains.
    const referenceCount =
      (input.referenceImages?.length || 0) +
      (input.referenceImagePaths?.length || 0)
    if (referenceCount > CODEX_IMAGE_MAX_REFERENCES) {
      return ["gemini"]
    }

    const normalized = input.model?.trim().toLowerCase() || ""
    if (normalized.includes("gemini")) {
      return ["gemini", "codex"]
    }
    return ["codex", "gemini"]
  }

  private async generateWithChatGptWeb(
    input: ImageGenerationInput
  ): Promise<ImageGenerationResult> {
    resolveGptHistoryPolicy(
      {
        history_policy: input.historyPolicy,
        allow_temporary_history: input.allowTemporaryHistory,
      },
      true
    )
    if (input.outputFormat && input.outputFormat !== "png")
      throw new GptRequestError(
        "ChatGPT Web images return PNG; output_format must be png",
        "output_format"
      )
    if (input.background && input.background !== "auto") {
      throw new Error("ChatGPT Web images support only background: auto")
    }
    if (input.aspectRatio) {
      throw new Error("ChatGPT Web images do not support an exact aspect ratio")
    }
    const count =
      (input.referenceImages?.length ?? 0) +
      (input.referenceImagePaths?.length ?? 0)
    if (count > CODEX_IMAGE_MAX_REFERENCES) {
      throw new Error(
        `At most ${CODEX_IMAGE_MAX_REFERENCES} reference images are accepted`
      )
    }
    const references = await this.collectReferenceImages(
      input,
      CODEX_IMAGE_MAX_REFERENCES
    )
    const images = references.map((reference, index) => {
      const parsed = readImageUrl(
        `data:${reference.mimeType};base64,${reference.data}`,
        index
      )
      if (!parsed.ok) throw new Error(parsed.reason)
      return parsed.image
    })
    const result = await this.chatGptWeb.generateImage({
      model: input.model || "gpt-5-5",
      prompt: input.prompt,
      images,
      signal: AbortSignal.timeout(5 * 60 * 1000),
    })
    return {
      imageData: Buffer.from(result.bytes).toString("base64"),
      mimeType: result.mimeType,
      provider: "chatgpt-web",
    }
  }

  private async generateWithCodex(
    input: ImageGenerationInput
  ): Promise<ImageGenerationResult> {
    if (input.outputFormat && input.outputFormat !== "png")
      throw new GptRequestError(
        "Codex images return PNG; output_format must be png",
        "output_format"
      )
    const model = input.model?.trim()
    if (
      model &&
      model !== CODEX_IMAGE_MODEL &&
      !this.codexService.supportsModel(model)
    ) {
      throw new GptRequestError(
        `Unsupported Codex image model: ${model}`,
        "model"
      )
    }
    const references = await this.collectReferenceImages(
      input,
      CODEX_IMAGE_MAX_REFERENCES
    )
    const result = await this.codexService.generateImage({
      prompt: input.prompt,
      model: input.model,
      conversationId: input.conversationId,
      background: input.background,
      referenceImages: references.map((reference) => ({
        mimeType: reference.mimeType,
        data: reference.data,
      })),
    })
    // The standalone Codex image endpoint always answers with PNG data; a
    // requested jpeg/webp is not transcoded here.
    return {
      ...result,
      provider: "codex",
      mimeType: "image/png",
    }
  }

  private async generateWithGemini(
    input: ImageGenerationInput
  ): Promise<ImageGenerationResult> {
    const references = await this.collectReferenceImages(
      input,
      GEMINI_IMAGE_MAX_REFERENCES
    )
    const result = await this.googleService.generateImage({
      prompt: input.prompt,
      model: input.model,
      conversationId: input.conversationId,
      outputFormat: input.outputFormat,
      referenceImages: references,
      aspectRatio: input.aspectRatio,
    })
    return {
      ...result,
      provider: "gemini",
    }
  }

  /** Inline references first, then admitted paths, capped per provider. */
  private async collectReferenceImages(
    input: ImageGenerationInput,
    limit: number
  ): Promise<ImageGenerationReference[]> {
    const count =
      (input.referenceImages?.length ?? 0) +
      (input.referenceImagePaths?.length ?? 0)
    if (count > limit)
      throw new GptRequestError(
        `This provider accepts at most ${limit} reference images`,
        "image"
      )
    const inline = input.referenceImages || []
    const remaining = Math.max(0, limit - inline.length)
    const pathReferences =
      remaining > 0
        ? await this.loadReferenceImages(
            input.referenceImagePaths || [],
            remaining
          )
        : []
    return [...inline, ...pathReferences]
  }

  private async loadReferenceImages(
    referenceImagePaths: string[],
    limit: number
  ): Promise<ImageGenerationReference[]> {
    const normalized = referenceImagePaths
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .slice(0, limit)

    const references: ImageGenerationReference[] = []
    for (const referencePath of normalized) {
      if (!path.isAbsolute(referencePath)) {
        throw new Error(
          "Image reference paths must be admitted absolute filesystem paths"
        )
      }
      const absolutePath = path.resolve(referencePath)
      const data = await fs.readFile(absolutePath)
      references.push({
        path: absolutePath,
        mimeType: this.inferMimeType(absolutePath),
        data: data.toString("base64"),
      })
    }
    return references
  }

  private inferMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    switch (ext) {
      case ".jpg":
      case ".jpeg":
        return "image/jpeg"
      case ".webp":
        return "image/webp"
      case ".gif":
        return "image/gif"
      case ".png":
      default:
        return "image/png"
    }
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
  }
}
