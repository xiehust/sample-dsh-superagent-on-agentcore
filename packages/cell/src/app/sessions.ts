/**
 * dshsa adapter of DSH `src/app/sessions.ts`: the only part prompts and settings use. On AWS there is no long-lived main
 * Session (parent PRD R5), so `notify` records the latest notice by name and `delivery` reports it as delivered.
 */
export interface Sessions {
  notify(name: string, value: Record<string, unknown>, summary: string): void
  delivery(name: string): Promise<'injected' | 'pending'>
  /** The prompt revision Sessions read; workers receive the current one with every start and deliver (parent design §4.4). */
  status(): { revision: number; sessions: { sessionId: string; revision: number }[]; notificationPending: boolean }
}
export class NoticeLog implements Sessions {
  constructor(private readonly revision: () => number = () => 0) {}
  status() { return { revision: this.revision(), sessions: [], notificationPending: false } }
  readonly latest = new Map<string, { value: Record<string, unknown>; summary: string; at: string }>()
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.latest.set(name, { value, summary, at: new Date().toISOString() }) }
  async delivery(_name: string): Promise<'injected' | 'pending'> { return 'injected' }
}
