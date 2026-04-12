import { Injectable, Logger } from "@nestjs/common"
import * as os from "os"
import * as path from "path"
import { promises as fs } from "fs"
import { execFile } from "child_process"
import { promisify } from "util"

type FixExecutionStatus = "success" | "failure" | "error"

interface LintDiagnostic {
  source: string
  code?: string
  message: string
  severity: number
  range?: {
    start?: { line: number; column: number }
    end?: { line: number; column: number }
  }
}

interface LintFileDiagnostics {
  path: string
  relativePath: string
  diagnostics: LintDiagnostic[]
  diagnosticsCount: number
}

interface FixLintsFileResult {
  filePath: string
  relativePath: string
  diff: string
  isApplied: boolean
  applyFailed: boolean
  error?: string
  beforeDiagnostics: number
  afterDiagnostics: number
}

export interface ClientSideFixLintsReplay {
  before: {
    totalDiagnostics: number
    files: LintFileDiagnostics[]
  }
  fix: {
    command: string
    fileResults: FixLintsFileResult[]
  }
  after: {
    totalDiagnostics: number
    files: LintFileDiagnostics[]
  }
}

export interface ClientSideFixLintsExecutionResult {
  status: FixExecutionStatus
  message?: string
  content: string
  replay: ClientSideFixLintsReplay
}

@Injectable()
export class ClientSideToolV2ExecutorService {
  private readonly logger = new Logger(ClientSideToolV2ExecutorService.name)
  private readonly execFileAsync = promisify(execFile)

  async executeFixLints(
    rootPath: string,
    input: Record<string, unknown>
  ): Promise<ClientSideFixLintsExecutionResult> {
    const resolvedRoot = path.resolve(rootPath)
    const requestedPaths = this.pickRequestedPaths(input)
    if (requestedPaths.length === 0) {
      return {
        status: "error",
        message: "missing paths",
        content: "[fix_lints error] Missing required paths/files payload",
        replay: {
          before: { totalDiagnostics: 0, files: [] },
          fix: { command: "n/a", fileResults: [] },
          after: { totalDiagnostics: 0, files: [] },
        },
      }
    }

    const resolvedTargets = this.resolveTargetFiles(
      resolvedRoot,
      requestedPaths
    )
    const validTargets = resolvedTargets.filter((entry) => entry.kind === "ok")
    const failedTargets = resolvedTargets.filter((entry) => entry.kind !== "ok")

    if (validTargets.length === 0) {
      const fileResults = failedTargets.map((entry) => ({
        filePath: entry.absPath,
        relativePath: entry.relPath,
        diff: "",
        isApplied: false,
        applyFailed: true,
        error: entry.error,
        beforeDiagnostics: 0,
        afterDiagnostics: 0,
      }))
      return {
        status: "error",
        message: "no valid target files",
        content: "[fix_lints error] No valid files under workspace root",
        replay: {
          before: { totalDiagnostics: 0, files: [] },
          fix: {
            command: "n/a",
            fileResults,
          },
          after: { totalDiagnostics: 0, files: [] },
        },
      }
    }

    const beforeContents = new Map<string, string>()
    for (const target of validTargets) {
      beforeContents.set(
        target.absPath,
        await fs.readFile(target.absPath, "utf8")
      )
    }

    const beforeDiagnostics = await this.collectDiagnostics(
      resolvedRoot,
      validTargets.map((entry) => entry.absPath)
    )
    const beforeDiagnosticsByFile = new Map(
      beforeDiagnostics.files.map((entry) => [
        entry.path,
        entry.diagnosticsCount,
      ])
    )

    const fixCommand =
      "npx eslint --fix --format json --no-error-on-unmatched-pattern <paths...>"
    const fixRun = await this.runEslint(resolvedRoot, [
      "--fix",
      "--format",
      "json",
      "--no-error-on-unmatched-pattern",
      ...validTargets.map((entry) => entry.absPath),
    ])

    const afterContents = new Map<string, string>()
    for (const target of validTargets) {
      afterContents.set(
        target.absPath,
        await fs.readFile(target.absPath, "utf8")
      )
    }

    const afterDiagnostics = await this.collectDiagnostics(
      resolvedRoot,
      validTargets.map((entry) => entry.absPath)
    )
    const afterDiagnosticsByFile = new Map(
      afterDiagnostics.files.map((entry) => [
        entry.path,
        entry.diagnosticsCount,
      ])
    )

    const fileResults: FixLintsFileResult[] = []
    for (const target of validTargets) {
      const before = beforeContents.get(target.absPath) || ""
      const after = afterContents.get(target.absPath) || ""
      const isApplied = before !== after
      const beforeCount = beforeDiagnosticsByFile.get(target.absPath) || 0
      const afterCount = afterDiagnosticsByFile.get(target.absPath) || 0
      let error: string | undefined
      if (!isApplied && beforeCount > 0 && afterCount >= beforeCount) {
        error = "no automatic fix was applied"
      }
      if (fixRun.fatalError && !error) {
        error = fixRun.fatalError
      }
      const diff = isApplied
        ? await this.createUnifiedDiff(target.relPath, before, after)
        : ""
      fileResults.push({
        filePath: target.absPath,
        relativePath: target.relPath,
        diff,
        isApplied,
        applyFailed: Boolean(error),
        error,
        beforeDiagnostics: beforeCount,
        afterDiagnostics: afterCount,
      })
    }

    for (const entry of failedTargets) {
      fileResults.push({
        filePath: entry.absPath,
        relativePath: entry.relPath,
        diff: "",
        isApplied: false,
        applyFailed: true,
        error: entry.error,
        beforeDiagnostics: 0,
        afterDiagnostics: 0,
      })
    }

    const changedCount = fileResults.filter((entry) => entry.isApplied).length
    const failedCount = fileResults.filter((entry) => entry.applyFailed).length
    const beforeTotal = beforeDiagnostics.totalDiagnostics
    const afterTotal = afterDiagnostics.totalDiagnostics

    const status: FixExecutionStatus =
      failedCount === 0 && afterTotal <= beforeTotal ? "success" : "failure"
    const prefix =
      status === "success" ? "[fix_lints success]" : "[fix_lints failure]"
    const summary =
      `${prefix} files=${fileResults.length} changed=${changedCount} failed=${failedCount} ` +
      `before=${beforeTotal} after=${afterTotal}`
    const stderrSnippet = fixRun.stderr.trim()
    const details = stderrSnippet
      ? `${summary}\n[eslint stderr] ${stderrSnippet.slice(0, 500)}`
      : summary

    return {
      status,
      message: fixRun.fatalError,
      content: details,
      replay: {
        before: beforeDiagnostics,
        fix: {
          command: fixCommand,
          fileResults,
        },
        after: afterDiagnostics,
      },
    }
  }

  private pickRequestedPaths(input: Record<string, unknown>): string[] {
    const raw: unknown[] = []
    if (Array.isArray(input.paths)) raw.push(...(input.paths as unknown[]))
    if (Array.isArray(input.files)) raw.push(...(input.files as unknown[]))
    if (typeof input.path === "string") raw.push(input.path)
    if (typeof input.file === "string") raw.push(input.file)
    const seen = new Set<string>()
    const out: string[] = []
    for (const entry of raw) {
      if (typeof entry !== "string") continue
      const normalized = entry.trim()
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      out.push(normalized)
    }
    return out
  }

  private resolveTargetFiles(
    rootPath: string,
    requestedPaths: string[]
  ): Array<
    | { kind: "ok"; absPath: string; relPath: string }
    | { kind: "error"; absPath: string; relPath: string; error: string }
  > {
    const normalizedRoot = path.resolve(rootPath)
    const seen = new Set<string>()
    const out: Array<
      | { kind: "ok"; absPath: string; relPath: string }
      | { kind: "error"; absPath: string; relPath: string; error: string }
    > = []
    for (const rawPath of requestedPaths) {
      const candidate = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(normalizedRoot, rawPath)
      if (seen.has(candidate)) continue
      seen.add(candidate)

      const rel = path.relative(normalizedRoot, candidate)
      const relPath = rel || path.basename(candidate)
      const isWithinRoot =
        candidate === normalizedRoot ||
        (!rel.startsWith("..") && !path.isAbsolute(rel))
      if (!isWithinRoot) {
        out.push({
          kind: "error",
          absPath: candidate,
          relPath,
          error: "path is outside workspace root",
        })
        continue
      }
      out.push({ kind: "ok", absPath: candidate, relPath })
    }
    return out
  }

  private async collectDiagnostics(
    rootPath: string,
    absPaths: string[]
  ): Promise<{ totalDiagnostics: number; files: LintFileDiagnostics[] }> {
    const eslintByFile = await this.collectEslintDiagnostics(rootPath, absPaths)
    const files: LintFileDiagnostics[] = []
    let totalDiagnostics = 0

    for (const absPath of absPaths) {
      const content = await fs.readFile(absPath, "utf8")
      const tsDiagnostics = await this.collectTypeScriptSyntaxDiagnostics(
        absPath,
        content
      )
      const eslintDiagnostics = eslintByFile.get(absPath) || []
      const diagnostics = [...tsDiagnostics, ...eslintDiagnostics]
      totalDiagnostics += diagnostics.length
      files.push({
        path: absPath,
        relativePath:
          path.relative(rootPath, absPath) || path.basename(absPath),
        diagnostics,
        diagnosticsCount: diagnostics.length,
      })
    }

    return { totalDiagnostics, files }
  }

  private async collectEslintDiagnostics(
    rootPath: string,
    absPaths: string[]
  ): Promise<Map<string, LintDiagnostic[]>> {
    const out = new Map<string, LintDiagnostic[]>()
    if (absPaths.length === 0) return out
    const result = await this.runEslint(rootPath, [
      "--format",
      "json",
      "--no-error-on-unmatched-pattern",
      ...absPaths,
    ])

    const parsed = this.parseEslintJson(result.stdout)
    if (!parsed) return out

    for (const entry of parsed) {
      const filePathRaw = this.coerceScalarString(entry.filePath)
      if (!filePathRaw) continue
      const filePath = path.resolve(filePathRaw)
      if (!filePath) continue
      const diagnostics: LintDiagnostic[] = []
      const messages = Array.isArray(entry.messages) ? entry.messages : []
      for (const message of messages) {
        if (!message || typeof message !== "object") continue
        const msg = message as Record<string, unknown>
        const text = this.coerceScalarString(msg.message) || ""
        if (
          text.includes(
            "File ignored because no matching configuration was supplied"
          )
        ) {
          continue
        }
        diagnostics.push({
          source: "eslint",
          code:
            typeof msg.ruleId === "string" && msg.ruleId.trim()
              ? msg.ruleId.trim()
              : undefined,
          message: text || "lint warning",
          severity:
            typeof msg.severity === "number" && msg.severity > 0
              ? Math.floor(msg.severity)
              : 1,
          range: {
            start: this.normalizeOneBasedPosition(msg.line, msg.column),
            end: this.normalizeOneBasedPosition(msg.endLine, msg.endColumn),
          },
        })
      }
      out.set(filePath, diagnostics)
    }

    return out
  }

  private normalizeOneBasedPosition(
    lineRaw: unknown,
    columnRaw: unknown
  ): { line: number; column: number } | undefined {
    const line =
      typeof lineRaw === "number" && Number.isFinite(lineRaw) ? lineRaw : 0
    const column =
      typeof columnRaw === "number" && Number.isFinite(columnRaw)
        ? columnRaw
        : 0
    if (line <= 0 || column <= 0) return undefined
    return { line: Math.floor(line - 1), column: Math.floor(column - 1) }
  }

  private async collectTypeScriptSyntaxDiagnostics(
    absPath: string,
    content: string
  ): Promise<LintDiagnostic[]> {
    if (!/\.(tsx?|mts|cts)$/i.test(absPath)) return []
    try {
      const ts = await import("typescript")
      const transpileResult = ts.transpileModule(content, {
        fileName: absPath,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.Latest,
        },
      })
      const diagnostics = transpileResult.diagnostics || []
      const sourceFile = ts.createSourceFile(
        absPath,
        content,
        ts.ScriptTarget.Latest,
        true
      )
      return diagnostics.map((diagnostic: import("typescript").Diagnostic) => {
        const start =
          typeof diagnostic.start === "number" ? diagnostic.start : 0
        const end =
          start +
          (typeof diagnostic.length === "number" ? diagnostic.length : 0)
        const startPos = sourceFile.getLineAndCharacterOfPosition(start)
        const endPos = sourceFile.getLineAndCharacterOfPosition(
          Math.min(content.length, Math.max(start, end))
        )
        return {
          source: "typescript",
          code: `TS${diagnostic.code}`,
          severity: 1,
          message: ts.flattenDiagnosticMessageText(
            diagnostic.messageText,
            "\n"
          ),
          range: {
            start: {
              line: startPos.line,
              column: startPos.character,
            },
            end: {
              line: endPos.line,
              column: endPos.character,
            },
          },
        }
      })
    } catch (error) {
      this.logger.warn(
        `TypeScript diagnostics unavailable for ${absPath}: ${String(error)}`
      )
      return []
    }
  }

  private async runEslint(
    cwd: string,
    args: string[]
  ): Promise<{
    stdout: string
    stderr: string
    fatalError?: string
  }> {
    const npxBinary = process.platform === "win32" ? "npx.cmd" : "npx"
    try {
      const { stdout, stderr } = await this.execFileAsync(
        npxBinary,
        ["eslint", ...args],
        {
          cwd,
          maxBuffer: 4 * 1024 * 1024,
        }
      )
      return {
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      }
    } catch (error) {
      const err = error as {
        stdout?: string
        stderr?: string
        message?: string
      }
      return {
        stdout: String(err.stdout || ""),
        stderr: String(err.stderr || ""),
        fatalError: String(err.message || "eslint execution failed"),
      }
    }
  }

  private parseEslintJson(
    stdout: string
  ): Array<Record<string, unknown>> | undefined {
    const normalized = stdout.trim()
    if (!normalized.startsWith("[")) return undefined
    try {
      const parsed: unknown = JSON.parse(normalized)
      if (!Array.isArray(parsed)) return undefined
      return parsed.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object"
      )
    } catch {
      return undefined
    }
  }

  private coerceScalarString(value: unknown): string | undefined {
    if (typeof value === "string") return value
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    ) {
      return String(value)
    }
    return undefined
  }

  private async createUnifiedDiff(
    relativePath: string,
    before: string,
    after: string
  ): Promise<string> {
    if (before === after) return ""
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-fix-lints-"))
    const beforePath = path.join(tmpDir, "before.tmp")
    const afterPath = path.join(tmpDir, "after.tmp")
    try {
      await fs.writeFile(beforePath, before, "utf8")
      await fs.writeFile(afterPath, after, "utf8")
      try {
        const { stdout } = await this.execFileAsync(
          "diff",
          [
            "-u",
            "-L",
            `a/${relativePath}`,
            "-L",
            `b/${relativePath}`,
            beforePath,
            afterPath,
          ],
          { maxBuffer: 4 * 1024 * 1024 }
        )
        return String(stdout || "").trim()
      } catch (error) {
        const err = error as { stdout?: string; code?: number }
        if (err.code === 1) {
          return String(err.stdout || "").trim()
        }
        return `[diff unavailable] ${String((error as Error).message || error)}`
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }
}
