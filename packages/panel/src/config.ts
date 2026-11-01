/** Runtime config served next to the SPA as `/config.json` (written by CDK BucketDeployment; see `public/config.example.json`). */
import type { RuntimeConfig } from './types.ts'

const FIELDS = ['region', 'userPoolId', 'clientId', 'domain', 'apiUrl'] as const

export function parseConfig(value: unknown): RuntimeConfig {
  const record = (value ?? {}) as Record<string, unknown>
  const missing = FIELDS.filter(field => typeof record[field] !== 'string' || !record[field])
  if (missing.length) throw new Error(`config.json is missing ${missing.join(', ')}`)
  const config = Object.fromEntries(FIELDS.map(field => [field, String(record[field]).replace(/\/+$/, '')])) as unknown as RuntimeConfig
  for (const field of ['domain', 'apiUrl'] as const) {
    if (!/^https:\/\//.test(config[field]) && !/^http:\/\/localhost(:\d+)?$/.test(config[field])) {
      throw new Error(`config.json ${field} must be an https URL`)
    }
  }
  return config
}

export async function loadConfig(fetcher: typeof fetch = (...args) => fetch(...args)): Promise<RuntimeConfig> {
  const response = await fetcher('/config.json', { cache: 'no-store' })
  if (!response.ok) throw new Error(`Could not load config.json (${response.status})`)
  return parseConfig(await response.json())
}
