import { assertDemoAccess } from '../_lib/auth.js'
import { preflight, withCors } from '../_lib/cors.js'
import {
  ensureClosure,
  matchDirections,
  rememberDirection,
  resolveReuse,
  type ClosureSnap,
} from '../_lib/protocol/closureEngine.js'

export const config = { runtime: 'edge' }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function asClosureMap(v: unknown): Record<string, ClosureSnap> {
  if (!isRecord(v)) return {}
  const out: Record<string, ClosureSnap> = {}
  for (const [k, val] of Object.entries(v)) {
    if (!isRecord(val)) continue
    if (typeof val.key !== 'string' || !Array.isArray(val.directions)) continue
    out[k] = val as unknown as ClosureSnap
  }
  return out
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight(req)
  const denied = assertDemoAccess(req)
  if (denied) return withCors(denied, req)
  if (req.method !== 'POST') {
    return withCors(Response.json({ error: 'POST only' }, { status: 405 }), req)
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return withCors(Response.json({ error: 'invalid JSON' }, { status: 400 }), req)
  }
  if (!isRecord(raw) || typeof raw.action !== 'string') {
    return withCors(
      Response.json({ error: 'action required' }, { status: 400 }),
      req,
    )
  }

  const closures = asClosureMap(raw.closures)
  const action = raw.action

  try {
    if (action === 'ensure') {
      const key = typeof raw.key === 'string' ? raw.key : ''
      const excerpt = typeof raw.excerpt === 'string' ? raw.excerpt : ''
      if (!key) {
        return withCors(Response.json({ error: 'key required' }, { status: 400 }), req)
      }
      const memberKeys = Array.isArray(raw.memberKeys)
        ? raw.memberKeys.filter((x): x is string => typeof x === 'string')
        : undefined
      const { map, closure } = ensureClosure(closures, { key, excerpt, memberKeys })
      return withCors(Response.json({ ok: true, closures: map, closure }), req)
    }

    if (action === 'match') {
      const key = typeof raw.key === 'string' ? raw.key : ''
      const question = typeof raw.question === 'string' ? raw.question : ''
      const c = closures[key]
      if (!c) {
        return withCors(Response.json({ error: 'closure not found' }, { status: 404 }), req)
      }
      const hits = matchDirections(c, question)
      return withCors(Response.json({ ok: true, hits, closures }), req)
    }

    if (action === 'reuse') {
      const key = typeof raw.key === 'string' ? raw.key : ''
      const directionId = typeof raw.directionId === 'string' ? raw.directionId : ''
      const c = closures[key]
      if (!c) {
        return withCors(Response.json({ error: 'closure not found' }, { status: 404 }), req)
      }
      const result = resolveReuse(c, directionId)
      return withCors(Response.json({ ok: true, ...result, closures }), req)
    }

    if (action === 'remember') {
      const key = typeof raw.key === 'string' ? raw.key : ''
      const questionText = typeof raw.questionText === 'string' ? raw.questionText : ''
      const path = typeof raw.path === 'string' ? raw.path : ''
      const conclusion = typeof raw.conclusion === 'string' ? raw.conclusion : ''
      if (!key || !questionText) {
        return withCors(
          Response.json({ error: 'key and questionText required' }, { status: 400 }),
          req,
        )
      }
      const { map, directionId } = rememberDirection(closures, {
        key,
        questionText,
        path,
        conclusion,
      })
      return withCors(
        Response.json({ ok: true, closures: map, directionId }),
        req,
      )
    }

    return withCors(
      Response.json(
        { error: 'unknown action (ensure|match|reuse|remember)' },
        { status: 400 },
      ),
      req,
    )
  } catch (e) {
    return withCors(
      Response.json(
        { ok: false, error: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      ),
      req,
    )
  }
}
