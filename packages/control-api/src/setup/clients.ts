/** AWS clients for the setup Lambdas, wired into the ops.ts `AdminClients` (the CLI and the panel share one code path). */
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { SQSClient } from '@aws-sdk/client-sqs'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { AdminClients } from '../admin/ops.ts'

export const env = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`missing env ${name}`)
  return value
}
export const docClient = () => DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })

export function adminClients(db: DynamoDBDocumentClient): AdminClients {
  return {
    db, sqs: new SQSClient({}), secrets: new SecretsManagerClient({}), cognito: new CognitoIdentityProviderClient({}),
    userPoolId: env('USER_POOL_ID'), now: () => new Date(),
    // ops.ts narrates for the CLI; in Lambda the audit line is the record, so its narration goes to debug JSON only.
    log: line => console.log(JSON.stringify({ level: 'debug', msg: 'ops', line })),
  }
}
export const jsonLog = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry))
