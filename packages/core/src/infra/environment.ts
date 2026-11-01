/**
 * dshsa adapter: the only part of DSH `src/infra/environment.ts` the domain needs, so `policy.ts` stays a verbatim copy.
 * The worker shims themselves have no equivalent on AWS (workers run in their own AgentCore microVM).
 */
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
