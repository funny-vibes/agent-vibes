import { createWriteStream, promises as fs } from "fs"
import { IncomingMessage } from "http"
import * as https from "https"
import * as os from "os"
import * as path from "path"
import { pipeline } from "stream/promises"
import * as vscode from "vscode"
import {
  DEFAULTS,
  EXTENSION_DISPLAY_NAME,
  GITHUB_RELEASES_API_URL,
  GITHUB_RELEASES_URL,
} from "../constants"
import { logger } from "../utils/logger"
import { getPlatformTarget } from "../utils/platform"

type ReleaseAsset = {
  name: string
  browser_download_url: string
  size?: number
}

type GitHubRelease = {
  tag_name: string
  html_url: string
  draft?: boolean
  prerelease?: boolean
  assets?: ReleaseAsset[]
}

type CheckForUpdatesOptions = {
  userInitiated?: boolean
}

const LAST_CHECK_AT_KEY = "agentVibes.update.lastCheckAt"
const SKIPPED_VERSION_KEY = "agentVibes.update.skippedVersion"
const MAX_REDIRECTS = 5

function normalizeVersion(value: string): string {
  const trimmed = value.trim().replace(/^v/i, "")
  return trimmed.split("-")[0] ?? trimmed
}

function compareVersions(left: string, right: string): number {
  const lhs = normalizeVersion(left)
    .split(".")
    .map((part) => Number(part) || 0)
  const rhs = normalizeVersion(right)
    .split(".")
    .map((part) => Number(part) || 0)
  const length = Math.max(lhs.length, rhs.length)

  for (let index = 0; index < length; index += 1) {
    const lhsPart = lhs[index] ?? 0
    const rhsPart = rhs[index] ?? 0
    if (lhsPart > rhsPart) return 1
    if (lhsPart < rhsPart) return -1
  }

  return 0
}

function getExpectedAssetNames(version: string): string[] {
  const normalizedVersion = normalizeVersion(version)
  const target = getPlatformTarget()
  return [
    `agent-vibes-${target}-${normalizedVersion}.vsix`,
    `agent-vibes-${normalizedVersion}.vsix`,
  ]
}

function pickReleaseAsset(
  assets: ReleaseAsset[],
  version: string
): ReleaseAsset | undefined {
  const expectedNames = new Set(getExpectedAssetNames(version))
  return assets.find((asset) => expectedNames.has(asset.name))
}

function collectResponseBody(response: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    response.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    response.on("end", () => resolve(Buffer.concat(chunks)))
    response.on("error", reject)
  })
}

function request(url: string, redirectCount = 0): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "agent-vibes-extension-updater",
        },
      },
      (response) => {
        const statusCode = response.statusCode ?? 0
        const location = response.headers.location

        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          location &&
          redirectCount < MAX_REDIRECTS
        ) {
          response.resume()
          resolve(request(new URL(location, url).toString(), redirectCount + 1))
          return
        }

        resolve(response)
      }
    )

    req.on("error", reject)
  })
}

async function getJson<T>(url: string): Promise<T> {
  const response = await request(url)
  const body = await collectResponseBody(response)
  const statusCode = response.statusCode ?? 0

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(
      `GitHub Releases request failed (${statusCode}): ${body.toString("utf8").trim()}`
    )
  }

  return JSON.parse(body.toString("utf8")) as T
}

async function downloadFile(
  url: string,
  destinationPath: string,
  onProgress?: (downloadedBytes: number, totalBytes?: number) => void
): Promise<void> {
  const response = await request(url)
  const statusCode = response.statusCode ?? 0

  if (statusCode < 200 || statusCode >= 300) {
    const body = await collectResponseBody(response)
    throw new Error(
      `VSIX download failed (${statusCode}): ${body.toString("utf8").trim()}`
    )
  }

  const totalBytesHeader = response.headers["content-length"]
  const totalBytes = totalBytesHeader ? Number(totalBytesHeader) : undefined
  let downloadedBytes = 0

  response.on("data", (chunk: Buffer | string) => {
    downloadedBytes += Buffer.byteLength(chunk)
    onProgress?.(downloadedBytes, totalBytes)
  })

  await pipeline(response, createWriteStream(destinationPath))
}

export class ExtensionUpdateService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async checkForUpdatesOnStartup(): Promise<void> {
    const config = vscode.workspace.getConfiguration("agentVibes")
    if (!config.get<boolean>("autoCheckUpdates", true)) {
      return
    }

    const intervalHours = Math.max(
      1,
      config.get<number>(
        "updateCheckIntervalHours",
        DEFAULTS.UPDATE_CHECK_INTERVAL_HOURS
      ) || DEFAULTS.UPDATE_CHECK_INTERVAL_HOURS
    )

    const lastCheckAt = this.context.globalState.get<number>(LAST_CHECK_AT_KEY)
    const now = Date.now()
    if (lastCheckAt && now - lastCheckAt < intervalHours * 60 * 60 * 1000) {
      return
    }

    try {
      await this.checkForUpdates({ userInitiated: false })
      await this.context.globalState.update(LAST_CHECK_AT_KEY, Date.now())
    } catch (error) {
      logger.warn(
        `Extension update check failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async checkForUpdates(options: CheckForUpdatesOptions = {}): Promise<void> {
    const userInitiated = options.userInitiated === true
    const packageJson = this.context.extension.packageJSON as {
      version?: unknown
    }
    const currentVersion = String(packageJson.version ?? "0.0.0")
    const release = await getJson<GitHubRelease>(GITHUB_RELEASES_API_URL)

    if (release.draft) {
      if (userInitiated) {
        void vscode.window.showWarningMessage(
          "The latest GitHub release is still marked as draft."
        )
      }
      return
    }

    const latestVersion = normalizeVersion(release.tag_name)
    if (compareVersions(latestVersion, currentVersion) <= 0) {
      if (userInitiated) {
        void vscode.window.showInformationMessage(
          `${EXTENSION_DISPLAY_NAME} is already up to date (${currentVersion}).`
        )
      }
      return
    }

    const skippedVersion =
      this.context.globalState.get<string>(SKIPPED_VERSION_KEY)
    if (!userInitiated && skippedVersion === latestVersion) {
      return
    }

    const releaseUrl = release.html_url || GITHUB_RELEASES_URL
    const assets = Array.isArray(release.assets) ? release.assets : []
    const asset = pickReleaseAsset(assets, latestVersion)

    if (!asset) {
      const action = await vscode.window.showWarningMessage(
        `Agent Vibes ${latestVersion} is available, but no VSIX asset was found for ${getPlatformTarget()}.`,
        "Open Release"
      )
      if (action === "Open Release") {
        await vscode.env.openExternal(vscode.Uri.parse(releaseUrl))
      }
      return
    }

    const choices = userInitiated
      ? (["Install Update", "View Release"] as const)
      : (["Install Update", "View Release", "Skip This Version"] as const)

    const action = await vscode.window.showInformationMessage(
      `Agent Vibes ${latestVersion} is available from GitHub Releases.`,
      ...choices
    )

    if (action === "Install Update") {
      await this.installUpdate(latestVersion, asset, releaseUrl)
      return
    }

    if (action === "View Release") {
      await vscode.env.openExternal(vscode.Uri.parse(releaseUrl))
      return
    }

    if (action === "Skip This Version") {
      await this.context.globalState.update(SKIPPED_VERSION_KEY, latestVersion)
    }
  }

  private async installUpdate(
    version: string,
    asset: ReleaseAsset,
    releaseUrl: string
  ): Promise<void> {
    const tempDir = path.join(os.tmpdir(), "agent-vibes-updates")
    const downloadPath = path.join(tempDir, asset.name)

    try {
      await fs.mkdir(tempDir, { recursive: true })

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Installing ${EXTENSION_DISPLAY_NAME} ${version}`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "Downloading VSIX..." })

          await downloadFile(
            asset.browser_download_url,
            downloadPath,
            (done, total) => {
              if (!total || total <= 0) {
                return
              }

              progress.report({
                increment: 0,
                message: `Downloading VSIX... ${Math.floor((done / total) * 100)}%`,
              })
            }
          )

          progress.report({ message: "Installing VSIX..." })
          await vscode.commands.executeCommand(
            "workbench.extensions.installExtension",
            vscode.Uri.file(downloadPath)
          )
        }
      )

      await this.context.globalState.update(SKIPPED_VERSION_KEY, undefined)

      const reloadAction = await vscode.window.showInformationMessage(
        `${EXTENSION_DISPLAY_NAME} ${version} installed. Reload Cursor to activate it.`,
        "Reload Window",
        "Later"
      )

      if (reloadAction === "Reload Window") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow")
      }
    } catch (error) {
      logger.error("Failed to install extension update", error)
      const action = await vscode.window.showErrorMessage(
        `Failed to install Agent Vibes ${version}: ${error instanceof Error ? error.message : String(error)}`,
        "Open Release"
      )
      if (action === "Open Release") {
        await vscode.env.openExternal(vscode.Uri.parse(releaseUrl))
      }
    } finally {
      await fs.rm(downloadPath, { force: true }).catch(() => undefined)
    }
  }
}
