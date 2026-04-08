import { Injectable } from "@nestjs/common"
import { ContextTranscriptRecord, extractText, normalizeContent } from "./types"
import { TokenCounterService } from "./token-counter.service"

@Injectable()
export class ContextSummaryService {
  private readonly DEFAULT_MAX_TOKENS = 2200
  private readonly MIN_SUMMARY_TOKENS = 64
  private readonly MIN_SECTION_TOKENS = 24

  constructor(private readonly tokenCounter: TokenCounterService) {}

  buildSummary(
    records: ContextTranscriptRecord[],
    options?: { maxTokens?: number }
  ): { text: string; tokenCount: number } {
    const maxTokens = Math.max(
      options?.maxTokens || this.DEFAULT_MAX_TOKENS,
      this.MIN_SUMMARY_TOKENS
    )

    const objective = this.collectObjective(records)
    const recentRequests = this.collectRecentUserRequests(records)
    const constraints = this.collectActiveConstraints(records)
    const assistantProgress = this.collectAssistantProgress(records)
    const toolActivity = this.collectToolActivity(records)
    const toolOutcomes = this.collectToolOutcomes(records)
    const files = this.collectFileReferences(records)

    const sections: string[] = []
    this.pushSectionWithinBudget(
      sections,
      "Archived Context",
      `${records.length} transcript record(s) summarized.`,
      maxTokens
    )
    if (objective) {
      this.pushSectionWithinBudget(sections, "Objective", objective, maxTokens)
    }
    if (recentRequests.length > 0) {
      this.pushSectionWithinBudget(
        sections,
        "Recent User Requests",
        recentRequests.map((line) => `- ${line}`).join("\n"),
        maxTokens
      )
    }
    if (constraints.length > 0) {
      this.pushSectionWithinBudget(
        sections,
        "Active Constraints",
        constraints.map((line) => `- ${line}`).join("\n"),
        maxTokens
      )
    }
    if (assistantProgress.length > 0) {
      this.pushSectionWithinBudget(
        sections,
        "Assistant Progress",
        assistantProgress.map((line) => `- ${line}`).join("\n"),
        maxTokens
      )
    }
    if (toolActivity) {
      this.pushSectionWithinBudget(
        sections,
        "Tool Activity",
        toolActivity,
        maxTokens
      )
    }
    if (toolOutcomes.length > 0) {
      this.pushSectionWithinBudget(
        sections,
        "Tool Outcomes",
        toolOutcomes.map((line) => `- ${line}`).join("\n"),
        maxTokens
      )
    }
    if (files.length > 0) {
      this.pushSectionWithinBudget(
        sections,
        "Files And Paths",
        files.map((line) => `- ${line}`).join("\n"),
        maxTokens
      )
    }

    let summary = sections.join("\n\n").trim()
    if (!summary) {
      summary = "Archived context compressed."
    }

    summary = this.trimToBudget(summary, maxTokens)
    return {
      text: summary,
      tokenCount: this.tokenCounter.countText(summary),
    }
  }

  private collectObjective(records: ContextTranscriptRecord[]): string {
    const userMessages = records
      .filter((record) => record.role === "user")
      .map((record) => this.normalizePlainText(record.content))
      .filter(Boolean)
    if (userMessages.length === 0) {
      return ""
    }

    const primary = userMessages[0]!.slice(0, 120)
    const latest = userMessages[userMessages.length - 1]!.slice(0, 120)
    if (latest && latest !== primary) {
      return `Primary goal: ${primary}\nLatest user direction: ${latest}`
    }

    for (const record of records) {
      if (record.role !== "user") continue
      const text = this.normalizePlainText(record.content)
      if (!text) continue
      return text.slice(0, 160)
    }
    return ""
  }

  private collectRecentUserRequests(
    records: ContextTranscriptRecord[]
  ): string[] {
    const requests: string[] = []
    for (let i = records.length - 1; i >= 0 && requests.length < 5; i--) {
      const record = records[i]
      if (!record || record.role !== "user") continue
      const text = this.normalizePlainText(record.content)
      if (!text) continue
      requests.unshift(text.slice(0, 180))
    }
    return this.dedupePreserveOrder(requests)
  }

  private collectActiveConstraints(
    records: ContextTranscriptRecord[]
  ): string[] {
    const matches: string[] = []
    const patterns = [
      /\bmust\b/i,
      /\bneed to\b/i,
      /\bshould\b/i,
      /\bdon't\b/i,
      /\bdo not\b/i,
      /禁止/u,
      /不要/u,
      /必须/u,
      /只能/u,
    ]

    for (let i = records.length - 1; i >= 0 && matches.length < 6; i--) {
      const record = records[i]
      if (!record || record.role !== "user") continue
      const text = this.normalizePlainText(record.content)
      if (!text) continue

      const sentences = text
        .split(/(?<=[.!?。！？\n])/)
        .map((line) => line.trim())
        .filter(Boolean)

      for (let j = sentences.length - 1; j >= 0 && matches.length < 6; j--) {
        const sentence = sentences[j]
        if (!sentence) continue
        if (patterns.some((pattern) => pattern.test(sentence))) {
          matches.unshift(sentence.slice(0, 160))
        }
      }
    }

    return this.dedupePreserveOrder(matches)
  }

  private collectAssistantProgress(
    records: ContextTranscriptRecord[]
  ): string[] {
    const points: string[] = []
    for (let i = records.length - 1; i >= 0 && points.length < 6; i--) {
      const record = records[i]
      if (!record || record.role !== "assistant") continue
      const text = this.normalizePlainText(record.content)
      if (!text || text.length < 30) continue
      points.unshift(text.slice(0, 160))
    }
    return this.dedupePreserveOrder(points)
  }

  private collectToolActivity(records: ContextTranscriptRecord[]): string {
    const toolCounts = new Map<string, number>()

    for (const record of records) {
      const blocks = normalizeContent(record.content)
      for (const block of blocks) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          toolCounts.set(block.name, (toolCounts.get(block.name) || 0) + 1)
        }
      }
    }

    if (toolCounts.size === 0) return ""
    return Array.from(toolCounts.entries())
      .map(([name, count]) => `${name}(${count})`)
      .join(", ")
  }

  private collectToolOutcomes(records: ContextTranscriptRecord[]): string[] {
    const outcomes: string[] = []

    for (let i = records.length - 1; i >= 0 && outcomes.length < 6; i--) {
      const record = records[i]
      if (!record || record.role !== "user") continue

      for (const block of normalizeContent(record.content)) {
        if (block.type !== "tool_result") continue
        const text =
          typeof block.content === "string"
            ? block.content
            : block.content
                .map((inner) =>
                  inner.type === "text" ? inner.text : JSON.stringify(inner)
                )
                .join("\n")
        const normalized = this.normalizePlainText(text)
        if (!normalized) continue

        const status = block.is_error ? "error" : "ok"
        outcomes.unshift(
          `${status} ${block.tool_use_id}: ${normalized.slice(0, 160)}`
        )
      }
    }

    return this.dedupePreserveOrder(outcomes)
  }

  private collectFileReferences(records: ContextTranscriptRecord[]): string[] {
    const files: string[] = []
    const pathPattern =
      /(?:\/|\.\/|\.\.\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:\.[A-Za-z0-9_.-]+)?/g

    for (let i = records.length - 1; i >= 0 && files.length < 12; i--) {
      const record = records[i]
      if (!record) continue

      const text = this.normalizePlainText(record.content)
      if (text) {
        for (const match of text.matchAll(pathPattern)) {
          const file = match[0]?.trim()
          if (file) files.unshift(file)
          if (files.length >= 12) break
        }
      }

      for (const block of normalizeContent(record.content)) {
        if (block.type !== "tool_use") continue
        const serialized = this.safeStringify(block.input)
        for (const match of serialized.matchAll(pathPattern)) {
          const file = match[0]?.trim()
          if (file) files.unshift(file)
          if (files.length >= 12) break
        }
      }
    }

    return this.dedupePreserveOrder(files).slice(-12)
  }

  private normalizePlainText(
    content: ContextTranscriptRecord["content"] | string
  ): string {
    const text = typeof content === "string" ? content : extractText(content)

    return text
      .replace(/\s+/g, " ")
      .replace(/\[Context attachment:[^\]]+\]/g, "")
      .replace(/\[Context summary [^\]]+\]/g, "")
      .replace(/\[Context boundary [^\]]+\]/g, "")
      .trim()
  }

  private safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value)
    } catch {
      return ""
    }
  }

  private dedupePreserveOrder(values: string[]): string[] {
    const seen = new Set<string>()
    const result: string[] = []

    for (const value of values) {
      const normalized = value.trim()
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      result.push(normalized)
    }

    return result
  }

  private pushSectionWithinBudget(
    target: string[],
    heading: string,
    body: string,
    maxTokens: number
  ): void {
    const clean = body.trim()
    if (!clean) return
    const rendered = `${heading}:\n${clean}`
    const current = target.join("\n\n")
    const withSection = current ? `${current}\n\n${rendered}` : rendered

    if (this.tokenCounter.countText(withSection) <= maxTokens) {
      target.push(rendered)
      return
    }

    const prefixTokens = current
      ? this.tokenCounter.countText(`${current}\n\n`)
      : 0
    const remainingTokens = maxTokens - prefixTokens
    if (remainingTokens < this.MIN_SECTION_TOKENS) {
      return
    }

    const trimmed = this.trimSectionToBudget(heading, clean, remainingTokens)
    if (trimmed) {
      target.push(`${heading}:\n${trimmed}`)
    }
  }

  private trimToBudget(text: string, maxTokens: number): string {
    const value = text
    if (this.tokenCounter.countText(value) <= maxTokens) {
      return value
    }

    let end = value.length
    while (end > 96) {
      end = Math.floor(end * 0.82)
      const candidate = `${value.slice(0, end).trim()}\n...[summary truncated]`
      if (this.tokenCounter.countText(candidate) <= maxTokens) {
        return candidate
      }
    }

    return "Archived context compressed. ...[summary truncated]"
  }

  private trimSectionToBudget(
    heading: string,
    body: string,
    maxTokens: number
  ): string {
    const value = body
    const render = (input: string) => `${heading}:\n${input}`

    if (this.tokenCounter.countText(render(value)) <= maxTokens) {
      return value
    }

    let end = value.length
    while (end > 48) {
      end = Math.floor(end * 0.82)
      const candidate = `${value.slice(0, end).trim()}\n...[section truncated]`
      if (this.tokenCounter.countText(render(candidate)) <= maxTokens) {
        return candidate
      }
    }

    return ""
  }
}
