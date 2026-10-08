import { uazapiRequest } from './client'

export type InstanceState = 'disconnected' | 'connecting' | 'connected' | 'hibernated'

const STATES: readonly InstanceState[] = ['disconnected', 'connecting', 'connected', 'hibernated']

function toState(v: unknown): InstanceState {
  return typeof v === 'string' && (STATES as readonly string[]).includes(v)
    ? (v as InstanceState)
    : 'disconnected'
}

interface InstancePayload {
  id?: string
  status?: string
  qrcode?: string | null
  profileName?: string | null
}

/** Create an instance (admin endpoint). The returned token is the per-instance credential. */
export async function createInstance(
  name: string,
): Promise<{ instanceId: string; token: string }> {
  const res = await uazapiRequest<{ token?: string; instance?: InstancePayload }>({
    path: '/instance/create',
    method: 'POST',
    admin: true,
    body: { name },
  })
  return { instanceId: res?.instance?.id ?? '', token: res?.token ?? '' }
}

/** Register the single webhook (simple mode: no action/id). */
export async function configureWebhook(token: string, url: string): Promise<void> {
  await uazapiRequest<unknown>({
    path: '/webhook',
    method: 'POST',
    token,
    body: {
      url,
      enabled: true,
      events: ['messages', 'messages_update', 'connection'],
      excludeMessages: ['wasSentByApi', 'isGroupYes', 'fromMeYes'],
    },
  })
}

/** Start the QR connection flow. */
export async function connectInstance(
  token: string,
): Promise<{ qr: string | null; state: InstanceState }> {
  const res = await uazapiRequest<{ instance?: InstancePayload } | undefined>({
    path: '/instance/connect',
    method: 'POST',
    token,
  })
  const inst = res?.instance
  return {
    qr: inst?.qrcode || null,
    // A successful connect call means the pairing flow has started.
    state: inst?.status ? toState(inst.status) : 'connecting',
  }
}

export async function getInstanceStatus(token: string): Promise<{
  state: InstanceState
  qr: string | null
  phone: string | null
  profileName: string | null
}> {
  const res = await uazapiRequest<{
    instance?: InstancePayload
    status?: { jid?: { user?: string } | null }
  }>({ path: '/instance/status', token })
  return {
    state: toState(res?.instance?.status),
    qr: res?.instance?.qrcode || null,
    phone: res?.status?.jid?.user || null,
    profileName: res?.instance?.profileName || null,
  }
}

export async function disconnectInstance(token: string): Promise<void> {
  await uazapiRequest<unknown>({ path: '/instance/disconnect', method: 'POST', token })
}

/** Delete the instance. 200 and 202 (async deletion) are both success (any 2xx resolves). */
export async function deleteInstance(token: string): Promise<void> {
  await uazapiRequest<unknown>({ path: '/instance', method: 'DELETE', token })
}
