/**
 * Mint opaque handles for combo / fig / layout-slot bookKey (server authority).
 * kind=slot：k = layoutK（bookKey 时间分量）；非 OCR 步。
 */
import { assertDemoAccess } from '../_lib/auth.js'
import { preflight, withCors } from '../_lib/cors.js'
import { sealLockId, unsealHandle, unsealMany } from '../_lib/protocol/handles.js'
import { makeComboKey, makeFigKey, makeSlotKey } from '../_lib/protocol/keys.js'

export const config = { runtime: 'edge' }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
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
  if (!isRecord(raw) || typeof raw.kind !== 'string') {
    return withCors(
      Response.json({ error: 'kind required (combo|fig)' }, { status: 400 }),
      req,
    )
  }

  const docId = typeof raw.docId === 'string' ? raw.docId.trim() : ''
  if (!docId) {
    return withCors(Response.json({ error: 'docId required' }, { status: 400 }), req)
  }

  try {
    if (raw.kind === 'combo') {
      const members = Array.isArray(raw.memberHandles)
        ? raw.memberHandles.filter((x): x is string => typeof x === 'string')
        : []
      if (members.length < 2) {
        return withCors(
          Response.json({ error: 'memberHandles (>=2) required' }, { status: 400 }),
          req,
        )
      }
      const lockIds = await unsealMany(members)
      const lockId = makeComboKey(docId, lockIds)
      const handle = await sealLockId(lockId)
      return withCors(
        Response.json({ ok: true, kind: 'combo', handle, memberCount: members.length }),
        req,
      )
    }

    if (raw.kind === 'slot') {
      // layoutK：bookKey = (doc, page, layoutK)；同槽改 T 应复用同一 handle
      const page = typeof raw.page === 'number' ? raw.page : -1
      const k =
        typeof raw.layoutK === 'number'
          ? raw.layoutK
          : typeof raw.k === 'number'
            ? raw.k
            : -1
      if (page < 0 || k < 0) {
        return withCors(
          Response.json(
            { error: 'page>=0 and layoutK|k>=0 required' },
            { status: 400 },
          ),
          req,
        )
      }
      const lockId = makeSlotKey(docId, page, k)
      const handle = await sealLockId(lockId)
      return withCors(
        Response.json({ ok: true, kind: 'slot', handle, layoutK: k }),
        req,
      )
    }

    if (raw.kind === 'fig') {
      const figId = typeof raw.figId === 'string' ? raw.figId.trim() : ''
      if (!figId) {
        return withCors(Response.json({ error: 'figId required' }, { status: 400 }), req)
      }
      const lockId = makeFigKey(docId, figId)
      const handle = await sealLockId(lockId)
      return withCors(Response.json({ ok: true, kind: 'fig', handle }), req)
    }

    if (raw.kind === 'unseal-audit') {
      // Dev-only style: never return lockId to browser in normal paths.
      // Kept for server tests — reject unless explicitly enabled.
      return withCors(
        Response.json({ error: 'unseal-audit disabled' }, { status: 403 }),
        req,
      )
    }

    // Validate handle without revealing lockId
    if (raw.kind === 'ping') {
      const handle = typeof raw.handle === 'string' ? raw.handle : ''
      if (!handle) {
        return withCors(Response.json({ error: 'handle required' }, { status: 400 }), req)
      }
      await unsealHandle(handle)
      return withCors(Response.json({ ok: true, valid: true }), req)
    }

    return withCors(
      Response.json({ error: 'unknown kind (combo|fig|slot|ping)' }, { status: 400 }),
      req,
    )
  } catch (e) {
    return withCors(
      Response.json(
        { ok: false, error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      ),
      req,
    )
  }
}
