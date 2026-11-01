/**
 * dshsa CDK app (design §1). Owner: dd.
 * Context: `vpcId` (import a VPC), `azs` (comma list of AZ names for apne1-az4/az1), `retain=true`, `devCallback=true`,
 * `allowAnyAccount=true`.
 */
import { App, Aspects } from 'aws-cdk-lib'
import { AwsSolutionsChecks } from 'cdk-nag'
import { ACCOUNT, compose } from '../lib/compose.ts'

const app = new App()
const ctx = (key: string): string | undefined => {
  const value: unknown = app.node.tryGetContext(key)
  return value === undefined || value === '' ? undefined : String(value)
}
// The target account is pinned per installation by DSHSA_ACCOUNT (scripts/lib.sh), never in the repository.
const pinned = process.env.DSHSA_ACCOUNT
const account = process.env.CDK_DEFAULT_ACCOUNT ?? pinned ?? ACCOUNT
if (ctx('allowAnyAccount') !== 'true' && account !== pinned) {
  throw new Error(`dshsa deploys only to DSHSA_ACCOUNT (${pinned ?? 'unset'}; got ${account}); set DSHSA_ACCOUNT or pass -c allowAnyAccount=true`)
}
await compose(app, {
  account, vpcId: ctx('vpcId'), availabilityZones: ctx('azs')?.split(','), retain: ctx('retain') === 'true',
  devCallback: ctx('devCallback') === 'true',
})
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))
