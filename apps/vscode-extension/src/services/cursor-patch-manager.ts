import { CursorChecksumsService } from "./cursor-checksums"
import {
  CursorPatchBaselineService,
  type CursorPatchResetResult,
} from "./cursor-patch-baseline"

export interface CursorPatchResetState {
  canReset: boolean
  hint: string
  managedFileCount: number
  hasUnmanagedAppliedPatches: boolean
}

export class CursorPatchManagerService {
  private readonly baseline = new CursorPatchBaselineService()
  private readonly checksums = new CursorChecksumsService()

  getResetState(): CursorPatchResetState {
    const baselineStatus = this.baseline.getStatus()
    const checksumsStatus = this.checksums.getStatus()
    const checksumPatched = checksumsStatus.differsFromBaseline === true
    const hasUnmanagedAppliedPatches =
      checksumPatched && !checksumsStatus.hasBaseline
    const managedFileCount = baselineStatus.trackedFiles.length
    const canReset =
      baselineStatus.manifestExists &&
      managedFileCount > 0 &&
      !hasUnmanagedAppliedPatches

    const hint = !baselineStatus.manifestExists
      ? "No original baseline has been captured yet. Apply a Cursor repair through CCursor first."
      : hasUnmanagedAppliedPatches
        ? "Some active checksum changes were applied before CCursor captured the original baseline, so one-click reset is currently unsafe."
        : `Restore ${managedFileCount} managed Cursor file(s) to the captured original baseline, then re-apply the repairs you still want.`

    return {
      canReset,
      hint,
      managedFileCount,
      hasUnmanagedAppliedPatches,
    }
  }

  resetAllPatches(): CursorPatchResetResult {
    const resetState = this.getResetState()
    if (!resetState.canReset) {
      return {
        success: false,
        restored: 0,
        errors: [resetState.hint],
      }
    }

    return this.baseline.resetAll()
  }
}
