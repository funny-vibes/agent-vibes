import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Post,
  UseGuards,
} from "@nestjs/common"
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger"
import { ImageGenerationService } from "../../llm/image-generation/image-generation.service"
import { RequiredApiKeyGuard } from "../../shared/required-api-key.guard"

const MAX_PROMPT_LENGTH = 4_000
const OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"])

function invalid(message: string, param: string): HttpException {
  return new HttpException(
    {
      error: { message, type: "invalid_request_error", param, code: null },
    },
    400
  )
}

/**
 * OpenAI-compatible image generation over the pooled accounts: one picture
 * per request, returned inline as base64. A size is not passed on, because
 * an exact aspect ratio moves generation off Codex; the provider's default
 * shape is used.
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
    const request =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const prompt =
      typeof request.prompt === "string" ? request.prompt.trim() : ""
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

    try {
      const result = await this.images.generateImage({
        prompt,
        ...(typeof request.model === "string" && request.model.trim()
          ? { model: request.model.trim() }
          : {}),
        outputFormat,
      })
      return {
        created: Math.floor(Date.now() / 1000),
        output_format: result.mimeType?.split("/")[1] ?? outputFormat,
        data: [
          {
            b64_json: result.imageData,
            ...(result.revisedPrompt
              ? { revised_prompt: result.revisedPrompt }
              : {}),
          },
        ],
      }
    } catch (error) {
      throw new HttpException(
        {
          error: {
            message:
              error instanceof Error
                ? error.message
                : "Image generation failed",
            type: "api_error",
            param: null,
            code: "image_generation_failed",
          },
        },
        502
      )
    }
  }
}
