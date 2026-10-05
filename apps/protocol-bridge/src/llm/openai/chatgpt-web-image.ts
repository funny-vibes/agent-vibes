/**
 * Reading an image out of an OpenAI-shaped request, for the ChatGPT Web path.
 *
 * Upstream accepts no inline bytes: an image is uploaded to the account's
 * file store first and named from the message afterwards. So the bytes are
 * carried decoded, and the pixel size travels with them — the asset pointer
 * the message has to build is rejected without `width` and `height`, and the
 * only place those can be read is the bytes themselves.
 *
 * Nothing here throws. A part that cannot be delivered comes back as a
 * reason, because the caller is the one that knows how to turn a reason into
 * the error its protocol surface speaks.
 */

export interface ChatGptWebImage {
  readonly bytes: Uint8Array
  readonly mimeType: string
  readonly fileName: string
  readonly width: number
  readonly height: number
}

export type ChatGptWebImageRead =
  | { readonly ok: true; readonly image: ChatGptWebImage }
  | { readonly ok: false; readonly reason: string }

/** What the web composer itself offers, and what upstream renders. */
const SUPPORTED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
])

/**
 * Turn an `image_url` into bytes the upload flow can carry.
 *
 * Only a `data:` URL is accepted. A remote URL would mean this bridge
 * fetching an address the caller chose and posting whatever came back to the
 * account's file store, which is a different feature with a different blast
 * radius — saying so is better than half-doing it.
 */
export function readImageUrl(url: string, index: number): ChatGptWebImageRead {
  const trimmed = url.trim()
  if (!trimmed) return { ok: false, reason: "the image_url was empty" }
  if (!trimmed.startsWith("data:")) {
    return {
      ok: false,
      reason:
        "ChatGPT Web has to be handed the bytes, and this bridge does not " +
        "fetch images by URL — send the image as a data: URL instead",
    }
  }

  const comma = trimmed.indexOf(",")
  const header = comma < 0 ? "" : trimmed.slice(5, comma)
  if (comma < 0 || !header.includes(";base64")) {
    return {
      ok: false,
      reason: "only a base64 data: URL can be decoded (data:<mime>;base64,…)",
    }
  }

  const mimeType = header.slice(0, header.indexOf(";")).trim().toLowerCase()
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    return {
      ok: false,
      reason:
        `ChatGPT Web does not take ${mimeType || "an image without a media type"}; ` +
        `it accepts ${[...SUPPORTED_MIME_TYPES].join(", ")}`,
    }
  }

  const bytes = Buffer.from(trimmed.slice(comma + 1), "base64")
  if (bytes.byteLength === 0) {
    return { ok: false, reason: "the base64 payload decoded to no bytes" }
  }

  const size = imageSize(bytes)
  if (!size) {
    return {
      ok: false,
      reason:
        `the ${mimeType} payload could not be read as an image — upstream ` +
        "refuses an attachment whose pixel size is unknown",
    }
  }

  return {
    ok: true,
    image: {
      bytes,
      mimeType,
      // Upstream shows this name in the thread, and a conversation opened by
      // hand in the web UI is easier to read when it says where the image
      // came from than when every one of them is a bare uuid.
      fileName: `image-${index + 1}${extensionFor(mimeType)}`,
      width: size.width,
      height: size.height,
    },
  }
}

function extensionFor(mimeType: string): string {
  return mimeType === "image/jpeg"
    ? ".jpg"
    : `.${mimeType.slice("image/".length)}`
}

/**
 * Pixel size straight out of the header bytes.
 *
 * Decoding the whole image would mean a native dependency for a number that
 * sits in the first few dozen bytes of every format upstream accepts.
 */
function imageSize(bytes: Buffer): { width: number; height: number } | null {
  return pngSize(bytes) ?? gifSize(bytes) ?? webpSize(bytes) ?? jpegSize(bytes)
}

function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null
  if (bytes.readUInt32BE(0) !== 0x89504e47) return null
  // IHDR is mandated to be the first chunk, so width/height sit at a fixed
  // offset rather than needing a chunk walk.
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function gifSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.byteLength < 10) return null
  if (bytes.toString("ascii", 0, 3) !== "GIF") return null
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
}

function webpSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.byteLength < 30) return null
  if (bytes.toString("ascii", 0, 4) !== "RIFF") return null
  if (bytes.toString("ascii", 8, 12) !== "WEBP") return null
  const chunk = bytes.toString("ascii", 12, 16)
  if (chunk === "VP8 ") {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    }
  }
  if (chunk === "VP8L") {
    const packed = bytes.readUInt32LE(21)
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >> 14) & 0x3fff) + 1,
    }
  }
  if (chunk === "VP8X") {
    return {
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1,
    }
  }
  return null
}

function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.byteLength < 4 || bytes.readUInt16BE(0) !== 0xffd8) return null
  let offset = 2
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]!
    // SOFn carries the frame header; the four that share the 0xC0 range but
    // are not frames (DHT, JPG, DAC, RSTn) have to be stepped over.
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    if (isFrame) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      }
    }
    offset += 2 + bytes.readUInt16BE(offset + 2)
  }
  return null
}
