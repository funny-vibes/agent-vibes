/**
 * CursorSkillsManager —— Skill 子系统的统一入口。
 *
 * 设计意图：
 *   - 把原先散落在 cursor-connect-stream.service.ts 中的 7 个 private 方法
 *     （resolveCursorSkillPolicyForPrompt / buildCursorSkillsCatalogSection /
 *      isCursorSkillActive / activateCursorSkillForSession / activateCursorSkillsForPath /
 *      buildInactiveCursorSkillToolError / pickCursorSkillTargetPath）集中到本类。
 *   - 提供「只读策略求解」「会话级激活/卸载」「工具访问拦截」「Skill 搜索」四组 API。
 *   - Service 自身保持无状态（state 全部寄存在 ChatSession 上），便于水平扩展。
 *
 * 模型对照：
 *   - Anthropic Claude Code SkillsManager（getSkillToolCommands + permission）
 *   - OpenAI Codex SkillsManager（cache + scope + restriction_product）
 *   本实现是 Cursor 协议的轻量适配版，专注 session 内激活策略与 prompt 注入。
 */

import { Injectable, Logger } from "@nestjs/common"
import type { CursorRule } from "../../../gen/agent/v1_pb"
import { ChatSessionManager } from "../session/chat-session.service"
import type { ChatSession } from "../session/chat-session.service"
import { renderCursorSkillsCatalog } from "./catalog"
import { normalizePathForMatch, normalizeSkillName } from "./frontmatter"
import {
  findCursorSkillByName,
  findCursorSkillForInternalPath,
  resolveCursorSkillPolicy,
} from "./policy"
import { searchCursorSkills } from "./search"
import type {
  CursorSkillCatalogBudget,
  CursorSkillMetadata,
  CursorSkillPolicyInput,
  CursorSkillPolicyResult,
  CursorSkillSearchHit,
} from "./types"

/** Service 接受的 Prompt 上下文子集；保持与 PromptContext 兼容。 */
export interface CursorSkillsPromptContext {
  cursorRules?: CursorRule[]
  selectedCursorRulePaths?: string[]
  selectedCursorRuleNames?: string[]
  activeCursorSkillNames?: string[]
  projectContext?: { rootPath?: string }
  codeChunks?: Array<{ path: string }>
}

@Injectable()
export class CursorSkillsManager {
  private readonly logger = new Logger(CursorSkillsManager.name)

  constructor(private readonly sessionManager: ChatSessionManager) {}

  /* ---------------- 策略求解 ---------------- */

  /** 以 PromptContext 求解策略，并对 suppressed Skill 输出诊断日志。 */
  resolvePolicyForPrompt(
    context: CursorSkillsPromptContext
  ): CursorSkillPolicyResult {
    const policy = resolveCursorSkillPolicy(this.toPolicyInput(context))
    if (policy.suppressedSkills.length > 0) {
      this.logger.warn(
        `Suppressed ${policy.suppressedSkills.length} inactive Cursor skill rule(s) for prompt: ` +
          policy.suppressedSkills.map((skill) => skill.name).join(", ") +
          "; use fetch_rules({ skill_name }) to load a skill before applying its workflow"
      )
    }
    return policy
  }

  /** 直接以 ChatSession 求解策略；用于 fetch_rules 等运行时调用。 */
  resolvePolicyForSession(
    session: ChatSession,
    extraContextPaths: string[] = []
  ): CursorSkillPolicyResult {
    return resolveCursorSkillPolicy(
      this.toPolicyInputFromSession(session, extraContextPaths)
    )
  }

  /** 暴露底层 policy 求解，便于 parser 等场景按自定义 input 调用。 */
  resolvePolicy(input: CursorSkillPolicyInput): CursorSkillPolicyResult {
    return resolveCursorSkillPolicy(input)
  }

  /* ---------------- Catalog 渲染 ---------------- */

  /** 渲染 Skill 目录段落；空列表返回 null。 */
  buildCatalogSection(
    skills: CursorSkillMetadata[],
    budget?: CursorSkillCatalogBudget
  ): string | null {
    return renderCursorSkillsCatalog(skills, budget)
  }

  /* ---------------- 会话级激活/卸载 ---------------- */

  /** 判定 Skill 是否在当前会话中处于激活态。 */
  isActive(session: ChatSession, skillName: string): boolean {
    const normalized = normalizeSkillName(skillName)
    if (!normalized) return false
    if (
      (session.activeCursorSkillNames || []).some(
        (name) => normalizeSkillName(name) === normalized
      )
    ) {
      return true
    }
    return this.resolvePolicyForSession(session).activeSkills.some(
      (skill) => skill.name === normalized
    )
  }

  /** 在会话上激活某个 Skill（幂等）。 */
  activate(session: ChatSession, skillName: string, reason: string): void {
    const normalized = normalizeSkillName(skillName)
    if (!normalized) return
    const activeNames = new Set(
      (session.activeCursorSkillNames || []).map((name) =>
        normalizeSkillName(name)
      )
    )
    if (activeNames.has(normalized)) return
    session.activeCursorSkillNames = [
      ...(session.activeCursorSkillNames || []),
      normalized,
    ]
    this.sessionManager.markSessionDirty(session.conversationId)
    this.logger.log(
      `Activated Cursor skill "${normalized}" for session ${session.conversationId}; reason=${reason}`
    )
  }

  /** 显式卸载某个 Skill；无匹配则忽略。 */
  deactivate(session: ChatSession, skillName: string): boolean {
    const normalized = normalizeSkillName(skillName)
    if (!normalized) return false
    const before = session.activeCursorSkillNames || []
    const after = before.filter(
      (name) => normalizeSkillName(name) !== normalized
    )
    if (after.length === before.length) return false
    session.activeCursorSkillNames = after
    this.sessionManager.markSessionDirty(session.conversationId)
    this.logger.log(
      `Deactivated Cursor skill "${normalized}" for session ${session.conversationId}`
    )
    return true
  }

  /** 根据当前工具访问的路径，自动激活满足 path_match 条件的 Skill。 */
  activateForPath(session: ChatSession, rawPath: string, reason: string): void {
    if (!rawPath) return
    const policy = this.resolvePolicyForSession(session, [rawPath])
    for (const skill of policy.activeSkills) {
      if (skill.activationReason === "path_match") {
        this.activate(session, skill.name, reason)
      }
    }
  }

  /* ---------------- 工具访问拦截 ---------------- */

  /**
   * 给定一个工具调用（toolName + input），如果它尝试访问的路径属于
   * 某个未激活 Skill 的内部目录，返回错误信息字符串供调用方拒绝执行。
   * 否则返回 null。
   */
  guardToolAccess(
    session: ChatSession,
    toolName: string,
    input: Record<string, unknown>
  ): string | null {
    const targetPath = this.pickToolTargetPath(toolName, input)
    if (!targetPath) return null
    const skill = findCursorSkillForInternalPath(
      session.cursorRules,
      targetPath
    )
    if (!skill) return null
    if (this.isActive(session, skill.name)) return null

    const message =
      `Cursor skill access blocked: skill "${skill.name}" is available but not active. ` +
      `Load it with fetch_rules({ skill_name: "${skill.name}" }) before using its internal files or generated workspace.`
    this.logger.warn(
      `${message}; tool=${toolName}; path=${targetPath || "(none)"}`
    )
    return message
  }

  /** 从工具调用 input 中提取「可能涉及文件路径」的字段。 */
  pickToolTargetPath(toolName: string, input: Record<string, unknown>): string {
    const normalizedTool = toolName.trim().toLowerCase()
    if (!normalizedTool) return ""

    const mayTouchPath =
      normalizedTool.includes("read") ||
      normalizedTool.includes("list") ||
      normalizedTool.includes("ls") ||
      normalizedTool.includes("edit") ||
      normalizedTool.includes("write") ||
      normalizedTool.includes("delete") ||
      normalizedTool.includes("file") ||
      normalizedTool.includes("dir")
    if (!mayTouchPath) return ""

    return pickFirstString(input, [
      "path",
      "filePath",
      "file_path",
      "targetPath",
      "target_path",
      "directory",
      "dir",
    ])
  }

  /* ---------------- 查找与搜索 ---------------- */

  /** 按 name 在 rules 中精确查找 Skill。 */
  findByName(
    rules: CursorRule[] | undefined,
    skillName: string
  ): CursorSkillMetadata | null {
    return findCursorSkillByName(rules, skillName)
  }

  /** 按任务描述模糊检索 Skill。 */
  search(
    skills: CursorSkillMetadata[],
    query: string,
    limit?: number
  ): CursorSkillSearchHit[] {
    return searchCursorSkills(skills, query, limit)
  }

  /* ---------------- 内部 ---------------- */

  private toPolicyInput(
    context: CursorSkillsPromptContext
  ): CursorSkillPolicyInput {
    return {
      rules: context.cursorRules,
      selectedRulePaths: context.selectedCursorRulePaths,
      selectedRuleNames: context.selectedCursorRuleNames,
      activeSkillNames: context.activeCursorSkillNames,
      projectRoot: context.projectContext?.rootPath,
      contextPaths: (context.codeChunks || []).map((chunk) => chunk.path),
    }
  }

  private toPolicyInputFromSession(
    session: ChatSession,
    extraContextPaths: string[]
  ): CursorSkillPolicyInput {
    const baseContextPaths = (session.codeChunks || []).map(
      (chunk) => chunk.path
    )
    const contextPaths = extraContextPaths.length
      ? [...baseContextPaths, ...extraContextPaths.map(normalizePathForMatch)]
      : baseContextPaths
    return {
      rules: session.cursorRules,
      selectedRulePaths: session.selectedCursorRulePaths,
      selectedRuleNames: session.selectedCursorRuleNames,
      activeSkillNames: session.activeCursorSkillNames,
      projectRoot: session.projectContext?.rootPath,
      contextPaths,
    }
  }
}

function pickFirstString(
  input: Record<string, unknown>,
  keys: string[]
): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.trim().length > 0) {
      return value
    }
  }
  return ""
}
