import assert from "node:assert/strict"
import { test } from "node:test"
import { HttpException, Logger } from "@nestjs/common"
import type { GoogleService } from "../src/llm/google/google.service"
import type { CodexService } from "../src/llm/openai/codex.service"
import { createCodexRootProviderIdentity } from "../src/llm/openai/codex-provider-identity"
import {
  CODEX_IMAGE_MAX_REFERENCES,
  CODEX_IMAGE_MODEL,
  buildCodexStandaloneImageRequest,
  decodeCodexStandaloneImageResponse,
  normalizeCodexImageBackground,
} from "../src/llm/openai/codex-standalone-image"
import {
  ImageGenerationService,
  type ImageGenerationInput,
} from "../src/llm/image-generation/image-generation.service"
import { ImagesController } from "../src/protocol/openai/images.controller"

Logger.overrideLogger(false)

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo="
const JPEG_DATA_URL = "data:image/jpeg;base64,/9j/4AAQ"

function identity() {
  return createCodexRootProviderIdentity()
}

void test("standalone image request: generations without references, edits with them", () => {
  const generation = buildCodexStandaloneImageRequest({
    prompt: "  a studio chair  ",
    model: "gpt-5",
    conversationId: "conv-1",
    upstreamIdentity: identity(),
  })
  assert.equal(generation.endpoint, "images/generations")
  assert.equal(generation.localProjectionKey, "conv-1")
  assert.deepEqual(generation.body, {
    prompt: "a studio chair",
    background: "opaque",
    model: CODEX_IMAGE_MODEL,
    quality: "auto",
    size: "auto",
  })

  const edit = buildCodexStandaloneImageRequest({
    prompt: "the same chair, transparent",
    model: "gpt-5",
    conversationId: "conv-2",
    upstreamIdentity: identity(),
    background: "transparent",
    referenceImages: [
      { mimeType: "image/png", data: "AAAA" },
      { mimeType: "", data: "  " },
      { mimeType: "image/jpeg", data: "BBBB" },
    ],
  })
  assert.equal(edit.endpoint, "images/edits")
  assert.equal(edit.body.background, "transparent")
  assert.deepEqual(edit.body.images, [
    { image_url: "data:image/png;base64,AAAA" },
    { image_url: "data:image/jpeg;base64,BBBB" },
  ])
})

void test("standalone image request refuses an empty prompt and too many references", () => {
  assert.throws(
    () =>
      buildCodexStandaloneImageRequest({
        prompt: "   ",
        model: "gpt-5",
        conversationId: "conv",
        upstreamIdentity: identity(),
      }),
    /prompt is required/
  )
  const references = Array.from(
    { length: CODEX_IMAGE_MAX_REFERENCES + 1 },
    (_, index) => ({ mimeType: "image/png", data: `ref-${index}` })
  )
  assert.throws(
    () =>
      buildCodexStandaloneImageRequest({
        prompt: "too many",
        model: "gpt-5",
        conversationId: "conv",
        upstreamIdentity: identity(),
        referenceImages: references,
      }),
    new RegExp(`at most ${CODEX_IMAGE_MAX_REFERENCES}`)
  )
})

void test("standalone image response decoding", () => {
  const decoded = decodeCodexStandaloneImageResponse({
    background: "transparent",
    data: [
      {
        b64_json: " QUJD ",
        generation_id: "gen-1",
        revised_prompt: "a chair",
      },
    ],
  })
  assert.deepEqual(decoded, {
    imageData: "QUJD",
    background: "transparent",
    generationId: "gen-1",
    revisedPrompt: "a chair",
  })
  assert.throws(
    () => decodeCodexStandaloneImageResponse({ data: [] }),
    /non-empty array/
  )
  assert.throws(
    () => decodeCodexStandaloneImageResponse({ data: [{ b64_json: "" }] }),
    /b64_json/
  )
  assert.throws(() => decodeCodexStandaloneImageResponse("nope"), /object/)
})

void test("background normalisation accepts booleans and the three names", () => {
  assert.equal(normalizeCodexImageBackground(true), "transparent")
  assert.equal(normalizeCodexImageBackground(false), "opaque")
  assert.equal(normalizeCodexImageBackground("auto"), "auto")
  assert.equal(normalizeCodexImageBackground("opaque"), "opaque")
  assert.equal(normalizeCodexImageBackground("glass"), undefined)
  assert.equal(normalizeCodexImageBackground(3), undefined)
})

interface Fixture {
  service: ImageGenerationService
  codexInputs: Array<Record<string, unknown>>
  geminiInputs: Array<Record<string, unknown>>
}

function fixture(options: { codexFails?: boolean } = {}): Fixture {
  const codexInputs: Array<Record<string, unknown>> = []
  const geminiInputs: Array<Record<string, unknown>> = []
  const codex = {
    generateImage: (input: Record<string, unknown>) => {
      codexInputs.push(input)
      if (options.codexFails) {
        return Promise.reject(new Error("codex fixture down"))
      }
      return Promise.resolve({
        imageData: "codex-image",
        status: "completed",
        background: input.background ?? "opaque",
        generationId: "gen-codex",
      })
    },
  } as unknown as CodexService
  const google = {
    generateImage: (input: Record<string, unknown>) => {
      geminiInputs.push(input)
      return Promise.resolve({
        imageData: "gemini-image",
        mimeType: "image/png",
      })
    },
  } as unknown as GoogleService
  return {
    service: new ImageGenerationService(codex, google),
    codexInputs,
    geminiInputs,
  }
}

function references(count: number): ImageGenerationInput["referenceImages"] {
  return Array.from({ length: count }, (_, index) => ({
    path: `inline-reference-${index}`,
    mimeType: "image/png",
    data: `ref-${index}`,
  }))
}

void test("a transparent background routes to Codex only and carries the references", async () => {
  const f = fixture()
  const result = await f.service.generateImage({
    prompt: "chair layer",
    background: "transparent",
    referenceImages: references(2),
  })
  assert.equal(result.provider, "codex")
  assert.equal(result.mimeType, "image/png")
  assert.equal(result.background, "transparent")
  assert.equal(result.generationId, "gen-codex")
  assert.equal(f.geminiInputs.length, 0)
  assert.equal(f.codexInputs.length, 1)
  assert.equal(f.codexInputs[0]?.background, "transparent")
  assert.deepEqual(f.codexInputs[0]?.referenceImages, [
    { mimeType: "image/png", data: "ref-0" },
    { mimeType: "image/png", data: "ref-1" },
  ])
})

void test("a transparent request never falls back to Gemini", async () => {
  const f = fixture({ codexFails: true })
  await assert.rejects(
    f.service.generateImage({ prompt: "alpha", background: "transparent" }),
    /codex fixture down/
  )
  assert.equal(f.geminiInputs.length, 0)
})

void test("references within the Codex budget try Codex first and fall back to Gemini", async () => {
  const f = fixture({ codexFails: true })
  const result = await f.service.generateImage({
    prompt: "desk layer",
    referenceImages: references(CODEX_IMAGE_MAX_REFERENCES),
  })
  assert.equal(result.provider, "gemini")
  assert.equal(f.codexInputs.length, 1)
  assert.equal(
    (f.codexInputs[0]?.referenceImages as unknown[]).length,
    CODEX_IMAGE_MAX_REFERENCES
  )
  assert.equal(f.geminiInputs.length, 1)
  assert.equal((f.geminiInputs[0]?.referenceImages as unknown[]).length, 3)
})

void test("more references than Codex accepts go straight to Gemini", async () => {
  const f = fixture()
  const result = await f.service.generateImage({
    prompt: "collage",
    referenceImages: references(CODEX_IMAGE_MAX_REFERENCES + 1),
  })
  assert.equal(result.provider, "gemini")
  assert.equal(f.codexInputs.length, 0)
})

void test("an exact aspect ratio still stays on Gemini and a gemini model hint leads with Gemini", async () => {
  const ratio = fixture()
  await ratio.service.generateImage({ prompt: "wide", aspectRatio: "16:9" })
  assert.equal(ratio.codexInputs.length, 0)
  assert.equal(ratio.geminiInputs.length, 1)

  const hinted = fixture()
  await hinted.service.generateImage({
    prompt: "wide",
    model: "gemini-image-fixture",
  })
  assert.equal(hinted.codexInputs.length, 0)
  assert.equal(hinted.geminiInputs.length, 1)

  const plain = fixture()
  const result = await plain.service.generateImage({ prompt: "plain" })
  assert.equal(result.provider, "codex")
  assert.deepEqual(plain.codexInputs[0]?.referenceImages, [])
})

void test("POST /v1/images/edits decodes inline data URLs and reports background and generation id", async () => {
  const f = fixture()
  const controller = new ImagesController(f.service)
  const response = await controller.edit({
    prompt: "the chair behind the seat",
    background: true,
    image: PNG_DATA_URL,
    images: [{ image_url: JPEG_DATA_URL }, PNG_DATA_URL],
    output_format: "png",
  })
  assert.equal(response.background, "transparent")
  assert.equal(response.output_format, "png")
  const data = response.data as Array<Record<string, unknown>>
  assert.equal(data[0]?.b64_json, "codex-image")
  assert.equal(data[0]?.generation_id, "gen-codex")
  const sent = f.codexInputs[0]?.referenceImages as Array<
    Record<string, string>
  >
  assert.deepEqual(
    sent.map((reference) => reference.mimeType),
    ["image/png", "image/jpeg"]
  )
  assert.equal(sent[0]?.data, "iVBORw0KGgo=")
})

void test("POST /v1/images/edits rejects missing, remote or oversized reference sets", async () => {
  const controller = new ImagesController(fixture().service)
  const status = async (body: unknown): Promise<number> => {
    try {
      await controller.edit(body)
    } catch (error) {
      assert.ok(error instanceof HttpException)
      return error.getStatus()
    }
    return 200
  }
  assert.equal(await status({ prompt: "no picture" }), 400)
  assert.equal(
    await status({ prompt: "remote", image: "https://example.com/a.png" }),
    400
  )
  assert.equal(
    await status({
      prompt: "svg",
      image: "data:image/svg+xml;base64,PHN2Zz4=",
    }),
    400
  )
  assert.equal(
    await status({
      prompt: "too many",
      images: Array.from(
        { length: CODEX_IMAGE_MAX_REFERENCES + 1 },
        (_, index) => `data:image/png;base64,QUJD${index}`
      ),
    }),
    400
  )
  assert.equal(await status({ prompt: "", image: PNG_DATA_URL }), 400)
})

void test("POST /v1/images/generations validates background and maps provider failures to 502", async () => {
  const ok = fixture()
  const okController = new ImagesController(ok.service)
  const response = await okController.generate({
    prompt: "opaque plate",
    background: "opaque",
  })
  assert.equal(response.background, "opaque")
  assert.equal(ok.codexInputs[0]?.background, "opaque")

  await assert.rejects(
    okController.generate({ prompt: "x", background: "glass" }),
    (error: unknown) =>
      error instanceof HttpException && error.getStatus() === 400
  )

  const failing = fixture({ codexFails: true })
  Object.assign(failing.service, {
    googleService: {
      generateImage: () => Promise.reject(new Error("gemini fixture down")),
    },
  })
  await assert.rejects(
    new ImagesController(failing.service).generate({ prompt: "x" }),
    (error: unknown) =>
      error instanceof HttpException && error.getStatus() === 502
  )
})
