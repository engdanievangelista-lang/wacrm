export interface UazapiEnv {
  baseUrl: string
  adminToken: string
}

/**
 * Normalised base URL, or null when `UAZAPI_URL` is not acceptable: it must
 * be https (http only outside production, for a local UAZAPI), with no
 * embedded credentials, query or fragment — the admin token travels to it.
 */
function parseBaseUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const protocolOk =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && process.env.NODE_ENV !== 'production')
  if (!protocolOk) return null
  if (url.username || url.password || url.search || url.hash) return null
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

let warnedBadUrl = false

/** Server-side UAZAPI configuration; null when not fully configured. */
export function uazapiEnv(): UazapiEnv | null {
  const rawUrl = process.env.UAZAPI_URL?.trim()
  const adminToken = process.env.UAZAPI_ADMIN_TOKEN?.trim()
  if (!rawUrl || !adminToken) return null
  const baseUrl = parseBaseUrl(rawUrl)
  if (!baseUrl) {
    // Never echo the value: it may carry credentials.
    if (!warnedBadUrl) {
      warnedBadUrl = true
      console.warn(
        'UAZAPI_URL ignored: it must be an https URL without credentials, query or fragment (http is allowed only outside production). UAZAPI is disabled.'
      )
    }
    return null
  }
  return { baseUrl, adminToken }
}

export function isUazapiEnabled(): boolean {
  return uazapiEnv() !== null
}

export class UazapiError extends Error {
  status: number
  retryAfterSec?: number
  constructor(message: string, status: number, retryAfterSec?: number) {
    super(message)
    this.name = 'UazapiError'
    this.status = status
    this.retryAfterSec = retryAfterSec
  }
}

/** Max time to wait for a UAZAPI response before giving up. */
export const UAZAPI_REQUEST_TIMEOUT_MS = 15_000

function pathOnly(path: string): string {
  return path.split('?')[0]
}

export async function uazapiRequest<T>(o: {
  path: string
  method?: 'GET' | 'POST' | 'DELETE'
  token?: string
  admin?: boolean
  body?: unknown
}): Promise<T> {
  const env = uazapiEnv()
  if (!env) throw new UazapiError('UAZAPI is not configured', 0)
  const method = o.method ?? 'GET'
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (o.admin) headers.admintoken = env.adminToken
  else if (o.token) headers.token = o.token
  if (o.body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(`${env.baseUrl}${o.path}`, {
      method,
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      signal: AbortSignal.timeout(UAZAPI_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    // Never forward the original error: it can echo URLs or headers.
    const name = err instanceof Error ? err.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new UazapiError(`UAZAPI ${method} ${pathOnly(o.path)} timed out`, 504)
    }
    throw new UazapiError(`UAZAPI ${method} ${pathOnly(o.path)} could not be reached`, 502)
  }

  if (!res.ok) {
    const ra = Number(res.headers.get('Retry-After'))
    const retryAfterSec = Number.isFinite(ra) && ra > 0 ? ra : undefined
    throw new UazapiError(
      `UAZAPI ${method} ${pathOnly(o.path)} failed with status ${res.status}`,
      res.status,
      retryAfterSec,
    )
  }

  const text = await res.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new UazapiError(
      `UAZAPI ${method} ${pathOnly(o.path)} returned a non-JSON response`,
      res.status,
    )
  }
}
