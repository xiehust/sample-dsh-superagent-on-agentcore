import type { SSMClient } from '@aws-sdk/client-ssm'
import { expect, it } from 'vitest'
import { WorkerVersion, type Logger } from '@dshsa/contracts'
import { SsmWorkerVersion } from '../src/aws/worker-version.ts'

function make(answer: () => Promise<unknown>) {
  const names: string[] = [], warnings: string[] = [], clock = { now: 0 }
  const client = { send: async (command: { input: { Name: string } }) => { names.push(command.input.Name); return answer() } } as unknown as SSMClient
  const log: Logger = { debug() {}, info() {}, error() {}, warn: message => { warnings.push(message) } }
  return { version: new SsmWorkerVersion(log, client, 60_000, () => clock.now), names, warnings, clock }
}

it('reads the contracts parameter and caches it for the TTL', async () => {
  const m = make(async () => ({ Parameter: { Value: 'abc123' } }))
  expect(await m.version.current()).toBe('abc123')
  m.clock.now = 59_999
  expect(await m.version.current()).toBe('abc123')
  expect(m.names).toEqual([WorkerVersion.parameter])
  m.clock.now = 60_000
  await m.version.current()
  expect(m.names).toHaveLength(2)
})

it('treats a missing or unreadable parameter as unknown, and warns once until it reads again', async () => {
  let fail = true
  const m = make(async () => { if (fail) throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' }); return { Parameter: { Value: 'v2' } } })
  expect(await m.version.current()).toBeUndefined()
  m.clock.now = 60_000
  expect(await m.version.current()).toBeUndefined()
  expect(m.warnings).toHaveLength(1)
  fail = false
  m.clock.now = 120_000
  expect(await m.version.current()).toBe('v2')
})

it('reads the per-type parameter of the Codex worker runtime (v7)', async () => {
  const names: string[] = []
  const client = { send: async (command: { input: { Name: string } }) => { names.push(command.input.Name); return { Parameter: { Value: 'c1' } } } } as unknown as SSMClient
  const version = new SsmWorkerVersion({ debug() {}, info() {}, warn() {}, error() {} }, client, 60_000, () => 0, 'codex')
  expect(await version.current()).toBe('c1')
  expect(names).toEqual(['/dshsa-worker-codex/version'])
  expect(WorkerVersion.parameters.codex).toBe('/dshsa-worker-codex/version')
})
