/** Guards the ESM bundle banner (build.mjs): bundled CommonJS code that reads __dirname / __filename or calls require() must run. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { build } from 'esbuild'
import { afterAll, expect, it } from 'vitest'
// @ts-expect-error build.mjs is plain JavaScript without declarations.
import { bundleOptions } from '../build.mjs'

const dir = mkdtempSync(join(tmpdir(), 'dshsa-bundle-'))
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

it('lets bundled CommonJS read __dirname and __filename and call require()', async () => {
  const entry = join(dir, 'entry.mjs'), outfile = join(dir, 'out', 'bundle.mjs')
  writeFileSync(entry, `import globals from ${JSON.stringify(join(import.meta.dirname, 'fixtures', 'cjs-globals.cjs'))}\n`
    + 'export const read = globals()\n'
    + "const top = { dirname: __dirname, filename: __filename, os: require('node:os').platform() }\n"
    + 'process.stdout.write(JSON.stringify({ read, top }))\n')
  await build({ ...bundleOptions, entryPoints: [entry], outfile, logLevel: 'silent' })
  // A plain node process, as in the container: vitest's module runner would define __dirname itself and hide a broken banner.
  const bundled = JSON.parse(execFileSync(process.execPath, [outfile], { encoding: 'utf8' })) as { read: Record<string, string>; top: Record<string, string> }
  expect(bundled.read).toMatchObject({ dirname: join(dir, 'out'), filename: outfile, sep })
  expect(bundled.read.resolved).toBe(join(dir, 'package.json'))
  expect(bundled.top).toMatchObject({ dirname: join(dir, 'out'), filename: outfile, os: process.platform })
})
