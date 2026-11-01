/** Audit lines of panel setup mutations (onboarding design §2, contracts v6 `AuditEntry`, log group `/dshsa/panel-admin`). */
import { AuditEntry, type PanelRole } from '@dshsa/contracts'
import type { Principal } from './authz.ts'

export type Audit = (entry: Omit<AuditEntry, 'at' | 'actor' | 'role'>) => void
export type AuditSink = (line: string) => void

/**
 * An audit writer bound to one request's actor and role. Each call writes one JSON line `{msg:'audit', ...AuditEntry}`.
 * Callers pass ids and names only: never a secret value, token or message text. `target` and `error` are clipped to the schema.
 */
export function auditFor(principal: Principal, role: PanelRole, sink: AuditSink, now: () => number): Audit {
  return entry => {
    const line = AuditEntry.safeParse({
      at: new Date(now()).toISOString(), actor: { sub: principal.sub, email: principal.email }, role, ...entry,
      target: entry.target?.slice(0, 200), error: entry.error?.slice(0, 300),
    })
    // An entry that fails its own schema is still written (flagged), so a bug never drops an audit record silently.
    sink(JSON.stringify(line.success ? { msg: 'audit', ...line.data } : { msg: 'audit', invalid: true, op: entry.op, ok: entry.ok, sub: principal.sub }))
  }
}
