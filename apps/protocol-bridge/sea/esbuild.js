/**
 * esbuild configuration for Protocol Bridge SEA bundling.
 *
 * Uses @anatine/esbuild-decorators to properly handle NestJS's
 * emitDecoratorMetadata — falls back to tsc for files with decorators.
 *
 * Pipeline: esbuild + decorator plugin → single CJS file → SEA blob
 */
const esbuild = require("esbuild")
const path = require("path")
const fs = require("fs")
const { esbuildDecorators } = require("@anatine/esbuild-decorators")

// Plugin to redirect @nestjs/swagger to our no-op stub
const swaggerStubPlugin = {
  name: "swagger-stub",
  setup(build) {
    build.onResolve({ filter: /^@nestjs\/swagger$/ }, () => ({
      path: path.join(__dirname, "swagger-stub.js"),
    }))
  },
}

/**
 * Plugin to inline tiktoken WASM into the bundle.
 *
 * tiktoken/lite loads tiktoken_bg.wasm via fs.readFileSync(__dirname + '/tiktoken_bg.wasm').
 * In a SEA binary there is no filesystem — so we replace the tiktoken CJS module
 * with a patched version that embeds the WASM as a base64 Buffer.
 */
const tiktokenWasmPlugin = {
  name: "tiktoken-wasm-inline",
  setup(build) {
    // Read WASM once at build time
    const wasmPath = require.resolve("tiktoken/tiktoken_bg.wasm")
    const wasmBase64 = fs.readFileSync(wasmPath).toString("base64")
    console.log(
      `  [tiktoken-wasm] Inlining ${(fs.statSync(wasmPath).size / 1024 / 1024).toFixed(1)}MB WASM as base64`
    )

    // Intercept any tiktoken .cjs file that loads the WASM via fs.readFileSync
    build.onLoad(
      { filter: /tiktoken[\\/](lite[\\/])?tiktoken\.cjs$/ },
      (args) => {
        let source = fs.readFileSync(args.path, "utf-8")

        // Replace the filesystem-based WASM loading with inline Buffer.
        // Match the entire candidates-building + for-loop + error-throw block:
        //   const candidates = __dirname ... .reduce(...)
        //   candidates.unshift(...)
        //   let bytes = null;
        //   for (...) { try { ... break; } catch {} }
        //   if (bytes == null) throw ...
        source = source.replace(
          /const candidates = __dirname[\s\S]*?if \(bytes == null\) throw[^;]*;/,
          `const bytes = Buffer.from("${wasmBase64}", "base64");`
        )

        return { contents: source, loader: "js" }
      }
    )
  },
}

async function build() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, "sea-entry.ts")],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile: path.join(__dirname, "..", "dist", "sea-entry.js"),
    plugins: [
      esbuildDecorators({
        tsconfig: path.join(__dirname, "..", "tsconfig.build.json"),
      }),
      swaggerStubPlugin,
      tiktokenWasmPlugin,
    ],
    // Keep node built-ins and NestJS optional peer deps external
    external: [
      "node:*",
      "@nestjs/websockets",
      "@nestjs/websockets/*",
      "@nestjs/microservices",
      "@nestjs/microservices/*",
      "class-transformer/storage",
      "@fastify/view",
      "fsevents",
    ],
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    treeShaking: true,
    minify: false,
    sourcemap: false,
    logLevel: "info",
    mainFields: ["main", "module"],
    resolveExtensions: [".ts", ".js", ".json"],
    loader: {
      ".sql": "text",
    },
  })

  console.log("\n✅ SEA bundle ready: dist/sea-entry.js")
}

build().catch((err) => {
  console.error("Build failed:", err)
  process.exit(1)
})
