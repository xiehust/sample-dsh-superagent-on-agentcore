/** Composition of the five dshsa stacks (design §1). Used by bin/app.ts and the infra tests. Owner: dd. */
import { existsSync } from 'node:fs'
import { type App, CfnOutput, Stack, Tags } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import { Stacks } from '@dshsa/contracts'
import { HostModuleStub, IngressModuleStub, WorkerModuleStub } from './constructs/stubs.ts'
import { PanelStack } from './panel.ts'
import { SharedStack } from './shared.ts'
import type { HostModuleProps, ModuleProps, WorkerOutputs } from './shared-resources.ts'

/** Placeholder account for tests and local synth; deploys pin the real one with DSHSA_ACCOUNT (infra/bin/app.ts). */
export const ACCOUNT = '123456789012'
export { REGION } from '@dshsa/contracts'
import { REGION } from '@dshsa/contracts'

export interface ComposeOptions {
  account: string
  vpcId?: string
  availabilityZones?: string[]
  retain?: boolean
  devCallback?: boolean
  /** Force the stubs even when an owner's construct file exists (unit tests of the shared/panel stacks). */
  stubsOnly?: boolean
}

type Ctor<P, T> = new (scope: Construct, id: string, props: P) => T
/** Loads `constructs/<file>.ts` export `name` when its owner has delivered it, else the stub. */
async function moduleClass<P, T>(file: string, name: string, stub: Ctor<P, T>, stubsOnly: boolean): Promise<Ctor<P, T>> {
  const url = new URL(`./constructs/${file}.ts`, import.meta.url)
  if (stubsOnly || !existsSync(url)) return stub
  const mod = await import(url.href) as Record<string, unknown>
  const cls = mod[name]
  if (typeof cls !== 'function') throw new Error(`lib/constructs/${file}.ts must export class ${name}`)
  return cls as Ctor<P, T>
}

export async function compose(app: App, o: ComposeOptions) {
  const stubsOnly = !!o.stubsOnly
  const WorkerModule = await moduleClass<ModuleProps, Construct & WorkerOutputs>('worker', 'WorkerModule', WorkerModuleStub, stubsOnly)
  const HostModule = await moduleClass<HostModuleProps, Construct>('host', 'HostModule', HostModuleStub, stubsOnly)
  const IngressModule = await moduleClass<ModuleProps, Construct>('ingress', 'IngressModule', IngressModuleStub, stubsOnly)
  const env = { account: o.account, region: REGION }

  const shared = new SharedStack(app, Stacks.shared, {
    env, stackName: Stacks.shared, description: 'dshsa shared: network, tables, KMS, buckets, secrets, Cognito',
    vpcId: o.vpcId, availabilityZones: o.availabilityZones ?? ['ap-northeast-1a', 'ap-northeast-1c'], retain: !!o.retain,
  })
  const props: ModuleProps = { shared: shared.resources }
  const workerStack = new Stack(app, Stacks.worker, { env, stackName: Stacks.worker, description: 'dshsa worker: AgentCore runtime, S3 Files, broker' })
  const worker = new WorkerModule(workerStack, 'Worker', props)
  // scripts/destroy.sh deletes the runtime-created access points on this file system before the stack goes.
  new CfnOutput(workerStack, 'DshsaFileSystemId', { value: worker.fileSystemId })
  const hostStack = new Stack(app, Stacks.host, { env, stackName: Stacks.host, description: 'dshsa host: cell runtime on ECS Fargate' })
  new HostModule(hostStack, 'Host', { ...props, worker })
  const ingressStack = new Stack(app, Stacks.ingress, { env, stackName: Stacks.ingress, description: 'dshsa ingress: GitHub webhook' })
  new IngressModule(ingressStack, 'Ingress', props)
  const panel = new PanelStack(app, Stacks.panel, {
    env, stackName: Stacks.panel, description: 'dshsa panel: SPA, Cognito client, panel-api', shared: shared.resources, devCallback: !!o.devCallback,
  })
  Tags.of(app).add('project', 'dshsa')
  return { shared, workerStack, hostStack, ingressStack, panel }
}
