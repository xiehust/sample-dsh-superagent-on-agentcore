/** dshsa shim for DSH `src/executor/dsh.ts`, used by the copied views: the id DSH gave a ticket's worker Session. */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
