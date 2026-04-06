import * as fs from "fs"
import * as path from "path"

export interface ChatGptRegisterInput {
  apiUrl: string
  adminToken: string
  customAuth?: string
  domain?: string
  domains?: string[]
  enabledDomains?: string[]
  subdomain?: string
  randomSubdomain?: boolean
  fingerprint?: string
  proxyUrl?: string
  password?: string
}

export interface ChatGptRegisterResult {
  account: Record<string, string>
  metadata?: Record<string, unknown>
  logs: string[]
}

type ChatGptRegisterModule = {
  registerChatGpt: (
    input: ChatGptRegisterInput,
    onLog?: (line: string) => void
  ) => Promise<ChatGptRegisterResult>
}

export class ChatGptRegisterService {
  constructor(private readonly extensionRootPath: string) {}

  async register(
    input: ChatGptRegisterInput,
    onLog?: (line: string) => void
  ): Promise<ChatGptRegisterResult> {
    const modulePath = this.resolveModulePath()
    const registerChatGpt = this.loadRegisterFunction(modulePath)
    return registerChatGpt(input, onLog)
  }

  private resolveModulePath(): string {
    const candidates = [
      path.resolve(
        this.extensionRootPath,
        "..",
        "chatgpt-register",
        "dist",
        "index.cjs"
      ),
      path.resolve(
        this.extensionRootPath,
        "chatgpt-register",
        "dist",
        "index.cjs"
      ),
    ]

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }

    throw new Error(
      `ChatGPT register app build artifact not found. Checked: ${candidates.join(
        ", "
      )}. Run 'npm --workspace apps/chatgpt-register run build' first.`
    )
  }

  private loadRegisterFunction(
    modulePath: string
  ): ChatGptRegisterModule["registerChatGpt"] {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require(modulePath) as Partial<ChatGptRegisterModule>
    if (typeof loaded.registerChatGpt !== "function") {
      throw new Error(
        `Invalid ChatGPT register module: ${modulePath} does not export registerChatGpt(...)`
      )
    }
    return loaded.registerChatGpt.bind(loaded)
  }
}
