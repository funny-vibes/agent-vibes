import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Post,
  UseGuards,
} from "@nestjs/common"
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger"
import {
  ImageGenerationService,
  type ImageGenerationReference,
  type ImageGenerationResult,
} from "../../llm/image-generation/image-generation.service"
import {
  CODEX_IMAGE_MAX_REFERENCES,
  normalizeCodexImageBackground,
  type CodexImageBackground,
} from "../../llm/openai/codex-standalone-image"
import { RequiredApiKeyGuard } from "../../shared/required-api-key.guard"

const MAX_PROMPT_LENGTH = 4_000
const OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"])
const REFERENCE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
])
const DATA_URL_PATTERN = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i

function invalid(message: string, param: string): HttpException {
  return new HttpException(
    {
      error: { message, type: "invalid_request_error", param, code: null },
    },
    400
  )
}

interface ParsedImageRequest {
  prompt: string
  model?: string
  outputFormat: string
  background?: CodexImageBackground
}

/**
 * Validate the fields `generations` and `edits` share. A size is not passed
 * on, because an exact aspect ratio moves generation off Codex; the
 * provider's default shape is used.
 */
function parseImageRequest(body: unknown): ParsedImageRequest {
  const request =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const prompt = typeof request.prompt === "string" ? request.prompt.trim() : ""
  if (!prompt) throw invalid("prompt is required", "prompt")
  if (prompt.length > MAX_PROMPT_LENGTH)
    throw invalid(`prompt exceeds ${MAX_PROMPT_LENGTH} characters`, "prompt")
  if (request.n !== undefined && request.n !== 1)
    throw invalid("n must be 1", "n")
  if (
    request.response_format !== undefined &&
    request.response_format !== "b64_json"
  )
    throw invalid("response_format must be b64_json", "response_format")
  const outputFormat =
    typeof request.output_format === "string" &&
    OUTPUT_FORMATS.has(request.output_format)
      ? request.output_format
      : "png"
  let background: CodexImageBackground | undefined
  if (request.background !== undefined) {
    background = normalizeCodexImageBackground(request.background)
    if (!background)
      throw invalid(
        'background must be "transparent", "opaque" or "auto"',
        "background"
      )
  }
  return {
    prompt,
    ...(typeof request.model === "string" && request.model.trim()
      ? { model: request.model.trim() }
      : {}),
    outputFormat,
    ...(background ? { background } : {}),
  }
}

/**
 * Reference pictures travel inline as `data:` URLs, either as a string or as
 * `{ image_url }`, under `image` (one) and/or `images` (several). Remote
 * URLs are refused: the bridge never fetches on the caller's behalf.
 */
function parseReferenceImages(body: unknown): ImageGenerationReference[] {
  const request =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const raw: unknown[] = []
  if (request.image !== undefined) raw.push(request.image)
  if (request.images !== undefined) {
    if (!Array.isArray(request.images))
      throw invalid("images must be an array", "images")
    raw.push(...(request.images as unknown[]))
  }
  const references: ImageGenerationReference[] = []
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    const url =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? (entry as Record<string, unknown>).image_url
          : undefined
    if (typeof url !== "string")
      throw invalid(
        `image[${index}] must be a data URL string or { image_url }`,
        "image"
      )
    const match = DATA_URL_PATTERN.exec(url.trim())
    const mimeType = match?.[1]?.toLowerCase() ?? ""
    const payload = match?.[2] ?? ""
    if (!match)
      throw invalid(`image[${index}] must be a base64 data URL`, "image")
    if (!REFERENCE_MIME_TYPES.has(mimeType))
      throw invalid(`image[${index}] has unsupported type ${mimeType}`, "image")
    const data = payload.replace(/\s+/g, "")
    if (!data) throw invalid(`image[${index}] is empty`, "image")
    if (seen.has(url)) return
    seen.add(url)
    references.push({ path: `inline-reference-${index}`, mimeType, data })
  })
  if (references.length === 0)
    throw invalid("at least one reference image is required", "image")
  if (references.length > CODEX_IMAGE_MAX_REFERENCES)
    throw invalid(
      `at most ${CODEX_IMAGE_MAX_REFERENCES} reference images are accepted`,
      "image"
    )
  return references
}

function toOpenAiResponse(
  result: ImageGenerationResult,
  outputFormat: string
): Record<string, unknown> {
  return {
    created: Math.floor(Date.now() / 1000),
    output_format: result.mimeType?.split("/")[1] ?? outputFormat,
    ...(result.background ? { background: result.background } : {}),
    data: [
      {
        b64_json: result.imageData,
        ...(result.revisedPrompt
          ? { revised_prompt: result.revisedPrompt }
          : {}),
        ...(result.generationId ? { generation_id: result.generationId } : {}),
      },
    ],
  }
}

/**
 * Upstream failures answer 500, not 502: Cloudflare replaces an origin's
 * 502/504 body with its own error page, which would hide the provider's
 * message from callers reaching the bridge through a Worker or a proxied
 * zone.
 */
function toGatewayError(error: unknown): HttpException {
  return new HttpException(
    {
      error: {
        message:
          error instanceof Error ? error.message : "Image generation failed",
        type: "server_error",
        param: null,
        code: "image_generation_failed",
      },
    },
    500
  )
}

/**
 * OpenAI-compatible image generation over the pooled accounts: one picture
 * per request, returned inline as base64. `background: "transparent"` asks
 * Codex for genuine RGBA output; `edits` adds up to five inline reference
 * pictures.
 */
@ApiTags("OpenAI API")
@Controller("v1/images")
@UseGuards(RequiredApiKeyGuard)
@ApiSecurity("api-key")
export class ImagesController {
  constructor(private readonly images: ImageGenerationService) {}

  @Post("generations")
  @HttpCode(200)
  @ApiOperation({ summary: "Generate one image from a prompt (b64_json)" })
  async generate(@Body() body: unknown) {
    const request = parseImageRequest(body)
    try {
      const result = await this.images.generateImage(request)
      return toOpenAiResponse(result, request.outputFormat)
    } catch (error) {
      throw toGatewayError(error)
    }
  }

  @Post("edits")
  @HttpCode(200)
  @ApiOperation({
    summary: "Generate one image from a prompt and inline reference images",
  })
  async edit(@Body() body: unknown) {
    const request = parseImageRequest(body)
    const referenceImages = parseReferenceImages(body)
    try {
      const result = await this.images.generateImage({
        ...request,
        referenceImages,
      })
      return toOpenAiResponse(result, request.outputFormat)
    } catch (error) {
      throw toGatewayError(error)
    }
  }
}
