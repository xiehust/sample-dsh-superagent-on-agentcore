/** User directory table and invite form shared by Team setup → Users and Platform → Users. */
import { useState, type FormEvent } from 'react'
import { ROLE_LABELS, type DirectoryUser, type PanelRole } from './types.ts'
import { ConfirmButton, useAction, useShell } from './widgets.tsx'

export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function UserTable({ users, onRemove, removeMessage }: {
  users: DirectoryUser[]; onRemove: (email: string) => Promise<unknown>; removeMessage: (email: string) => string
}) {
  const { me } = useShell()
  const self = me.email?.toLowerCase()
  if (!users.length) return <p className="hint">No users yet.</p>
  return <table className="table">
    <thead><tr><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead>
    <tbody>{users.map(user => <tr key={user.email}>
      <td>{user.email}</td><td>{ROLE_LABELS[user.role] ?? user.role}</td>
      <td>{user.enabled === false ? 'Disabled' : user.status === 'FORCE_CHANGE_PASSWORD' ? 'Invited' : user.status ?? ''}</td>
      <td>{user.email.toLowerCase() === self ? <span className="hint">You</span>
        : <ConfirmButton danger label="Remove" title={`Remove ${user.email}?`} message={removeMessage(user.email)}
          onConfirm={() => onRemove(user.email)} />}</td>
    </tr>)}</tbody>
  </table>
}

/** Invite by email with one of `roles`; the server creates the Cognito user if needed and adds the group. */
export function InviteForm<R extends PanelRole>({ roles, onInvite, label = 'Invite user' }: {
  roles: readonly R[]; onInvite: (email: string, role: R) => Promise<unknown>; label?: string
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<R>(roles[0]!)
  const [touched, setTouched] = useState(false)
  const valid = EMAIL.test(email.trim())
  const invite = useAction(async () => { await onInvite(email.trim(), role); setEmail(''); setTouched(false) })
  const submit = (event: FormEvent) => { event.preventDefault(); setTouched(true); if (valid) void invite.run() }
  return <form className="inline-form" onSubmit={submit} aria-label={label} noValidate>
    <label>Email<input type="email" value={email} autoComplete="off" aria-invalid={touched && !valid}
      onChange={event => setEmail(event.target.value)} /></label>
    {roles.length > 1 && <label>Role<select value={role} onChange={event => setRole(event.target.value as R)}>
      {roles.map(item => <option key={item} value={item}>{ROLE_LABELS[item]}</option>)}
    </select></label>}
    <button type="submit" disabled={invite.busy}>Invite</button>
    {touched && !valid && <p className="error" role="alert">Enter an email address.</p>}
  </form>
}
