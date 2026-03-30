export class BackendApiError extends Error {
  readonly backend: string
  readonly statusCode?: number
  readonly retryAfterSeconds?: number
  readonly permanent: boolean

  constructor(
    message: string,
    options: {
      backend: string
      statusCode?: number
      retryAfterSeconds?: number
      permanent?: boolean
    }
  ) {
    super(message)
    this.name = "BackendApiError"
    this.backend = options.backend
    this.statusCode = options.statusCode
    this.retryAfterSeconds = options.retryAfterSeconds
    this.permanent = options.permanent ?? false
  }
}

export class BackendAccountPoolUnavailableError extends Error {
  readonly backend: string
  readonly retryAfterSeconds?: number
  readonly disabledCount: number
  readonly coolingCount: number
  readonly permanent: boolean

  constructor(
    message: string,
    options: {
      backend: string
      retryAfterSeconds?: number
      disabledCount?: number
      coolingCount?: number
      permanent?: boolean
    }
  ) {
    super(message)
    this.name = "BackendAccountPoolUnavailableError"
    this.backend = options.backend
    this.retryAfterSeconds = options.retryAfterSeconds
    this.disabledCount = options.disabledCount ?? 0
    this.coolingCount = options.coolingCount ?? 0
    this.permanent = options.permanent ?? false
  }
}
