import * as esbuild from "esbuild"

const isProduction = process.argv.includes("--production")
const isWatch = process.argv.includes("--watch")

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"], // provided by Extension Host
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: !isProduction,
  minify: isProduction,
  treeShaking: true,
  logLevel: "info",
}

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions)
    await ctx.watch()
    console.log("[esbuild] Watching for changes...")
  } else {
    await esbuild.build(buildOptions)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
