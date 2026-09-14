import { assertDemoAccess } from '../_lib/auth.js'
import { preflight, withCors } from '../_lib/cors.js'
import { atomsFromEmittedSlots } from '../_lib/protocol/atoms.js'
import { emitPageSlots } from '../_lib/protocol/emitPage.js'
import { sealLockId } from '../_lib/protocol/handles.js'

/** OCR layout_parsing often exceeds Edge's short default; allow up to 60s. */
export const config = { runtime: 'edge', maxDuration: 60 }

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
  if (!isRecord(raw)) {
    return withCors(Response.json({ error: 'body object required' }, { status: 400 }), req)
  }
  const docId = typeof raw.docId === 'string' ? raw.docId.trim() : ''
  const page = typeof raw.page === 'number' ? raw.page : -1
  const imageDataUri =
    typeof raw.imageDataUri === 'string' ? raw.imageDataUri : ''
  if (!docId || page < 0 || !imageDataUri.startsWith('data:')) {
    return withCors(
      Response.json(
        { error: 'docId, page>=0, imageDataUri(data:) required' },
        { status: 400 },
      ),
      req,
    )
  }

  try {
    const emitted = await emitPageSlots({ docId, page, imageDataUri })
    const slots = await Promise.all(
      emitted.slots.map(async (s) => {
        const handle = await sealLockId(s.lockId)
        // bookKey handle = layout 坐标封印；layoutK 明示步序；T 仅脸
        return {
          handle,
          layoutK: s.layoutK,
          slotK: s.layoutK,
          label: s.label,
          bbox: s.bbox,
          content: s.content,
          sourceContent: s.sourceContent,
          cutBound: true as const,
        }
      }),
    )
    const atomsRaw = atomsFromEmittedSlots(docId, emitted.slots)
    const atoms = await Promise.all(
      atomsRaw.map(async (a) => {
        const handle = await sealLockId(a.lockId)
        return {
          handle,
          bbox: a.bbox,
          content: a.content,
          source: a.source,
          kind: a.kind,
          faces: {
            text: a.faces.text
              ? { content: a.faces.text.content }
              : undefined,
            fig: a.faces.fig
              ? { note: '图脸已附着' }
              : undefined,
          },
        }
      }),
    )
    return withCors(
      Response.json({
        ok: true,
        docId,
        page,
        slots,
        atoms,
        markdown: emitted.markdown,
        pageWidth: emitted.pageWidth,
        pageHeight: emitted.pageHeight,
      }),
      req,
    )
  } catch (e) {
    return withCors(
      Response.json(
        { ok: false, error: e instanceof Error ? e.message : String(e) },
        { status: 502 },
      ),
      req,
    )
  }
}
