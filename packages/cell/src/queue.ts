/**
 * The cell queue consumer (parent design §4.6): one SQS FIFO queue per cell, single message group, so envelopes apply in order.
 * At-least-once: an envelope is deleted only after it applied. A failure stops the batch so later envelopes never overtake it;
 * they become visible again with it. Idempotency comes from the domain (deterministic Trigger ids, worker event ids).
 */
import { CellEnvelope, type Logger } from '@dshsa/contracts'
import { ChangeMessageVisibilityBatchCommand, DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs'

export interface QueueMessage { messageId: string; receipt: string; body: string; receiveCount: number }
export interface CellQueue {
  receive(signal: AbortSignal): Promise<QueueMessage[]>
  delete(message: QueueMessage): Promise<void>
  /** Make messages visible again after `seconds` (0 = now). */
  release(messages: QueueMessage[], seconds: number): Promise<void>
}
export interface EnvelopeHandler { handle(envelope: CellEnvelope): Promise<void> }

export interface ConsumerOptions { queue: CellQueue; handler: EnvelopeHandler; log: Logger; afterBatch?(): void
  /** Seconds a failed envelope (and the rest of its batch) stays hidden before it is retried. */
  retryAfterSeconds?: number }

export class CellQueueConsumer {
  constructor(private readonly options: ConsumerOptions) {}
  /** Consume until `signal` aborts; resolves after the batch in flight finished. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let batch: QueueMessage[]
      try { batch = await this.options.queue.receive(signal) }
      catch (error) {
        if (signal.aborted) break
        this.options.log.warn('queue receive failed', { error: String(error) })
        await new Promise(resolve => setTimeout(resolve, 2000))
        continue
      }
      await this.process(batch, signal)
    }
  }
  /** Applies one batch in order; returns how many envelopes it applied (deleted). */
  async process(batch: QueueMessage[], signal?: AbortSignal): Promise<number> {
    const { queue, handler, log } = this.options
    let applied = 0
    for (const [index, message] of batch.entries()) {
      if (signal?.aborted) { await queue.release(batch.slice(index), 0).catch(() => {}); break }
      let envelope: CellEnvelope
      try { envelope = CellEnvelope.parse(JSON.parse(message.body)) }
      catch (error) {
        // A malformed envelope can never apply: drop it rather than block the cell's single message group.
        log.error('poison envelope dropped', { messageId: message.messageId, error: String(error).slice(0, 500) })
        await queue.delete(message)
        continue
      }
      try {
        await handler.handle(envelope)
      } catch (error) {
        log.warn('envelope failed; retrying later', { id: envelope.id, type: envelope.type, receiveCount: message.receiveCount, error: String(error) })
        await queue.release(batch.slice(index), this.options.retryAfterSeconds ?? 15).catch(() => {})
        break
      }
      await queue.delete(message)
      applied++
    }
    if (batch.length) this.options.afterBatch?.()
    return applied
  }
}

export class SqsCellQueue implements CellQueue {
  constructor(private readonly url: string, private readonly client: SQSClient = new SQSClient({}), private readonly visibilitySeconds = 120) {}
  async receive(signal: AbortSignal): Promise<QueueMessage[]> {
    const result = await this.client.send(new ReceiveMessageCommand({ QueueUrl: this.url, MaxNumberOfMessages: 10, WaitTimeSeconds: 20,
      VisibilityTimeout: this.visibilitySeconds, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }), { abortSignal: signal })
    return (result.Messages ?? []).map(message => ({ messageId: message.MessageId ?? '', receipt: message.ReceiptHandle ?? '', body: message.Body ?? '',
      receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1) }))
  }
  async delete(message: QueueMessage): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.url, ReceiptHandle: message.receipt }))
  }
  async release(messages: QueueMessage[], seconds: number): Promise<void> {
    for (let i = 0; i < messages.length; i += 10) {
      await this.client.send(new ChangeMessageVisibilityBatchCommand({ QueueUrl: this.url,
        Entries: messages.slice(i, i + 10).map((message, n) => ({ Id: String(n), ReceiptHandle: message.receipt, VisibilityTimeout: seconds })) }))
    }
  }
}

/**
 * In-memory FIFO queue with SQS semantics for one message group: messages stay hidden while in flight, a message group is
 * blocked while any of its messages is in flight, and a deduplication id is accepted once (5-minute window ignored).
 */
export class MemoryCellQueue implements CellQueue {
  private readonly messages: { messageId: string; body: string; visibleAt: number; inFlight: boolean; receiveCount: number; receipt: string }[] = []
  private readonly dedup = new Set<string>()
  private sequence = 0
  constructor(private readonly now: () => number = Date.now, private readonly waitMs = 50) {}
  send(body: string, deduplicationId: string): boolean {
    if (this.dedup.has(deduplicationId)) return false
    this.dedup.add(deduplicationId)
    this.messages.push({ messageId: `m${++this.sequence}`, body, visibleAt: 0, inFlight: false, receiveCount: 0, receipt: '' })
    return true
  }
  get size(): number { return this.messages.length }
  async receive(signal: AbortSignal): Promise<QueueMessage[]> {
    for (;;) {
      const now = this.now()
      for (const message of this.messages) if (message.inFlight && message.visibleAt <= now) message.inFlight = false
      // One message group: nothing is delivered while an earlier message is in flight.
      if (!this.messages.some(message => message.inFlight)) {
        const batch = this.messages.filter(message => message.visibleAt <= now).slice(0, 10)
        if (batch.length) {
          for (const message of batch) { message.inFlight = true; message.visibleAt = now + 120_000; message.receiveCount++; message.receipt = `${message.messageId}:${message.receiveCount}` }
          return batch.map(({ messageId, body, receipt, receiveCount }) => ({ messageId, body, receipt, receiveCount }))
        }
      }
      if (signal.aborted) return []
      await new Promise(resolve => setTimeout(resolve, this.waitMs))
    }
  }
  async delete(message: QueueMessage): Promise<void> {
    const index = this.messages.findIndex(item => item.receipt === message.receipt)
    if (index >= 0) this.messages.splice(index, 1)
  }
  async release(messages: QueueMessage[], seconds: number): Promise<void> {
    for (const message of messages) {
      const item = this.messages.find(candidate => candidate.receipt === message.receipt)
      if (item) { item.inFlight = false; item.visibleAt = this.now() + seconds * 1000 }
    }
  }
}
