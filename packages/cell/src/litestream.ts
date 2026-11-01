/**
 * Litestream per cell (parent design §2): restore before the cell opens its database, then replicate while the lease is
 * held. `litestream replicate <db> <url>` streams WAL frames to `s3://dshsa-state-<acct>/cells/<cellId>/`; SIGTERM flushes.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Logger } from '@dshsa/contracts'

export interface Replication { stop(): Promise<void> }
export interface Replicator {
  /** Restore the latest replica into `dbPath` when the file is absent and a replica exists. */
  restore(dbPath: string, url: string, signal: AbortSignal): Promise<void>
  replicate(dbPath: string, url: string): Replication
}

function run(args: string[], log: Logger, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('litestream', args, { stdio: ['ignore', 'pipe', 'pipe'], signal })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.on('error', reject)
    child.on('exit', code => { if (code === 0) resolve(); else reject(new Error(`litestream ${args[0]} exited ${code}: ${output.slice(-1000)}`)) })
  }).then(() => { log.debug('litestream done', { command: args[0] }) })
}

export class LitestreamReplicator implements Replicator {
  constructor(private readonly log: Logger, private readonly binary = 'litestream') {}
  async restore(dbPath: string, url: string, signal: AbortSignal): Promise<void> {
    if (existsSync(dbPath)) return
    await run(['restore', '-if-replica-exists', '-if-db-not-exists', '-o', dbPath, url], this.log, signal)
  }
  replicate(dbPath: string, url: string): Replication {
    let child: ChildProcess | undefined
    let stopping = false
    const start = () => {
      child = spawn(this.binary, ['replicate', dbPath, url], { stdio: ['ignore', 'inherit', 'inherit'] })
      child.on('exit', code => {
        if (stopping) return
        // Replication must keep running while the cell writes; restart it, the WAL keeps what was not shipped yet.
        this.log.error('litestream replicate exited; restarting', { dbPath, code })
        setTimeout(() => { if (!stopping) start() }, 1000).unref()
      })
    }
    start()
    return {
      stop: () => new Promise<void>(resolve => {
        stopping = true
        if (!child || child.exitCode !== null) { resolve(); return }
        const timer = setTimeout(() => { child?.kill('SIGKILL') }, 10_000)
        child.once('exit', () => { clearTimeout(timer); resolve() })
        child.kill('SIGTERM')
      }),
    }
  }
}
/** Local mode and tests: the database stays on local disk only. */
export class NoReplication implements Replicator {
  async restore(): Promise<void> {}
  replicate(): Replication { return { stop: async () => {} } }
}
