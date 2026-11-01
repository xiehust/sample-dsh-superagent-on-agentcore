/** Constants shared by the ingress checks; kept dependency-free so the deploy script can run the check without the AWS SDK. */
export { GATE_ERRORS } from '../src/webhook/core.ts'
/** The route `infra/lib/constructs/ingress.ts` exposes (its `WEBHOOK_PATH`). */
export const WEBHOOK_PATH_SUFFIX = '/github/webhook'
