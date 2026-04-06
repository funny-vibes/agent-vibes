import * as fs from "fs"
import type { logger as LoggerInstance } from "../utils/logger"
import { getCursorWorkbenchPath } from "../utils/platform"

type Logger = typeof LoggerInstance

const BACKUP_SUFFIX = ".transport_backup"

/**
 * Patch rules for Cursor's workbench.desktop.main.js.
 * Each rule identifies a code pattern via regex and injects logging hooks
 * to capture gRPC transport traffic (request/response payloads).
 */
interface PatchRule {
  name: string
  find: RegExp
  replace: string
  marker: string
}

const TRANSPORT_PATCHES: PatchRule[] = [
  {
    name: "Transport Request Initiation",
    find: /this\.structuredLogService\.debug\("transport","Initiating stream AI connect",\{service:e\.typeName,method:t\.name,streamId:(\w+),requestId:(\w+)\?\?"not-found"/,
    replace:
      'console.warn("[TRANSPORT_REQUEST]",JSON.stringify({service:e.typeName,method:t.name,streamId:$1,requestId:$2,requestType:t.I?.typeName,responseType:t.O?.typeName})),this.structuredLogService.debug("transport","Initiating stream AI connect",{service:e.typeName,method:t.name,streamId:$1,requestId:$2??"not-found"',
    marker: "[TRANSPORT_REQUEST]",
  },
  {
    name: "Transport Request Payload",
    find: /const (\w+)=new t\.I\((\w+)\);(\w+)=(\w+)\.wrap\(\1\.toBinary\(\)\)/,
    replace:
      'const $1=new t.I($2);(()=>{try{console.warn("[TRANSPORT_REQUEST_PAYLOAD]",JSON.stringify({type:t.I?.typeName,payload:$1.toJson?$1.toJson():$2}))}catch(xErr){console.warn("[TRANSPORT_REQUEST_PAYLOAD]",JSON.stringify({type:t.I?.typeName,error:String(xErr)}))}})();$3=$4.wrap($1.toBinary())',
    marker: "[TRANSPORT_REQUEST_PAYLOAD]",
  },
  {
    name: "Transport Response Chunk",
    find: /this\._proxy\.\$pushAiConnectTransportStreamChunk\((\w+),(\w+),(\w+)\)/,
    replace:
      '(console.warn("[TRANSPORT_CHUNK]",JSON.stringify({streamId:$2,chunkSize:$1?.length||0,chunkB64:$1?btoa(String.fromCharCode.apply(null,$1.slice(0,2000))):null})),this._proxy.$pushAiConnectTransportStreamChunk($1,$2,$3))',
    marker: "[TRANSPORT_CHUNK]",
  },
  {
    name: "Transport Response Yield",
    find: /for await\(const (\w+) of (\w+)\)\{if\((\w+)\.token\.isCancellationRequested\)continue;yield t\.O\.fromBinary\(\1\.buffer\)\}/,
    replace:
      'for await(const $1 of $2){if($3.token.isCancellationRequested)continue;const xResp=t.O.fromBinary($1.buffer);(()=>{try{console.warn("[TRANSPORT_RESPONSE]",JSON.stringify({type:t.O?.typeName,payload:xResp.toJson?xResp.toJson():xResp}))}catch(xErr){console.warn("[TRANSPORT_RESPONSE]",JSON.stringify({type:t.O?.typeName,error:String(xErr)}))}})();yield xResp}',
    marker: "[TRANSPORT_RESPONSE]",
  },
  {
    name: "Unary Request Payload",
    find: /const (\w+)=new a\.I\((\w+)\),(\w+)=(\w+)\.wrap\(\1\.toBinary\(\)\)/,
    replace:
      'const $1=new a.I($2);(()=>{try{const svc=o.typeName,mth=a.name;const skip=["GetTeams","GetUser","GetSubscription","CheckQueuePosition","FlushEvents","Batch","SubmitLogs","SubmitSpans","BootstrapStatsig","ReportClientNumericMetrics"];if(skip.includes(mth))return;console.warn("[UNARY_REQUEST]",JSON.stringify({service:svc,method:mth,type:a.I?.typeName,payload:$1.toJson?$1.toJson():$2}))}catch(xErr){console.warn("[UNARY_REQUEST]",JSON.stringify({service:o.typeName,method:a.name,type:a.I?.typeName,error:String(xErr)}))}})();const $3=$4.wrap($1.toBinary())',
    marker: "[UNARY_REQUEST]",
  },
  {
    name: "Unary Response",
    find: /const (\w+)=(\w+)\.message,(\w+)=\2\.header,(\w+)=\2\.trailer,(\w+)=a\.O\.fromBinary\(\1\)/,
    replace:
      'const $1=$2.message,$3=$2.header,$4=$2.trailer,$5=a.O.fromBinary($1);(()=>{try{const svc=o.typeName,mth=a.name;const skip=["GetTeams","GetUser","GetSubscription","CheckQueuePosition","FlushEvents","Batch","SubmitLogs","SubmitSpans","BootstrapStatsig","ReportClientNumericMetrics"];if(skip.includes(mth))return;console.warn("[UNARY_RESPONSE]",JSON.stringify({service:svc,method:mth,type:a.O?.typeName,payload:$5.toJson?$5.toJson():$5}))}catch(xErr){console.warn("[UNARY_RESPONSE]",JSON.stringify({service:o.typeName,method:a.name,type:a.O?.typeName,error:String(xErr)}))}})()',
    marker: "[UNARY_RESPONSE]",
  },
]

const PATCH_MARKERS = TRANSPORT_PATCHES.map((p) => p.marker)

export interface PatchStatus {
  filePath: string | null
  fileExists: boolean
  backupExists: boolean
  patches: Array<{ name: string; applied: boolean }>
  allApplied: boolean
  isPatched: boolean
}

/**
 * CursorPatchService — Manages patching and restoring Cursor's
 * workbench.desktop.main.js to inject transport-layer traffic capture.
 */
export class CursorPatchService {
  private readonly logger: Logger

  constructor(logger: Logger) {
    this.logger = logger
  }

  /** Get the current patch status of the Cursor installation */
  getStatus(): PatchStatus {
    const filePath = getCursorWorkbenchPath()
    const result: PatchStatus = {
      filePath,
      fileExists: false,
      backupExists: false,
      patches: [],
      allApplied: false,
      isPatched: false,
    }

    if (!filePath || !fs.existsSync(filePath)) {
      return result
    }

    result.fileExists = true
    result.backupExists = fs.existsSync(filePath + BACKUP_SUFFIX)

    const content = fs.readFileSync(filePath, "utf-8")
    result.isPatched = PATCH_MARKERS.some((m) => content.includes(m))
    result.patches = TRANSPORT_PATCHES.map((p) => ({
      name: p.name,
      applied: content.includes(p.marker),
    }))
    result.allApplied = result.patches.every((p) => p.applied)

    return result
  }

  /** Apply transport patches to Cursor workbench */
  applyPatches(): { success: boolean; applied: number; errors: string[] } {
    const errors: string[] = []
    const filePath = getCursorWorkbenchPath()

    if (!filePath || !fs.existsSync(filePath)) {
      return {
        success: false,
        applied: 0,
        errors: ["Cursor workbench file not found"],
      }
    }

    // Create backup if needed
    const backupPath = filePath + BACKUP_SUFFIX
    if (!fs.existsSync(backupPath)) {
      const content = fs.readFileSync(filePath, "utf-8")
      if (PATCH_MARKERS.some((m) => content.includes(m))) {
        return {
          success: false,
          applied: 0,
          errors: [
            "Cannot create clean backup — file is already patched. Reinstall Cursor first.",
          ],
        }
      }
      fs.copyFileSync(filePath, backupPath)
      this.logger.info("Created backup of Cursor workbench")
    }

    // Apply patches
    let content = fs.readFileSync(filePath, "utf-8")
    const original = content
    let applied = 0

    for (const patch of TRANSPORT_PATCHES) {
      if (content.includes(patch.marker)) {
        continue // already applied
      }
      if (patch.find.test(content)) {
        content = content.replace(patch.find, patch.replace)
        applied++
        this.logger.info(`Applied patch: ${patch.name}`)
      } else {
        errors.push(`Pattern not found: ${patch.name}`)
      }
    }

    if (content !== original) {
      fs.writeFileSync(filePath, content, "utf-8")
    }

    return { success: errors.length === 0, applied, errors }
  }

  /** Restore Cursor workbench from backup */
  restore(): boolean {
    const filePath = getCursorWorkbenchPath()
    if (!filePath) {
      this.logger.error("Cursor workbench file not found")
      return false
    }

    const backupPath = filePath + BACKUP_SUFFIX
    if (!fs.existsSync(backupPath)) {
      this.logger.error("No backup found — cannot restore")
      return false
    }

    const backupContent = fs.readFileSync(backupPath, "utf-8")
    if (PATCH_MARKERS.some((m) => backupContent.includes(m))) {
      this.logger.error("Backup file is corrupted (contains patches)")
      return false
    }

    fs.copyFileSync(backupPath, filePath)
    this.logger.info("Restored Cursor workbench from backup")
    return true
  }
}
