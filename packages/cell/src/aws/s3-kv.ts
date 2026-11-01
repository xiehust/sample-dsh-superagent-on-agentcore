/** Connector cursor KV as one JSON object in the state bucket (parent design §4.8), written only by the connector's lease owner. */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { ConnectorKv } from '@dshsa/contracts'

export class S3JsonKv implements ConnectorKv {
  private state?: Promise<Record<string, string>>
  constructor(private readonly bucket: string, private readonly key: string, private readonly client: S3Client = new S3Client({})) {}
  private load(): Promise<Record<string, string>> {
    return this.state ??= this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key }))
      .then(async result => JSON.parse(await result.Body!.transformToString()) as Record<string, string>)
      .catch((error: unknown) => { if ((error as { name?: string }).name === 'NoSuchKey') return {}; this.state = undefined; throw error })
  }
  async get(key: string): Promise<string | undefined> { return (await this.load())[key] }
  async put(key: string, value: string): Promise<void> {
    const state = await this.load()
    state[key] = value
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key, Body: JSON.stringify(state), ContentType: 'application/json' }))
  }
}
