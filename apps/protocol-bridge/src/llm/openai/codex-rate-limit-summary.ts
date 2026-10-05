import type {
  CodexImageGenLimitSnapshot,
  CodexRateLimitAccountSummary,
  CodexRateLimitModelSummary,
  CodexRateLimitSnapshot,
  CodexRateLimitSource,
} from "../shared/backend-pool-status"
import { getEffectiveCodexRateLimitSnapshot } from "./codex-rate-limit-policy"

export type CodexRateLimitSnapshotMap = Map<
  string,
  Partial<Record<CodexRateLimitSource, CodexRateLimitSnapshot>>
>

export type CodexDisplayModelResolver = (normalizedModel: string) => string

export function normalizeCodexRateLimitModelName(modelName: string): string {
  return modelName.toLowerCase().trim()
}

export function hasCodexRateLimitData(
  snapshotsByModel: CodexRateLimitSnapshotMap
): boolean {
  for (const snapshots of snapshotsByModel.values()) {
    if (snapshots.request || snapshots.probe) {
      return true
    }
  }
  return false
}

export function getCodexRateLimitModelSummary(
  snapshotsByModel: CodexRateLimitSnapshotMap,
  modelName: string,
  resolveDisplayModel: CodexDisplayModelResolver
): CodexRateLimitModelSummary | null {
  const normalized = normalizeCodexRateLimitModelName(modelName)
  const snapshots = snapshotsByModel.get(normalized)
  const effective = getEffectiveCodexRateLimitSnapshot(snapshots)

  if (!snapshots && !effective) {
    return null
  }

  const request = snapshots?.request
  const probe = snapshots?.probe
  const updatedAt = Math.max(
    request?.updatedAt || 0,
    probe?.updatedAt || 0,
    effective?.updatedAt || 0
  )

  return {
    model: normalized,
    displayModel: resolveDisplayModel(normalized),
    effective,
    request,
    probe,
    updatedAt,
  }
}

export function getCodexRateLimitAccountSummary(
  snapshotsByModel: CodexRateLimitSnapshotMap,
  preferredModel: string,
  resolveDisplayModel: CodexDisplayModelResolver,
  imageGen?: CodexImageGenLimitSnapshot
): CodexRateLimitAccountSummary | undefined {
  const models = Array.from(snapshotsByModel.keys())
    .map((modelName) =>
      getCodexRateLimitModelSummary(
        snapshotsByModel,
        modelName,
        resolveDisplayModel
      )
    )
    .filter((summary): summary is CodexRateLimitModelSummary => summary != null)
    .sort((left, right) => right.updatedAt - left.updatedAt)

  if (models.length === 0) {
    return imageGen
      ? { effective: null, models, imageGen, updatedAt: imageGen.updatedAt }
      : undefined
  }

  const normalizedPreferred = normalizeCodexRateLimitModelName(preferredModel)
  const preferred =
    models.find((summary) => summary.model === normalizedPreferred) || null
  const effective = preferred?.effective || models[0]?.effective || null
  const updatedAt = preferred?.updatedAt || models[0]?.updatedAt || null
  return {
    effective,
    models,
    ...(imageGen ? { imageGen } : {}),
    updatedAt,
  }
}

export function setCodexRateLimitSnapshot(
  snapshotsByModel: CodexRateLimitSnapshotMap,
  snapshot: CodexRateLimitSnapshot,
  resolveDisplayModel: CodexDisplayModelResolver
): void {
  const normalized = normalizeCodexRateLimitModelName(snapshot.model)
  const existing = snapshotsByModel.get(normalized) || {}
  existing[snapshot.source] = {
    ...snapshot,
    model: normalized,
    displayModel: resolveDisplayModel(normalized),
  }
  snapshotsByModel.set(normalized, existing)
}
