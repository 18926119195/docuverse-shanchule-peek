import { assertDemoAccess } from '../_lib/auth.js'
import { preflight, withCors } from '../_lib/cors.js'
import {
  parseFormalizeBody,
  runFormalize,
} from '../_lib/protocol/formalizeCore.js'

export const config = { runtime: 'edge' }

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight(req)

  const denied = assertDemoAccess(req)
  if (denied) return withCors(denied, req)

  if (req.method !== 'POST') {
    return withCors(
      Response.json({ error: 'POST only' }, { status: 405 }),
      req,
    )
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return withCors(
      Response.json({ error: 'invalid JSON' }, { status: 400 }),
      req,
    )
  }

  const parsed = parseFormalizeBody(raw)
  if (typeof parsed === 'string') {
    return withCors(Response.json({ error: parsed }, { status: 400 }), req)
  }

  const result = await runFormalize(parsed)
  return withCors(Response.json(result, { status: result.ok ? 200 : 502 }), req)
}
