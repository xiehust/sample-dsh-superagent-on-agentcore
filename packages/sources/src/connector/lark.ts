/**
 * Live client over the official Feishu/Lark Node SDK long connection (`WSClient` + `EventDispatcher`).
 * Outbound only: the SDK dials Feishu's gateway, so the Connector exposes no listener. The SDK is loaded lazily so the cell
 * and the tests can import the Connector without it.
 */
import type { FeishuSecrets, TenantRecord } from '@dshsa/contracts'
import type { LiveClient, LiveHandlers } from './feishu.ts'

export function larkLiveClient(tenant: TenantRecord, secrets: FeishuSecrets): LiveClient {
  let client: { close(params?: { force?: boolean }): void } | undefined
  let closed = false
  return {
    async start(handlers: LiveHandlers): Promise<void> {
      const lark = await import('@larksuiteoapi/node-sdk')
      if (closed) return
      const domain = tenant.feishu?.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu
      const dispatcher = new lark.EventDispatcher({ ...secrets.encryptKey ? { encryptKey: secrets.encryptKey } : {},
        ...secrets.verificationToken ? { verificationToken: secrets.verificationToken } : {}, loggerLevel: lark.LoggerLevel.warn })
        .register({ 'im.message.receive_v1': async (data: unknown) => { await handlers.onEvent(data) } })
      const ws = new lark.WSClient({ appId: secrets.appId, appSecret: secrets.appSecret, domain, loggerLevel: lark.LoggerLevel.warn,
        autoReconnect: true, source: 'dshsa-connector',
        onReady: () => handlers.onState('ready'),
        onReconnecting: () => handlers.onState('reconnecting'),
        onReconnected: () => handlers.onState('reconnected'),
        onError: (error: Error) => handlers.onState('error', error.message) })
      client = ws
      await ws.start({ eventDispatcher: dispatcher })
    },
    close(): void {
      closed = true
      client?.close({ force: true })
      client = undefined
    },
  }
}
