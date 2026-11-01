/**
 * Stand-ins for module constructs whose owners have not delivered `worker.ts` / `host.ts` / `ingress.ts` yet. Same class
 * shapes as `shared-resources.ts` describes; they create nothing billable. Owner: dd. Delete a stub once the real file lands.
 */
import { Stack, aws_ec2 as ec2, aws_lambda as lambda } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import type { HostModuleProps, ModuleProps, WorkerOutputs } from '../shared-resources.ts'

export class WorkerModuleStub extends Construct implements WorkerOutputs {
  readonly runtimeArn: string
  readonly provisionerFunction: lambda.IFunction
  readonly fileSystemId = 'fs-stub'
  readonly workerApiSg: ec2.ISecurityGroup
  constructor(scope: Construct, id: string, props: ModuleProps) {
    super(scope, id)
    const { account, region } = Stack.of(this)
    this.runtimeArn = `arn:aws:bedrock-agentcore:${region}:${account}:runtime/dshsa_worker-stub`
    this.provisionerFunction = lambda.Function.fromFunctionName(this, 'Provisioner', 'dshsa-provisioner')
    this.workerApiSg = new ec2.SecurityGroup(this, 'WorkerApiSg', {
      vpc: props.shared.network.vpc, securityGroupName: 'dshsa-worker-api', description: 'dshsa worker-api Lambda (stub)',
    })
  }
}

export class HostModuleStub extends Construct {
  constructor(scope: Construct, id: string, _props: HostModuleProps) { super(scope, id) }
}

export class IngressModuleStub extends Construct {
  constructor(scope: Construct, id: string, _props: ModuleProps) { super(scope, id) }
}
