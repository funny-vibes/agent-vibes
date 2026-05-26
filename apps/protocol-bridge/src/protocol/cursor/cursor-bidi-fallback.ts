type QueueReadResult =
  | { kind: "item"; value: Buffer }
  | { kind: "closed" }
  | { kind: "timeout" }

interface QueueWaiter {
  resolve: (result: QueueReadResult) => void
  reject: (error: Error) => void
  timer?: NodeJS.Timeout
}

export interface CursorBidiPollFrame {
  seqno: bigint
  frame?: Buffer
  eof?: boolean
}

export type CursorBidiRunFactory = (
  input: AsyncIterable<Buffer>
) => AsyncIterable<Buffer>

class AsyncBufferQueue implements AsyncIterable<Buffer> {
  private readonly items: Buffer[] = []
  private readonly waiters: QueueWaiter[] = []
  private closed = false
  private error: Error | undefined

  push(item: Buffer): void {
    if (this.closed || this.error) {
      return
    }

    const waiter = this.waiters.shift()
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve({ kind: "item", value: item })
      return
    }

    this.items.push(item)
  }

  close(): void {
    if (this.closed) {
      return
    }

    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve({ kind: "closed" })
    }
  }

  fail(error: Error): void {
    if (this.error) {
      return
    }

    this.error = error
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  async read(timeoutMs?: number): Promise<QueueReadResult> {
    if (this.items.length > 0) {
      return { kind: "item", value: this.items.shift()! }
    }

    if (this.error) {
      throw this.error
    }

    if (this.closed) {
      return { kind: "closed" }
    }

    if (timeoutMs === 0) {
      return { kind: "timeout" }
    }

    return new Promise<QueueReadResult>((resolve, reject) => {
      const waiter: QueueWaiter = { resolve, reject }
      if (timeoutMs != null) {
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) {
            this.waiters.splice(index, 1)
          }
          resolve({ kind: "timeout" })
        }, timeoutMs)
        waiter.timer.unref?.()
      }
      this.waiters.push(waiter)
    })
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return {
      next: async (): Promise<IteratorResult<Buffer>> => {
        const result = await this.read()
        if (result.kind === "item") {
          return { done: false, value: result.value }
        }
        return { done: true, value: undefined }
      },
      return: (): Promise<IteratorResult<Buffer>> => {
        this.close()
        return Promise.resolve({ done: true, value: undefined })
      },
    }
  }
}

export class CursorBidiFallbackSession {
  private readonly inputQueue = new AsyncBufferQueue()
  private readonly outputQueue = new AsyncBufferQueue()
  private readonly pendingInputs = new Map<bigint, Buffer>()
  private nextInputSeqno = 0n
  private nextOutputSeqno = 0n
  private runStarted = false
  private disposed = false

  lastTouchedAt = Date.now()

  constructor(readonly requestId: string) {}

  append(seqno: bigint, payload: Buffer): void {
    this.touch()

    if (this.disposed || seqno < this.nextInputSeqno) {
      return
    }

    this.pendingInputs.set(seqno, payload)

    while (true) {
      const next = this.pendingInputs.get(this.nextInputSeqno)
      if (!next) {
        break
      }

      this.pendingInputs.delete(this.nextInputSeqno)
      this.nextInputSeqno += 1n
      this.inputQueue.push(next)
    }
  }

  start(runFactory: CursorBidiRunFactory): void {
    this.touch()

    if (this.runStarted || this.disposed) {
      return
    }

    this.runStarted = true
    void this.run(runFactory)
  }

  async *streamFrames(): AsyncGenerator<Buffer> {
    this.touch()

    for await (const frame of this.outputQueue) {
      this.touch()
      yield frame
    }
  }

  async nextPollFrames(
    waitMs: number,
    maxFrames: number
  ): Promise<CursorBidiPollFrame[]> {
    this.touch()

    const frames: CursorBidiPollFrame[] = []
    const first = await this.outputQueue.read(waitMs)
    this.collectPollFrame(first, frames)

    while (
      frames.length > 0 &&
      !frames[frames.length - 1]?.eof &&
      frames.length < maxFrames
    ) {
      const next = await this.outputQueue.read(0)
      if (next.kind === "timeout") {
        break
      }
      this.collectPollFrame(next, frames)
    }

    return frames
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.inputQueue.close()
    this.outputQueue.close()
    this.pendingInputs.clear()
    this.touch()
  }

  private collectPollFrame(
    result: QueueReadResult,
    frames: CursorBidiPollFrame[]
  ): void {
    if (result.kind === "timeout") {
      return
    }

    if (result.kind === "closed") {
      frames.push({ seqno: this.nextOutputSeqno, eof: true })
      return
    }

    frames.push({
      seqno: this.nextOutputSeqno,
      frame: result.value,
    })
    this.nextOutputSeqno += 1n
  }

  private async run(runFactory: CursorBidiRunFactory): Promise<void> {
    try {
      for await (const frame of runFactory(this.inputQueue)) {
        this.touch()
        this.outputQueue.push(frame)
      }
      this.outputQueue.close()
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error))
      this.outputQueue.fail(wrapped)
    } finally {
      this.inputQueue.close()
      this.touch()
    }
  }

  private touch(): void {
    this.lastTouchedAt = Date.now()
  }
}

export class CursorBidiFallbackCoordinator {
  private readonly sessions = new Map<string, CursorBidiFallbackSession>()

  constructor(private readonly ttlMs = 10 * 60 * 1000) {}

  getOrCreate(requestId: string): CursorBidiFallbackSession {
    this.cleanupExpired()

    const existing = this.sessions.get(requestId)
    if (existing) {
      return existing
    }

    const session = new CursorBidiFallbackSession(requestId)
    this.sessions.set(requestId, session)
    return session
  }

  delete(requestId: string): void {
    const session = this.sessions.get(requestId)
    if (!session) {
      return
    }

    session.dispose()
    this.sessions.delete(requestId)
  }

  cleanupExpired(now = Date.now()): void {
    for (const [requestId, session] of this.sessions) {
      if (now - session.lastTouchedAt > this.ttlMs) {
        session.dispose()
        this.sessions.delete(requestId)
      }
    }
  }
}
