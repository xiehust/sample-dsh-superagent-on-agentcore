/** panel-api Lambda entry: wires AWS clients into `handle` (design §4.1). Env is set by infra/lib/panel.ts. */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
import { defaultProvider } from '@aws-sdk/credential-provider-node'
import { stsCallerSigner } from './caller.ts'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { fetchForwarder } from './forward.ts'
import { type HttpEvent, type HttpResult, handle } from './handler.ts'
import { DynamoRepo } from './repo.ts'
import { S3TranscriptStore } from './transcript.ts'

const env = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`missing env ${name}`)
  return value
}

const deps = {
  repo: new DynamoRepo(DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }), {
    tenants: env('TABLE_TENANTS'), cells: env('TABLE_CELLS'), routes: env('TABLE_ROUTES'),
    leases: env('TABLE_LEASES'), ticketStorage: env('TABLE_TICKET_STORAGE'),
  }),
  forward: fetchForwarder,
  callerProof: stsCallerSigner(defaultProvider(), process.env.AWS_REGION),
  transcripts: new S3TranscriptStore(new S3Client({}), env('DATA_BUCKET')),
  now: () => Date.now(),
  log: (entry: Record<string, unknown>) => console.log(JSON.stringify(entry)),
}

export const handler = (event: HttpEvent): Promise<HttpResult> => handle(event, deps)
