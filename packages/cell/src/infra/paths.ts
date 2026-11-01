/* dshsa adapter of DSH src/infra/paths.ts: package name @dshsa/cell, DSHSA_ASSETS override for the bundled image. */
/** Resolves packaged asset paths from either the source tree or the compiled lib/ output. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | undefined
export function packageRoot(): string {
  if (cached) return cached
  // dshsa: the container image sets DSHSA_ASSETS to the directory holding prompts/ and skills/.
  if (process.env.DSHSA_ASSETS) return cached = process.env.DSHSA_ASSETS
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try { if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === '@dshsa/cell') return cached = directory }
      catch { /* A foreign package.json on the way up is not this package. */ }
    }
    directory = dirname(directory)
  }
  throw new Error('@dshsa/cell package root not found')
}
export const packagePath = (...parts: string[]): string => join(packageRoot(), ...parts)
