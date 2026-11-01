// Bundles the host into one ESM file for the container (the core uses TS parameter properties, so Node's type stripping cannot run it).
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

/**
 * Prepended to the ESM bundle: some AWS SDK and Lark SDK dependencies still call require() or read __dirname / __filename
 * (the Lark SDK's version lookup), which ESM does not define. Guarded by tests/bundle.spec.ts; do not drop any of the three.
 */
export const banner = "import { createRequire as __dshsaRequire } from 'node:module'; import { fileURLToPath as __dshsaPath } from 'node:url'; import { dirname as __dshsaDir } from 'node:path';"
  + " const require = __dshsaRequire(import.meta.url); const __filename = __dshsaPath(import.meta.url); const __dirname = __dshsaDir(__filename);"

/** The esbuild options shared by the host bundle and its test. */
export const bundleOptions = { bundle: true, platform: 'node', format: 'esm', target: 'node24', banner: { js: banner }, logLevel: 'warning' }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await build({ ...bundleOptions, entryPoints: ['src/main.ts'], outfile: 'dist/host.mjs', sourcemap: true, define: { 'process.env.DSHSA_MAIN': '"1"' } })
}
