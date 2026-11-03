/** Test Apps: each assembly goes to its own temp dir, removed after the spec file's tests (the Docker image assets make every
 *  assembly large; CDK's default outdir under os.tmpdir() is never cleaned up and once filled /tmp's inodes). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from 'aws-cdk-lib'
import { afterAll } from 'vitest'

const dirs: string[] = []
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A temp dir removed after this spec file's tests. */
export function tempDir(prefix = 'dshsa-cdk-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

export function testApp(context: Record<string, unknown> = {}): App {
  return new App({ outdir: tempDir(), context: { '@aws-cdk/core:defaultCrossStackReferences': 'strong', ...context } })
}
