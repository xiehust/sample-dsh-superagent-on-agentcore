/** Vitest wiring of the fake panel-api (`fake-api-core.ts`): a fresh fake per test, and misuse fails the test. */
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { createFakeApi, type FakeApi } from './fake-api-core.ts'

export * from './fake-api-core.ts'

/** The fake API of the running test (live binding, replaced before each test). */
export let api: FakeApi
/** Installs a fresh fake API before each test and fails the test if the panel misused it. */
export function useFakeApi() {
  beforeEach(() => { api = createFakeApi(); vi.stubGlobal('fetch', api.fetch) })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    expect(api.misuse, 'requests the panel-api allowlist rejects').toEqual([])
  })
}
