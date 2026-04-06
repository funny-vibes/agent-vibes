#!/usr/bin/env node
/**
 * Proto 文件生成器 v4
 *
 * 从 cursor_schema.json 生成正确的 .proto 文件：
 * 1. 保留原始包名（aiserver.v1, agent.v1, anyrun.v1 等）
 * 2. 包含所有 61 个 service 定义及 823+ 个方法
 * 3. 打断循环 import（用完整字段 placeholder 替代）
 *    - 打断 aiserver.v1 → agent.v1（27 PH 起始）
 *    - 打断 anyrun.v1 → aiserver.v1（2 PH 起始）
 * 4. Google WKT 使用 minimal stubs
 *
 * 用法:
 *   node proto_fixer.js [--verify]
 */
const fs = require("fs")
const path = require("path")
const { execSync } = require("child_process")
const { resolveCursorProtoExtractDir } = require("./paths")

// 配置
const OUTPUT_DIR = resolveCursorProtoExtractDir()
const INPUT = path.join(OUTPUT_DIR, "cursor_schema.json")
const PROTO_DIR = path.join(OUTPUT_DIR, "proto")
const COMBINED_OUTPUT = path.join(OUTPUT_DIR, "cursor.proto")

const SCALAR_TYPES = new Set([
  "double",
  "float",
  "int32",
  "int64",
  "uint32",
  "uint64",
  "sint32",
  "sint64",
  "fixed32",
  "fixed64",
  "sfixed32",
  "sfixed64",
  "bool",
  "string",
  "bytes",
  "group",
  "message",
  "enum",
])

const SKIP_PACKAGES = new Set(["google.protobuf", "google.protobuf.compiler"])

// 无法从 schema 解引用回真实包/类型名的混淆残留类型。
// 这类类型会被收敛为当前 package 内的占位类型，避免生成不可编译的 import。
let opaquePlaceholderTypes = new Map()

// Google 类型 → 文件映射
const GOOGLE_TYPE_TO_FILE = {
  "google.protobuf.Timestamp": "google/protobuf/timestamp.proto",
  "google.protobuf.Duration": "google/protobuf/duration.proto",
  "google.protobuf.Empty": "google/protobuf/empty.proto",
  "google.protobuf.Value": "google/protobuf/value.proto",
  "google.protobuf.Struct": "google/protobuf/value.proto",
  "google.protobuf.ListValue": "google/protobuf/value.proto",
  "google.protobuf.NullValue": "google/protobuf/value.proto",
  "google.protobuf.Any": "google/protobuf/any.proto",
  "google.protobuf.FieldMask": "google/protobuf/field_mask.proto",
  "google.protobuf.FileDescriptorProto": "google/protobuf/descriptor.proto",
  "google.protobuf.DescriptorProto": "google/protobuf/descriptor.proto",
}

// Minimal WKT stubs
const GOOGLE_STUBS = {
  "google/protobuf/empty.proto": `syntax = "proto3";\npackage google.protobuf;\nmessage Empty {}\n`,
  "google/protobuf/timestamp.proto": `syntax = "proto3";\npackage google.protobuf;\nmessage Timestamp {\n  int64 seconds = 1;\n  int32 nanos = 2;\n}\n`,
  "google/protobuf/duration.proto": `syntax = "proto3";\npackage google.protobuf;\nmessage Duration {\n  int64 seconds = 1;\n  int32 nanos = 2;\n}\n`,
  "google/protobuf/value.proto": `syntax = "proto3";\npackage google.protobuf;\nenum NullValue {\n  NULL_VALUE = 0;\n}\nmessage Value {\n  oneof kind {\n    NullValue null_value = 1;\n    double number_value = 2;\n    string string_value = 3;\n    bool bool_value = 4;\n    Struct struct_value = 5;\n    ListValue list_value = 6;\n  }\n}\nmessage ListValue {\n  repeated Value values = 1;\n}\nmessage Struct {\n  map<string, Value> fields = 1;\n}\n`,
  "google/protobuf/struct.proto": `syntax = "proto3";\npackage google.protobuf;\nimport "google/protobuf/value.proto";\n// Struct is defined in value.proto to avoid circular import\n`,
  "google/protobuf/any.proto": `syntax = "proto3";\npackage google.protobuf;\nmessage Any {\n  string type_url = 1;\n  bytes value = 2;\n}\n`,
  "google/protobuf/field_mask.proto": `syntax = "proto3";\npackage google.protobuf;\nmessage FieldMask {\n  repeated string paths = 1;\n}\n`,
  "google/protobuf/descriptor.proto": `syntax = "proto3";\npackage google.protobuf;\nmessage FileDescriptorProto {\n  string name = 1;\n  string package = 2;\n  repeated string dependency = 3;\n  repeated int32 public_dependency = 10;\n  repeated int32 weak_dependency = 11;\n  string syntax = 12;\n  string edition = 14;\n}\nmessage DescriptorProto {\n  string name = 1;\n}\n`,
}

// ============================================================
// 辅助函数
// ============================================================

function getPackage(fullName) {
  for (const prefix of [
    "google.protobuf.compiler",
    "google.protobuf",
    "google.rpc",
  ]) {
    if (fullName.startsWith(prefix + ".") || fullName === prefix) return prefix
  }
  const parts = fullName.split(".")
  if (parts.length >= 3) return parts[0] + "." + parts[1]
  return parts.slice(0, -1).join(".") || fullName
}

function shortName(fullName, pkg) {
  if (fullName.startsWith(pkg + ".")) return fullName.slice(pkg.length + 1)
  return fullName
}

function pkgToFilePath(pkg) {
  return pkg.replace(/\./g, "/") + ".proto"
}

function isOpaqueTypeName(typeName) {
  if (!typeName || typeof typeName !== "string") return false
  if (SCALAR_TYPES.has(typeName)) return false
  if (typeName.startsWith("map<")) return false
  if (typeName.startsWith("google.")) return false
  if (/^[a-z]+\.[a-z0-9]+(\.|$)/.test(typeName)) return false
  if (
    /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(typeName)
  ) {
    return true
  }
  if (/^[A-Za-z_$][\w$]*$/.test(typeName)) {
    return true
  }
  return false
}

function ensureOpaquePlaceholder(pkg, typeName) {
  if (!opaquePlaceholderTypes.has(pkg))
    opaquePlaceholderTypes.set(pkg, new Set())
  opaquePlaceholderTypes.get(pkg).add(typeName)
}

// T 值 → proto 标量类型
const T_TO_SCALAR = {
  1: "double",
  2: "float",
  3: "int64",
  4: "uint64",
  5: "int32",
  6: "fixed64",
  7: "fixed32",
  8: "bool",
  9: "string",
  10: "group",
  11: "message",
  12: "bytes",
  13: "uint32",
  14: "enum",
  15: "sfixed32",
  16: "sfixed64",
  17: "sint32",
  18: "sint64",
}

function fieldTypeStr(field) {
  if (field.kind === "scalar") return T_TO_SCALAR[field.T] || "bytes"
  if (field.kind === "enum" || field.kind === "message")
    return field.resolvedType || "bytes"
  if (field.kind === "map") {
    const keyType = T_TO_SCALAR[field.K] || "string"
    let valType
    if (field.mapValueType) {
      if (field.mapValueType.kind === "scalar")
        valType = T_TO_SCALAR[field.mapValueType.T] || "bytes"
      else
        valType =
          field.resolvedMapValueType ||
          field.mapValueType.resolvedType ||
          "bytes"
    } else {
      valType = field.resolvedMapValueType || "bytes"
    }
    return `map<${keyType}, ${valType}>`
  }
  return "bytes"
}

// ============================================================
// 循环打断 + Placeholder
// ============================================================

// 被打断的 import 边 Set<"srcPkg:dstPkg">
let brokenEdges = new Set()

// placeholder 类型 Map<pkg, Set<fullTypeName>>
let placeholderTypes = new Map()
let directPlaceholderTypes = new Map()

// 判断引用是否需要 placeholder
function needsPlaceholder(typeName, currentPkg) {
  const refPkg = getPackage(typeName)
  return refPkg !== currentPkg && brokenEdges.has(`${currentPkg}:${refPkg}`)
}

// PH 名：将全限定名转为 PH_xxx_yyy_Type
function toPlaceholderName(fullTypeName) {
  return "PH_" + fullTypeName.replace(/\./g, "_")
}

// 缩短跨包引用（考虑 placeholder）
function shortenRef(typeName, currentPkg) {
  if (SCALAR_TYPES.has(typeName)) return typeName
  if (typeName.startsWith("map<")) return typeName

  if (isOpaqueTypeName(typeName)) {
    ensureOpaquePlaceholder(currentPkg, typeName)
    return toPlaceholderName(typeName)
  }

  // 如果需要 placeholder
  if (needsPlaceholder(typeName, currentPkg)) {
    return toPlaceholderName(typeName)
  }

  const refPkg = getPackage(typeName)
  if (refPkg === currentPkg) return shortName(typeName, currentPkg)
  return typeName // 跨包全限定名
}

// 收集 placeholder 类型（区分直接引用和递归展开）
// 返回 { all: Map<pkg, Set>, direct: Map<pkg, Set> }
function collectPlaceholderTypes(pkgData, schema) {
  const direct = new Map() // pkg -> Set<fullTypeName>（直接被字段/IO引用）
  const all = new Map() // pkg -> Set<fullTypeName>（含递归展开）

  // 第一轮：收集直接引用
  for (const [pkg, data] of Object.entries(pkgData)) {
    if (SKIP_PACKAGES.has(pkg)) continue

    for (const def of Object.values(data.messages)) {
      if (!def.fields) continue
      for (const f of def.fields) {
        checkAndAddPH(f, pkg, direct, schema)
      }
    }

    // service IO 类型
    for (const svc of Object.values(data.services || {})) {
      for (const m of svc.methods) {
        for (const t of [m.inputType, m.outputType]) {
          if (needsPlaceholder(t, pkg)) {
            if (!direct.has(pkg)) direct.set(pkg, new Set())
            direct.get(pkg).add(t)
          }
        }
      }
    }
  }

  // 复制 direct → all
  for (const [pkg, set] of direct) {
    all.set(pkg, new Set(set))
  }

  // 递归展开：直接 PH 字段引用的被打断包类型
  let changed = true
  while (changed) {
    changed = false
    for (const [pkg, phSet] of all) {
      const newPHs = []
      for (const fullName of phSet) {
        const def = schema.messages[fullName]
        if (!def || !def.fields) continue

        for (const f of def.fields) {
          const refs = []
          if (f.resolvedType) refs.push(f.resolvedType)
          if (f.resolvedMapValueType) refs.push(f.resolvedMapValueType)
          for (const ref of refs) {
            const refPkg = getPackage(ref)
            if (
              refPkg !== pkg &&
              brokenEdges.has(`${pkg}:${refPkg}`) &&
              !phSet.has(ref)
            ) {
              newPHs.push(ref)
            }
          }
        }
      }
      for (const ph of newPHs) {
        phSet.add(ph)
        changed = true
      }
    }
  }

  return { all, direct }
}

function checkAndAddPH(f, pkg, result, schema) {
  const refs = []
  if (f.resolvedType) refs.push(f.resolvedType)
  if (f.resolvedMapValueType) refs.push(f.resolvedMapValueType)
  for (const ref of refs) {
    if (needsPlaceholder(ref, pkg)) {
      if (!result.has(pkg)) result.set(pkg, new Set())
      result.get(pkg).add(ref)
    }
  }
}

// 检测循环并打断（打断引用最少的边）
function detectAndBreakCycles(pkgData, schema) {
  // 构建 import 图
  const edges = {}
  for (const [pkg, data] of Object.entries(pkgData)) {
    if (SKIP_PACKAGES.has(pkg)) continue
    edges[pkg] = new Set()

    for (const def of Object.values(data.messages)) {
      if (!def.fields) continue
      for (const f of def.fields) {
        const refs = [f.resolvedType, f.resolvedMapValueType].filter(Boolean)
        for (const ref of refs) {
          const refPkg = getPackage(ref)
          if (
            refPkg !== pkg &&
            !SKIP_PACKAGES.has(refPkg) &&
            !refPkg.startsWith("google.")
          ) {
            edges[pkg].add(refPkg)
          }
        }
      }
    }

    for (const svc of Object.values(data.services || {})) {
      for (const m of svc.methods) {
        for (const t of [m.inputType, m.outputType]) {
          const refPkg = getPackage(t)
          if (
            refPkg !== pkg &&
            !SKIP_PACKAGES.has(refPkg) &&
            !refPkg.startsWith("google.")
          ) {
            edges[pkg].add(refPkg)
          }
        }
      }
    }
  }

  // 统计每条边的跨包引用数
  function countRefs(srcPkg, dstPkg) {
    let count = 0
    const data = pkgData[srcPkg]
    if (!data) return 0

    for (const def of Object.values(data.messages)) {
      if (!def.fields) continue
      for (const f of def.fields) {
        const refs = [f.resolvedType, f.resolvedMapValueType].filter(Boolean)
        for (const ref of refs) {
          if (getPackage(ref) === dstPkg) count++
        }
      }
    }

    for (const svc of Object.values(data.services || {})) {
      for (const m of svc.methods) {
        for (const t of [m.inputType, m.outputType]) {
          if (getPackage(t) === dstPkg) count++
        }
      }
    }

    return count
  }

  // DFS 找环并打断
  // 策略：选择 src 包类型数最少的边打断（让小包持有 PH，避免大包膨胀）
  const broken = new Set()
  const visited = new Set()
  const inStack = new Set()

  // 包大小（类型数）
  function pkgSize(pkg) {
    const d = pkgData[pkg]
    if (!d) return 0
    return Object.keys(d.messages).length + Object.keys(d.enums).length
  }

  function dfs(node, pathArr) {
    if (inStack.has(node)) {
      const cycleStart = pathArr.indexOf(node)
      const cycle = pathArr.slice(cycleStart)
      cycle.push(node)

      // 选择 src 包类型数最少的边来打断
      let bestEdge = null
      let bestScore = Infinity
      for (let i = 0; i < cycle.length - 1; i++) {
        const src = cycle[i]
        const dst = cycle[i + 1]
        const key = `${src}:${dst}`
        if (broken.has(key)) return // 已打断
        // 分数 = src 包的类型数 * 引用数（越小越好）
        const score = pkgSize(src) * countRefs(src, dst)
        if (score < bestScore) {
          bestScore = score
          bestEdge = key
        }
      }

      if (bestEdge && !broken.has(bestEdge)) {
        broken.add(bestEdge)
        const [src, dst] = bestEdge.split(":")
        const refs = countRefs(src, dst)
        console.log(
          `  打断循环边: ${src} → ${dst} (${refs} 个引用, src 包 ${pkgSize(src)} 类型)`
        )
        edges[src].delete(dst)
      }
      return
    }

    if (visited.has(node)) return
    visited.add(node)
    inStack.add(node)
    pathArr.push(node)

    for (const neighbor of edges[node] || []) {
      dfs(neighbor, [...pathArr])
    }

    inStack.delete(node)
  }

  for (const pkg of Object.keys(edges)) {
    visited.clear()
    inStack.clear()
    dfs(pkg, [])
  }

  if (broken.size === 0) console.log("  无循环")
  return broken
}

// ============================================================
// 核心逻辑
// ============================================================

function main() {
  console.log("读取 schema...")
  const schema = JSON.parse(fs.readFileSync(INPUT, "utf-8"))

  // 1. 按 package 分组
  console.log("\n按 package 分组...")
  const pkgData = {} // pkg -> { messages: {}, enums: {}, services: {} }

  for (const [fullName, def] of Object.entries(schema.messages)) {
    const pkg = getPackage(fullName)
    if (!pkgData[pkg]) pkgData[pkg] = { messages: {}, enums: {}, services: {} }
    pkgData[pkg].messages[fullName] = def
  }

  for (const [fullName, def] of Object.entries(schema.enums)) {
    const pkg = getPackage(fullName)
    if (!pkgData[pkg]) pkgData[pkg] = { messages: {}, enums: {}, services: {} }
    pkgData[pkg].enums[fullName] = def
  }

  for (const [fullName, def] of Object.entries(schema.services)) {
    const pkg = getPackage(fullName)
    if (!pkgData[pkg]) pkgData[pkg] = { messages: {}, enums: {}, services: {} }
    pkgData[pkg].services[fullName] = def
  }

  const pkgList = Object.keys(pkgData)
    .filter((p) => !SKIP_PACKAGES.has(p))
    .sort()
  console.log(
    `发现 ${Object.keys(pkgData).length} 个 package (${pkgList.length} 个非 Google)\n`
  )
  for (const pkg of pkgList) {
    const d = pkgData[pkg]
    console.log(
      `  ${pkg}: ${Object.keys(d.messages).length} msg, ${Object.keys(d.enums).length} enum, ${Object.keys(d.services).length} svc`
    )
  }

  // 2. 检测循环并打断（--no-ph 模式跳过）
  const noPH = process.argv.includes("--no-ph")
  if (noPH) {
    console.log(
      "\n--no-ph 模式：跳过循环打断，保留循环 import（protoc 不可编译）"
    )
    brokenEdges = new Set()
  } else {
    console.log("\n检测循环 import...")
    brokenEdges = detectAndBreakCycles(pkgData, schema)
  }

  // 3. 收集 placeholder 类型
  const phResult = collectPlaceholderTypes(pkgData, schema)
  placeholderTypes = phResult.all
  directPlaceholderTypes = phResult.direct
  for (const [pkg, phSet] of placeholderTypes) {
    const directCount = directPlaceholderTypes.get(pkg)?.size || 0
    console.log(
      `  ${pkg}: ${phSet.size} 个 PH（${directCount} 直接 + ${phSet.size - directCount} 递归空壳）`
    )
  }

  // 4. 收集 import 关系
  const importGraph = {}
  for (const pkg of pkgList) {
    importGraph[pkg] = collectImports(pkg, pkgData[pkg], schema)
  }

  // 5. 生成 .proto 文件
  console.log("\n生成 .proto 文件...")
  const outputs = {}

  for (const pkg of pkgList) {
    const filePath = pkgToFilePath(pkg)
    const content = generatePackageProto(
      pkg,
      pkgData[pkg],
      schema,
      importGraph[pkg]
    )
    outputs[filePath] = content
    console.log(`  写入 ${filePath} (${content.split("\n").length} 行)`)
  }

  // 6. Google WKT stubs
  const usedGoogleFiles = collectUsedGoogleFiles(pkgList, pkgData, importGraph)
  for (const [filePath, stub] of Object.entries(GOOGLE_STUBS)) {
    if (usedGoogleFiles.has(filePath)) {
      outputs[filePath] = stub
      console.log(`  写入 ${filePath} (stub)`)
    }
  }

  // 7. 写入文件
  if (fs.existsSync(PROTO_DIR)) fs.rmSync(PROTO_DIR, { recursive: true })
  for (const [filePath, content] of Object.entries(outputs)) {
    const fullPath = path.join(PROTO_DIR, filePath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content)
  }

  // 8. 合并参考文件
  generateCombinedProto(pkgData, schema, pkgList)

  // 9. 验证
  if (process.argv.includes("--verify")) verify(outputs)

  console.log(`\n完成！`)
  console.log(`  独立文件: ${PROTO_DIR}/`)
  console.log(`  合并参考: ${COMBINED_OUTPUT}`)
}

// ============================================================
// Import 收集（排除被打断的边）
// ============================================================

function collectImports(pkg, data, schema) {
  const imports = new Set()

  function addRef(typeName) {
    if (!typeName || SCALAR_TYPES.has(typeName) || typeName.startsWith("map<"))
      return
    if (isOpaqueTypeName(typeName)) {
      ensureOpaquePlaceholder(pkg, typeName)
      return
    }
    const refPkg = getPackage(typeName)

    // 跳过被打断的边
    if (brokenEdges.has(`${pkg}:${refPkg}`)) return

    if (refPkg !== pkg && !SKIP_PACKAGES.has(refPkg)) {
      imports.add(refPkg)
    }
    if (GOOGLE_TYPE_TO_FILE[typeName]) imports.add(getPackage(typeName))
  }

  for (const def of Object.values(data.messages)) {
    if (!def.fields) continue
    for (const f of def.fields) {
      if (f.resolvedType) addRef(f.resolvedType)
      if (f.resolvedMapValueType) addRef(f.resolvedMapValueType)
    }
  }

  for (const svc of Object.values(data.services || {})) {
    for (const m of svc.methods) {
      addRef(m.inputType)
      addRef(m.outputType)
    }
  }

  return imports
}

function collectUsedGoogleFiles(pkgList, pkgData, importGraph) {
  const used = new Set()
  for (const pkg of pkgList) {
    for (const imp of importGraph[pkg]) {
      if (imp.startsWith("google.")) {
        const fp = pkgToFilePath(imp)
        if (GOOGLE_STUBS[fp]) used.add(fp)
      }
    }
    const data = pkgData[pkg]
    for (const def of Object.values(data.messages)) {
      if (!def.fields) continue
      for (const f of def.fields) {
        for (const ref of [f.resolvedType, f.resolvedMapValueType].filter(
          Boolean
        )) {
          if (GOOGLE_TYPE_TO_FILE[ref]) used.add(GOOGLE_TYPE_TO_FILE[ref])
        }
      }
    }
  }
  return used
}

// ============================================================
// 生成单个 package 的 .proto 文件
// ============================================================

function generatePackageProto(pkg, data, schema, imports) {
  const lines = []

  lines.push('syntax = "proto3";')
  lines.push(`package ${pkg};`)
  lines.push("")

  // imports（排除被打断的）
  const importFiles = new Set()

  // 非 Google 包的 import（从 importGraph 排除被打断的边）
  for (const impPkg of imports) {
    if (SKIP_PACKAGES.has(impPkg)) continue
    if (!impPkg.startsWith("google.")) {
      importFiles.add(pkgToFilePath(impPkg))
    }
  }

  // Google 类型 import：直接从字段、service IO 和 PH 字段收集（不依赖 importGraph）
  function addGoogleRef(ref) {
    if (ref && GOOGLE_TYPE_TO_FILE[ref])
      importFiles.add(GOOGLE_TYPE_TO_FILE[ref])
  }

  for (const def of Object.values(data.messages)) {
    if (!def.fields) continue
    for (const f of def.fields) {
      addGoogleRef(f.resolvedType)
      addGoogleRef(f.resolvedMapValueType)
    }
  }
  for (const svc of Object.values(data.services || {})) {
    for (const m of svc.methods) {
      addGoogleRef(m.inputType)
      addGoogleRef(m.outputType)
    }
  }
  // PH 字段也可能引用 Google 类型
  const phSetForImport = placeholderTypes.get(pkg)
  if (phSetForImport) {
    for (const phTypeName of phSetForImport) {
      const def = schema.messages[phTypeName]
      if (!def || !def.fields) continue
      for (const f of def.fields) {
        addGoogleRef(f.resolvedType)
        addGoogleRef(f.resolvedMapValueType)
        // PH 字段引用的非 Google 跨包类型也需要 import
        for (const ref of [f.resolvedType, f.resolvedMapValueType].filter(
          Boolean
        )) {
          if (SCALAR_TYPES.has(ref) || ref.startsWith("map<")) continue
          const refPkg = getPackage(ref)
          if (
            refPkg !== pkg &&
            !SKIP_PACKAGES.has(refPkg) &&
            !brokenEdges.has(`${pkg}:${refPkg}`)
          ) {
            if (!refPkg.startsWith("google.")) {
              importFiles.add(pkgToFilePath(refPkg))
            }
          }
        }
      }
    }
  }

  for (const f of [...importFiles].sort()) {
    lines.push(`import "${f}";`)
  }
  if (importFiles.size > 0) lines.push("")

  // enums（顶层）
  const topEnums = Object.entries(data.enums)
    .filter(([n]) => !shortName(n, pkg).includes("."))
    .sort((a, b) => a[0].localeCompare(b[0]))

  for (const [fullName, def] of topEnums) {
    writeEnum(lines, shortName(fullName, pkg), def, 0)
    lines.push("")
  }

  // messages（顶层）
  const topMsgs = Object.entries(data.messages)
    .filter(([n]) => !shortName(n, pkg).includes("."))
    .sort((a, b) => a[0].localeCompare(b[0]))

  for (const [fullName, def] of topMsgs) {
    writeMessage(lines, fullName, shortName(fullName, pkg), def, pkg, schema, 0)
    lines.push("")
  }

  // placeholder types
  const phSet = placeholderTypes.get(pkg)
  const directSet = directPlaceholderTypes.get(pkg) || new Set()
  const opaqueSet = opaquePlaceholderTypes.get(pkg) || new Set()
  if ((phSet && phSet.size > 0) || opaqueSet.size > 0) {
    const phCount = phSet?.size || 0
    lines.push("// ============================")
    lines.push(
      `// Placeholder types (${directSet.size} direct + ${Math.max(phCount - directSet.size, 0)} recursive-shell + ${opaqueSet.size} opaque)`
    )
    lines.push("// ============================")
    lines.push("")
    if (phSet && phSet.size > 0) {
      writePlaceholders(lines, phSet, directSet, pkg, schema)
    }
    if (opaqueSet.size > 0) {
      writeOpaquePlaceholders(lines, opaqueSet)
    }
  }

  // services
  for (const [fullName, def] of Object.entries(data.services).sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    writeService(lines, fullName, def, pkg)
    lines.push("")
  }

  return lines.join("\n")
}

// ============================================================
// 输出辅助
// ============================================================

function writeEnum(lines, name, def, indent) {
  const pad = "  ".repeat(indent)
  lines.push(`${pad}enum ${name} {`)
  if (def.values) {
    for (const v of def.values) {
      lines.push(`${pad}  ${v.name} = ${v.number};`)
    }
  }
  lines.push(`${pad}}`)
}

// PH enum：值名加 PH_ 前缀避免 proto3 同 scope 冲突
function writePHEnum(lines, name, def, indent) {
  const pad = "  ".repeat(indent)
  lines.push(`${pad}enum ${name} {`)
  if (def.values) {
    for (const v of def.values) {
      lines.push(`${pad}  PH_${v.name} = ${v.number};`)
    }
  }
  lines.push(`${pad}}`)
}

function writeMessage(
  lines,
  fullName,
  displayName,
  def,
  currentPkg,
  schema,
  indent
) {
  const pad = "  ".repeat(indent)
  lines.push(`${pad}message ${displayName} {`)

  // 嵌套 enum
  const nestedEnums = Object.entries(schema.enums)
    .filter(
      ([n]) =>
        n.startsWith(fullName + ".") &&
        !n.slice(fullName.length + 1).includes(".")
    )
    .sort((a, b) => a[0].localeCompare(b[0]))

  for (const [n, d] of nestedEnums) {
    writeEnum(lines, n.slice(fullName.length + 1), d, indent + 1)
    lines.push("")
  }

  // 嵌套 message
  const nestedMsgs = Object.entries(schema.messages)
    .filter(
      ([n]) =>
        n.startsWith(fullName + ".") &&
        !n.slice(fullName.length + 1).includes(".")
    )
    .sort((a, b) => a[0].localeCompare(b[0]))

  for (const [n, d] of nestedMsgs) {
    writeMessage(
      lines,
      n,
      n.slice(fullName.length + 1),
      d,
      currentPkg,
      schema,
      indent + 1
    )
    lines.push("")
  }

  // 字段
  if (def.fields && def.fields.length > 0) {
    writeFields(lines, def.fields, currentPkg, indent + 1)
  }

  lines.push(`${pad}}`)
}

function writeFields(lines, fields, currentPkg, indent) {
  const pad = "  ".repeat(indent)
  const oneofGroups = {}
  const regularFields = []

  for (const f of fields) {
    if (f.oneof) {
      if (!oneofGroups[f.oneof]) oneofGroups[f.oneof] = []
      oneofGroups[f.oneof].push(f)
    } else {
      regularFields.push(f)
    }
  }

  for (const [oneofName, oneofFields] of Object.entries(oneofGroups)) {
    lines.push(`${pad}oneof ${oneofName} {`)
    for (const f of oneofFields) {
      const typeStr = resolveFieldType(f, currentPkg)
      lines.push(`${pad}  ${typeStr} ${f.name} = ${f.fieldNumber};`)
    }
    lines.push(`${pad}}`)
  }

  for (const f of regularFields) {
    const typeStr = resolveFieldType(f, currentPkg)
    const repeated = f.repeated ? "repeated " : ""
    const optional = f.optional ? "optional " : ""
    if (typeStr.startsWith("map<")) {
      lines.push(`${pad}${typeStr} ${f.name} = ${f.fieldNumber};`)
    } else {
      lines.push(
        `${pad}${repeated}${optional}${typeStr} ${f.name} = ${f.fieldNumber};`
      )
    }
  }
}

function resolveFieldType(field, currentPkg) {
  const raw = fieldTypeStr(field)
  if (SCALAR_TYPES.has(raw)) return raw
  if (raw.startsWith("map<")) {
    const match = raw.match(/^map<(\w+),\s*(.+)>$/)
    if (match) {
      const valType = match[2]
      const resolvedVal = SCALAR_TYPES.has(valType)
        ? valType
        : shortenRef(valType, currentPkg)
      return `map<${match[1]}, ${resolvedVal}>`
    }
    return raw
  }
  return shortenRef(raw, currentPkg)
}

function writeService(lines, fullName, def, currentPkg) {
  const svcName = shortName(fullName, currentPkg)
  lines.push(`service ${svcName} {`)

  for (const m of def.methods) {
    const inputShort = shortenRef(m.inputType, currentPkg)
    const outputShort = shortenRef(m.outputType, currentPkg)

    if (m.kind === "server_streaming") {
      lines.push(
        `  rpc ${m.name} (${inputShort}) returns (stream ${outputShort});`
      )
    } else if (m.kind === "client_streaming") {
      lines.push(
        `  rpc ${m.name} (stream ${inputShort}) returns (${outputShort});`
      )
    } else if (m.kind === "bidi_streaming") {
      lines.push(
        `  rpc ${m.name} (stream ${inputShort}) returns (stream ${outputShort});`
      )
    } else {
      lines.push(`  rpc ${m.name} (${inputShort}) returns (${outputShort});`)
    }
  }

  lines.push("}")
}

// ============================================================
// Placeholder 输出（完整字段定义）
// ============================================================

function writePlaceholders(lines, phTypes, directSet, currentPkg, schema) {
  for (const fullName of [...phTypes].sort()) {
    const phName = toPlaceholderName(fullName)
    const isDirect = directSet.has(fullName)

    // enum 定义
    if (schema.enums[fullName]) {
      lines.push(
        `// placeholder for ${fullName}${isDirect ? "" : " (recursive)"}`
      )
      writePHEnum(lines, phName, schema.enums[fullName], 0)
      lines.push("")
      continue
    }

    // message 定义
    const def = schema.messages[fullName]
    if (!isDirect || !def || !def.fields || def.fields.length === 0) {
      // 递归 PH 或无字段的：只输出空壳
      lines.push(
        `message ${phName} {} // placeholder for ${fullName}${isDirect ? "" : " (recursive)"}`
      )
      lines.push("")
      continue
    }

    // 直接 PH：完整字段定义
    lines.push(`message ${phName} { // placeholder for ${fullName}`)
    writePlaceholderFields(lines, def, currentPkg, schema)
    lines.push("}")
    lines.push("")
  }
}

function writePlaceholderFields(lines, def, currentPkg, schema) {
  if (!def.fields) return

  const oneofGroups = {}
  const regularFields = []
  for (const f of def.fields) {
    if (f.oneof) {
      if (!oneofGroups[f.oneof]) oneofGroups[f.oneof] = []
      oneofGroups[f.oneof].push(f)
    } else {
      regularFields.push(f)
    }
  }

  for (const [oneofName, fields] of Object.entries(oneofGroups)) {
    lines.push(`  oneof ${oneofName} {`)
    for (const f of fields) {
      const typeStr = resolvePHFieldType(f, currentPkg)
      lines.push(`    ${typeStr} ${f.name} = ${f.fieldNumber};`)
    }
    lines.push("  }")
  }

  for (const f of regularFields) {
    const typeStr = resolvePHFieldType(f, currentPkg)
    const repeated = f.repeated ? "repeated " : ""
    const optional = f.optional ? "optional " : ""
    if (typeStr.startsWith("map<")) {
      lines.push(`  ${typeStr} ${f.name} = ${f.fieldNumber};`)
    } else {
      lines.push(
        `  ${repeated}${optional}${typeStr} ${f.name} = ${f.fieldNumber};`
      )
    }
  }
}

function resolvePHFieldType(field, currentPkg) {
  const raw = fieldTypeStr(field)
  if (SCALAR_TYPES.has(raw)) return raw
  if (raw.startsWith("map<")) {
    const match = raw.match(/^map<(\w+),\s*(.+)>$/)
    if (match) {
      const valType = match[2]
      const resolvedVal = SCALAR_TYPES.has(valType)
        ? valType
        : shortenRef(valType, currentPkg)
      return `map<${match[1]}, ${resolvedVal}>`
    }
    return raw
  }

  // 在 placeholder 上下文中，对需要 PH 的引用使用 PH 名
  return shortenRef(raw, currentPkg)
}

function writeOpaquePlaceholders(lines, opaqueSet) {
  for (const fullName of [...opaqueSet].sort()) {
    const phName = toPlaceholderName(fullName)
    lines.push(`message ${phName} {} // opaque placeholder for ${fullName}`)
    lines.push("")
  }
}

// ============================================================
// 合并参考文件
// ============================================================

function generateCombinedProto(pkgData, schema, pkgList) {
  const lines = [
    'syntax = "proto3";',
    "// 合并参考文件（不可编译，仅供查阅）",
    "",
  ]

  for (const pkg of pkgList) {
    lines.push(`// ============= package ${pkg} =============`)
    lines.push(`// package ${pkg};`)
    lines.push("")

    const data = pkgData[pkg]
    for (const [n, d] of Object.entries(data.enums)
      .filter(([n]) => !shortName(n, pkg).includes("."))
      .sort((a, b) => a[0].localeCompare(b[0]))) {
      writeEnum(lines, shortName(n, pkg), d, 0)
      lines.push("")
    }
    for (const [n, d] of Object.entries(data.messages)
      .filter(([n]) => !shortName(n, pkg).includes("."))
      .sort((a, b) => a[0].localeCompare(b[0]))) {
      writeMessage(lines, n, shortName(n, pkg), d, pkg, schema, 0)
      lines.push("")
    }
    for (const [n, d] of Object.entries(data.services).sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      writeService(lines, n, d, pkg)
      lines.push("")
    }
  }

  fs.writeFileSync(COMBINED_OUTPUT, lines.join("\n"))
  console.log(`\n合并版: ${COMBINED_OUTPUT} (${lines.length} 行)`)
}

// ============================================================
// 验证
// ============================================================

function verify(outputs) {
  console.log("\n" + "=".repeat(60))
  console.log("验证")
  console.log("=".repeat(60))

  let hasProtoc = false
  try {
    execSync("which protoc 2>/dev/null", { stdio: "pipe" })
    hasProtoc = true
  } catch {}

  let hasBuf = false
  try {
    execSync("which buf 2>/dev/null", { stdio: "pipe" })
    hasBuf = true
  } catch {}

  if (!hasProtoc && !hasBuf) {
    console.log("  未找到 protoc 或 buf，跳过验证")
    return
  }

  // protoc 验证（循环已打断，应该能通过）
  if (hasProtoc) {
    console.log("使用 protoc 验证...\n")
    const protoFiles = Object.keys(outputs).filter(
      (f) => !f.startsWith("google/")
    )
    let pass = 0
    let fail = 0
    const errors = []

    for (const file of protoFiles.sort()) {
      try {
        execSync(
          `protoc --proto_path=${PROTO_DIR} --descriptor_set_out=/dev/null ${file}`,
          {
            cwd: PROTO_DIR,
            stdio: "pipe",
          }
        )
        console.log(`  ✅ ${file}`)
        pass++
      } catch (e) {
        const errMsg = (e.stderr || "").toString().trim()
        console.log(`  ❌ ${file}`)
        errors.push({ file, error: errMsg })
        fail++
      }
    }

    console.log(`\n验证结果: ${pass}/${protoFiles.length} 通过, ${fail} 个错误`)
    if (errors.length > 0) {
      console.log("\n错误详情:")
      for (const e of errors.slice(0, 10)) {
        console.log(`  ${e.file}:`)
        for (const line of e.error.split("\n").slice(0, 5)) {
          console.log(`    ${line}`)
        }
      }
    }
  }
}

// ============================================================
main()
