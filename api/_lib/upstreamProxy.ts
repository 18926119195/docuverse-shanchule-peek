/**
 * Shared OpenAI-compatible upstream forwarder for /api/llm and /api/zhipu.
 * Avoid Vercel catch-all filenames ([...path].ts) — they deploy as literal paths.
 */
import { assertDemoAccess } from './auth.js'
import { preflight, withCors } from './cors.js'

async function maybeForceModel(
  req: Request,
  forceModel: string | undefined,
): Promise<BodyInit | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const raw = new Uint8Array(await req.arrayBuffer())
  if (!forceModel || raw.byteLength === 0) return raw
  try {
    const text = new TextDecoder().decode(raw)
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      return JSON.stringify({ ...parsed, model: forceModel })
    }
  } catch {
    /* keep original body */
  }
  return raw
}

export async function proxyUpstream(
  req: Request,
  opts: {
    /** Strip this prefix from pathname, e.g. '/api/llm' */
    stripPrefix: string
    /** Upstream root without trailing slash */
    baseUrl: string
    apiKey: string
    missingKeyMessage: string
    /** When set, rewrite JSON body `model` before forwarding */
    forceModel?: string
  },
): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight(req)

  const denied = assertDemoAccess(req)
  if (denied) return withCors(denied, req)

  if (!opts.apiKey) {
    return withCors(
      Response.json({ error: opts.missingKeyMessage }, { status: 500 }),
      req,
    )
  }

  const inbound = new URL(req.url)
  const escaped = opts.stripPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const sub = inbound.pathname.replace(new RegExp(`^${escaped}/?`), '')
  if (!sub) {
    return withCors(
      Response.json({ error: 'missing upstream subpath' }, { status: 400 }),
      req,
    )
  }

  const target = new URL(`${opts.baseUrl}/${sub}`)
  target.search = inbound.search

  const headers = new Headers()
  headers.set('Authorization', `Bearer ${opts.apiKey}`)
  const contentType = req.headers.get('content-type')
  if (contentType) headers.set('Content-Type', contentType)

  const init: RequestInit = {
    method: req.method,
    headers,
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await maybeForceModel(req, opts.forceModel)
  }

  try {
    const upstream = await fetch(target, init)
    return withCors(
      new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'Content-Type':
            upstream.headers.get('content-type') ?? 'application/json',
        },
      }),
      req,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return withCors(
      Response.json({ error: `upstream proxy failed: ${msg}` }, { status: 502 }),
      req,
    )
  }
}
