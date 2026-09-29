import { Injectable, Logger } from "@nestjs/common"
import { randomUUID } from "crypto"

export type ImageJobStatus = "queued" | "running" | "succeeded" | "failed"

export interface ImageJobError {
  message: string
  type: string
  code: string
}

export interface ImageJobRecord {
  id: string
  status: ImageJobStatus
  /** Unix seconds, OpenAI style. */
  created: number
  createdAtMs: number
  finishedAtMs?: number
  result?: Record<string, unknown>
  error?: ImageJobError
}

export interface ImageJobStoreOptions {
  /** Oldest finished jobs are dropped beyond this count. */
  maxJobs: number
  /** Finished jobs expire after this long. */
  ttlMs: number
  /** Jobs running at once; the rest wait in submission order. */
  concurrency: number
}

const DEFAULT_OPTIONS: ImageJobStoreOptions = {
  maxJobs: 64,
  ttlMs: 30 * 60 * 1000,
  concurrency: 3,
}

/**
 * In-memory queue for image requests that outlive a proxy's request timeout.
 * A caller submits the work, gets an id back at once, and polls until the
 * job settles. Results stay for `ttlMs` so a slow poller still collects them;
 * nothing is persisted across restarts.
 */
@Injectable()
export class ImageJobStore {
  private readonly logger = new Logger(ImageJobStore.name)
  private readonly jobs = new Map<string, ImageJobRecord>()
  private readonly waiting: Array<() => void> = []
  private running = 0
  private readonly options: ImageJobStoreOptions

  constructor(options: Partial<ImageJobStoreOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  submit(run: () => Promise<Record<string, unknown>>): ImageJobRecord {
    this.evict()
    const now = Date.now()
    const record: ImageJobRecord = {
      id: `imgjob_${randomUUID().replace(/-/g, "")}`,
      status: "queued",
      created: Math.floor(now / 1000),
      createdAtMs: now,
    }
    this.jobs.set(record.id, record)
    this.waiting.push(() => {
      record.status = "running"
      void run()
        .then((result) => {
          record.result = result
          record.status = "succeeded"
        })
        .catch((error: unknown) => {
          record.error = toJobError(error)
          record.status = "failed"
          this.logger.warn(
            `image job ${record.id} failed: ${record.error.message}`
          )
        })
        .finally(() => {
          record.finishedAtMs = Date.now()
          this.running -= 1
          this.pump()
        })
    })
    this.pump()
    return record
  }

  get(id: string): ImageJobRecord | undefined {
    this.evict()
    return this.jobs.get(id)
  }

  size(): number {
    return this.jobs.size
  }

  private pump(): void {
    while (this.running < this.options.concurrency && this.waiting.length > 0) {
      const next = this.waiting.shift()
      if (!next) break
      this.running += 1
      next()
    }
  }

  private evict(): void {
    const now = Date.now()
    for (const [id, record] of this.jobs) {
      if (
        record.finishedAtMs !== undefined &&
        now - record.finishedAtMs > this.options.ttlMs
      ) {
        this.jobs.delete(id)
      }
    }
    if (this.jobs.size <= this.options.maxJobs) return
    const finished = [...this.jobs.values()]
      .filter((record) => record.finishedAtMs !== undefined)
      .sort((a, b) => (a.finishedAtMs ?? 0) - (b.finishedAtMs ?? 0))
    for (const record of finished) {
      if (this.jobs.size <= this.options.maxJobs) break
      this.jobs.delete(record.id)
    }
  }
}

export function snapshotImageJob(
  record: ImageJobRecord
): Record<string, unknown> {
  return {
    id: record.id,
    object: "image.job",
    status: record.status,
    created: record.created,
    ...(record.status === "succeeded" && record.result ? record.result : {}),
    ...(record.status === "failed" && record.error
      ? { error: record.error }
      : {}),
  }
}

function toJobError(error: unknown): ImageJobError {
  if (
    error &&
    typeof error === "object" &&
    "getResponse" in error &&
    typeof (error as { getResponse: unknown }).getResponse === "function"
  ) {
    const body = (error as { getResponse: () => unknown }).getResponse()
    const nested =
      body && typeof body === "object"
        ? (body as { error?: Partial<ImageJobError> }).error
        : undefined
    if (nested && typeof nested.message === "string") {
      return {
        message: nested.message,
        type: nested.type ?? "server_error",
        code: nested.code ?? "image_generation_failed",
      }
    }
  }
  return {
    message: error instanceof Error ? error.message : "Image generation failed",
    type: "server_error",
    code: "image_generation_failed",
  }
}
