/**
 * The DSH panel API routes (`dsh-superagent-prototype/src/app/api.ts`, MIT) panel-api forwards to a cell. Anything else is
 * 404 `unknown_route`, so a panel user can never reach an internal endpoint such as `worker/token-refresh`.
 */
export const CELL_ROUTES = [
  'GET state', 'GET overview', 'GET search', 'GET sources', 'GET settings', 'POST sources/:id/labels',
  'GET threads', 'GET threads/:key', 'POST threads/:key/unsubscribe', 'POST triggers/:id/requeue',
  'GET decisions', 'POST decisions/:id/dismiss', 'GET tickets', 'GET tickets/:id', 'POST tickets/:id/retry',
  'POST tickets/:id/stop', 'POST executor/pause', 'PUT settings/:block', 'GET policy/history', 'POST policy-sync/:id',
  'POST setup/check', 'GET models', 'GET prompts', 'PUT prompts', 'POST prompts/preview',
  // Onboarding v6 Policy-form pickers (cell checks the chat is bound to it; member-readable).
  'GET sources/feishu/members', 'GET sources/github/collaborators',
] as const
export type CellRoute = typeof CELL_ROUTES[number]

/** The only mutations a tenant member may make (onboarding design §1, D1 "read + Stop/Retry"); the cell checks the same. */
const MEMBER_WRITES: ReadonlySet<CellRoute> = new Set(['POST tickets/:id/stop', 'POST tickets/:id/retry'])
/** The least role a cell route needs: every GET and Stop/Retry for members, every other mutation for tenant admins. */
export const cellRouteRole = (route: CellRoute): 'member' | 'tadmin' =>
  route.startsWith('GET ') || MEMBER_WRITES.has(route) ? 'member' : 'tadmin'

const compiled = CELL_ROUTES.map(key => {
  const [method, path] = key.split(' ') as [string, string]
  const pattern = new RegExp(`^${path.split('/').map(seg => seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}$`)
  return { key, method, pattern }
})

/**
 * Canonical form of a cell API path (no leading slash): every segment percent-decoded, checked, and re-encoded with
 * `encodeURIComponent`. Undefined for an empty, `.` or `..` segment (also when encoded, e.g. `%2e%2e`, which the WHATWG URL
 * parser in `fetch` would otherwise normalize into a parent hop), an encoded `/` or `\`, control characters, or bad escapes.
 * Forwarding only the canonical form means the host sees exactly the segments the allowlist matched.
 */
export function canonicalCellPath(path: string): string | undefined {
  const out: string[] = []
  for (const raw of path.split('/')) {
    let seg: string
    try { seg = decodeURIComponent(raw) } catch { return undefined }
    // eslint-disable-next-line no-control-regex
    if (seg === '' || seg === '.' || seg === '..' || /[/\\\u0000-\u001f\u007f]/.test(seg)) return undefined
    out.push(encodeURIComponent(seg))
  }
  return out.join('/')
}

/** The allowlisted route a `method` + `path` (no leading slash, still percent-encoded) matches, if any. */
export function matchCellRoute(method: string, path: string): CellRoute | undefined {
  const canonical = canonicalCellPath(path)
  if (canonical === undefined) return undefined
  return compiled.find(r => r.method === method.toUpperCase() && r.pattern.test(canonical))?.key
}
