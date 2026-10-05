/**
 * Local Vite middleware mirroring Vercel `/api/protocol/*` handlers
 * so `npm run dev` exercises the same backend protocol path.
 */
import type { Plugin } from 'vite'
import { loadEnv } from 'vite'
import path from 'node:path'
import { parseInferBody, runProtocolInfer } from '../api/_lib/protocol/inferCore.js'
import { emitPageSlots, type EmittedSlot } from '../api/_lib/protocol/emitPage.js'
import { atomsFromEmittedSlots, type ProtocolAtom } from '../api/_lib/protocol/atoms.js'
import { sealLockId, unsealMany } from '../api/_lib/protocol/handles.js'
import { makeComboKey, makeFigKey, makeSlotKey } from '../api/_lib/protocol/keys.js'
import {
  ensureClosure,
  matchDirections,
  rememberDirection,
  resolveReuse,
  type ClosureSnap,
} from '../api/_lib/protocol/closureEngine.js'
import { llmUpstream } from '../api/_lib/env.js'

function injectProcessEnv(mode: string, root: string): void {
  const env = {
    ...loadEnv(mode, path.resolve(root, '..'), ''),
    ...loadEnv(mode, root, ''),
  }
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) process.env[k] = v
  }
}

function readDemoToken(req: import('http').IncomingMessage): string {
  const auth = req.headers.authorization?.trim() ?? ''
  const xt = (req.headers['x-demo-token'] as string | undefined)?.trim() ?? ''
  if (xt) return xt
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return ''
}

function assertLocalDemo(
  req: import('http').IncomingMessage,
): { ok: true } | { ok: false; status: number; body: string } {
  const expected = (process.env.DEMO_ACCESS_TOKEN ?? '').trim()
  if (!expected) return { ok: true }
  if (readDemoToken(req) !== expected) {
    return {
      ok: false,
      status: 401,
      body: JSON.stringify({ error: 'demo token required or invalid' }),
    }
  }
  return { ok: true }
}

async function readJsonBody(
  req: import('http').IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw) as unknown
}

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

function json(
  res: import('http').ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

export function viteProtocolApiPlugin(root: string, mode: string): Plugin {
  injectProcessEnv(mode, root)

  return {
    name: 'docuverse-protocol-api',
    configureServer(server) {
      // DeepSeek chat proxy — before Vite http-proxy.
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0]
        if (url === '/api/llm/embeddings') {
          json(res, 410, {
            error: 'embedding_disabled',
            message: '本项目已关闭 embedding',
          })
          return
        }
        const isChat = url === '/api/llm/chat/completions'
        if (!isChat) {
          next()
          return
        }

        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }

        const gate = assertLocalDemo(req)
        if (!gate.ok) {
          json(res, gate.status, JSON.parse(gate.body))
          return
        }

        if (req.method !== 'POST') {
          json(res, 405, { error: 'POST only' })
          return
        }

        try {
          const raw = await readJsonBody(req)
          const upstream = llmUpstream()
          const lockedModel = upstream.chatModel
          const body =
            typeof raw === 'object' && raw !== null
              ? { ...raw, model: lockedModel }
              : { model: lockedModel }
          const sub = 'chat/completions'
          const target = `${upstream.baseUrl}/${sub}`
          const upstreamRes = await fetch(target, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${upstream.apiKey}`,
            },
            body: JSON.stringify(body),
          })
          const text = await upstreamRes.text()
          res.statusCode = upstreamRes.status
          res.setHeader(
            'Content-Type',
            upstreamRes.headers.get('content-type') ?? 'application/json',
          )
          res.end(text)
        } catch (e) {
          json(res, 502, {
            error: e instanceof Error ? e.message : String(e),
          })
        }
      })

      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0]
        if (!url.startsWith('/api/protocol/')) {
          next()
          return
        }

        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }

        const gate = assertLocalDemo(req)
        if (!gate.ok) {
          json(res, gate.status, JSON.parse(gate.body))
          return
        }

        if (req.method !== 'POST') {
          json(res, 405, { error: 'POST only' })
          return
        }

        try {
          const raw = await readJsonBody(req)

          if (url.startsWith('/api/protocol/infer-ops')) {
            const { parseInferOpsBody, runInferWithOps } = await import(
              '../api/_lib/protocol/inferOpsCore.js'
            )
            const parsed = parseInferOpsBody(raw)
            if (typeof parsed === 'string') {
              json(res, 400, { error: parsed })
              return
            }
            const result = await runInferWithOps(parsed)
            json(res, result.ok ? 200 : 502, result)
            return
          }

          if (url.startsWith('/api/protocol/formalize')) {
            const { parseFormalizeBody, runFormalize } = await import(
              '../api/_lib/protocol/formalizeCore.js'
            )
            const parsed = parseFormalizeBody(raw)
            if (typeof parsed === 'string') {
              json(res, 400, { error: parsed })
              return
            }
            const result = await runFormalize(parsed)
            json(res, result.ok ? 200 : 502, result)
            return
          }

          if (url.startsWith('/api/protocol/infer')) {
            const parsed = parseInferBody(raw)
            if (typeof parsed === 'string') {
              json(res, 400, { error: parsed })
              return
            }
            const result = await runProtocolInfer(parsed)
            json(res, result.ok ? 200 : 502, result)
            return
          }

          if (url.startsWith('/api/protocol/emit-page')) {
            if (!isRecord(raw)) {
              json(res, 400, { error: 'body object required' })
              return
            }
            const docId = typeof raw.docId === 'string' ? raw.docId.trim() : ''
            const page = typeof raw.page === 'number' ? raw.page : -1
            const imageDataUri =
              typeof raw.imageDataUri === 'string' ? raw.imageDataUri : ''
            if (!docId || page < 0 || !imageDataUri.startsWith('data:')) {
              json(res, 400, {
                error: 'docId, page>=0, imageDataUri(data:) required',
              })
              return
            }
            const emitted = await emitPageSlots({ docId, page, imageDataUri })
            const slots = await Promise.all(
              emitted.slots.map(async (s: EmittedSlot) => ({
                handle: await sealLockId(s.lockId),
                label: s.label,
                bbox: s.bbox,
                content: s.content,
                sourceContent: s.sourceContent,
                cutBound: true as const,
              })),
            )
            const atomsRaw = atomsFromEmittedSlots(docId, emitted.slots)
            const atoms = await Promise.all(
              atomsRaw.map(async (a: ProtocolAtom) => ({
                handle: await sealLockId(a.lockId),
                bbox: a.bbox,
                content: a.content,
                source: a.source,
                kind: a.kind,
                faces: {
                  text: a.faces.text
                    ? { content: a.faces.text.content }
                    : undefined,
                  fig: a.faces.fig ? { note: '图脸已附着' } : undefined,
                },
              })),
            )
            json(res, 200, {
              ok: true,
              docId,
              page,
              slots,
              atoms,
              markdown: emitted.markdown,
              pageWidth: emitted.pageWidth,
              pageHeight: emitted.pageHeight,
            })
            return
          }

          if (url.startsWith('/api/protocol/mint-key')) {
            if (!isRecord(raw) || typeof raw.kind !== 'string') {
              json(res, 400, { error: 'kind required (combo|fig|slot|ping)' })
              return
            }
            const docId = typeof raw.docId === 'string' ? raw.docId.trim() : ''
            if (!docId && raw.kind !== 'ping') {
              json(res, 400, { error: 'docId required' })
              return
            }
            if (raw.kind === 'combo') {
              const members = Array.isArray(raw.memberHandles)
                ? raw.memberHandles.filter((x): x is string => typeof x === 'string')
                : []
              if (members.length < 2) {
                json(res, 400, { error: 'memberHandles (>=2) required' })
                return
              }
              const lockIds = await unsealMany(members)
              const handle = await sealLockId(makeComboKey(docId, lockIds))
              json(res, 200, {
                ok: true,
                kind: 'combo',
                handle,
                memberCount: members.length,
              })
              return
            }
            if (raw.kind === 'slot') {
              const page = typeof raw.page === 'number' ? raw.page : -1
              const k = typeof raw.k === 'number' ? raw.k : -1
              if (page < 0 || k < 0) {
                json(res, 400, { error: 'page>=0 and k>=0 required' })
                return
              }
              const handle = await sealLockId(makeSlotKey(docId, page, k))
              json(res, 200, { ok: true, kind: 'slot', handle })
              return
            }
            if (raw.kind === 'fig') {
              const figId = typeof raw.figId === 'string' ? raw.figId.trim() : ''
              if (!figId) {
                json(res, 400, { error: 'figId required' })
                return
              }
              const handle = await sealLockId(makeFigKey(docId, figId))
              json(res, 200, { ok: true, kind: 'fig', handle })
              return
            }
            if (raw.kind === 'ping') {
              json(res, 200, { ok: true, valid: true })
              return
            }
            json(res, 400, { error: 'unknown kind (combo|fig|slot|ping)' })
            return
          }

          if (url.startsWith('/api/protocol/closure')) {
            if (!isRecord(raw) || typeof raw.action !== 'string') {
              json(res, 400, { error: 'action required' })
              return
            }
            const closures = asClosureMap(raw.closures)
            const action = raw.action

            if (action === 'ensure') {
              const key = typeof raw.key === 'string' ? raw.key : ''
              const excerpt = typeof raw.excerpt === 'string' ? raw.excerpt : ''
              if (!key) {
                json(res, 400, { error: 'key required' })
                return
              }
              const memberKeys = Array.isArray(raw.memberKeys)
                ? raw.memberKeys.filter((x): x is string => typeof x === 'string')
                : undefined
              const { map, closure } = ensureClosure(closures, {
                key,
                excerpt,
                memberKeys,
              })
              json(res, 200, { ok: true, closures: map, closure })
              return
            }

            if (action === 'match') {
              const key = typeof raw.key === 'string' ? raw.key : ''
              const question = typeof raw.question === 'string' ? raw.question : ''
              const c = closures[key]
              if (!c) {
                json(res, 404, { error: 'closure not found' })
                return
              }
              const hits = matchDirections(c, question)
              json(res, 200, { ok: true, hits, closures })
              return
            }

            if (action === 'reuse') {
              const key = typeof raw.key === 'string' ? raw.key : ''
              const directionId =
                typeof raw.directionId === 'string' ? raw.directionId : ''
              const c = closures[key]
              if (!c) {
                json(res, 404, { error: 'closure not found' })
                return
              }
              const result = resolveReuse(c, directionId)
              json(res, 200, { ok: true, ...result, closures })
              return
            }

            if (action === 'remember') {
              const key = typeof raw.key === 'string' ? raw.key : ''
              const questionText =
                typeof raw.questionText === 'string' ? raw.questionText : ''
              const pathStr = typeof raw.path === 'string' ? raw.path : ''
              const conclusion =
                typeof raw.conclusion === 'string' ? raw.conclusion : ''
              if (!key || !questionText) {
                json(res, 400, { error: 'key and questionText required' })
                return
              }
              const { map, directionId } = rememberDirection(closures, {
                key,
                questionText,
                path: pathStr,
                conclusion,
              })
              json(res, 200, { ok: true, closures: map, directionId })
              return
            }

            json(res, 400, {
              error: 'unknown action (ensure|match|reuse|remember)',
            })
            return
          }

          next()
        } catch (e) {
          json(res, 500, {
            error: e instanceof Error ? e.message : String(e),
          })
        }
      })
    },
  }
}
