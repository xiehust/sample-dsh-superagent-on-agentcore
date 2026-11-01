/**
 * Deploy-time check: `pnpm --filter @dshsa/sources check:ingress [webhook-url]`. Without a URL argument it reads the
 * `dshsa-ingress` output `GithubWebhookUrl` (region from @dshsa/contracts, operator credentials); arguments that are not a URL
 * are ignored with a notice. Exits 1 when any anonymous or invalid request is not refused by the signature gate.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation'
import { REGION, Stacks } from '@dshsa/contracts'
import { checkIngressDenies, urlArgument } from './ingress.ts'

async function webhookUrl(): Promise<string> {
  const { url: given, ignored } = urlArgument(process.argv.slice(2).filter(arg => arg !== '--'))
  if (ignored.length) console.error(`check:ingress: ignoring argument(s) that are not a URL: ${ignored.map(arg => JSON.stringify(arg)).join(' ')}`)
  if (given) return given
  console.error(`check:ingress: no webhook URL given; using the ${Stacks.ingress} stack output GithubWebhookUrl`)
  const cfn = new CloudFormationClient({ region: process.env.AWS_REGION ?? REGION })
  const { Stacks: stacks } = await cfn.send(new DescribeStacksCommand({ StackName: Stacks.ingress }))
  const url = stacks?.[0]?.Outputs?.find(output => output.OutputKey === 'GithubWebhookUrl')?.OutputValue
  if (!url) throw new Error(`${Stacks.ingress} has no GithubWebhookUrl output`)
  return url
}
const url = await webhookUrl()
const results = await checkIngressDenies(url)
for (const result of results) console.log(`${result.ok ? '✓' : '✗'} ${result.name}: ${result.detail}`)
if (results.some(result => !result.ok)) {
  console.error(`SECURITY: the ingress webhook ${url} accepted or mis-answered a request it must refuse`)
  process.exit(1)
}
console.log(`ingress ${url}: anonymous and forged requests refused by the signature gate`)
