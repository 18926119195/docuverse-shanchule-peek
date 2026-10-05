/**
 * Persist A1 book index beside the original (spec: 旁路持久化).
 * Compound B-side run keys are never stored here.
 */

import type { BookIndex } from './pipelineA'
import type { AChunkSource, PlaceFaces, PlaceKind } from './types'

/** v2: layout-slot bookKey (doc|slot|p|layoutK) + slotK/layoutK on atoms */
const STORAGE_PREFIX = 'docuverse.a1.v2:'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isFaces(v: unknown): v is PlaceFaces {
  if (!isRecord(v)) return false
  let ok = false
  if (v.text !== undefined) {
    if (
      !isRecord(v.text) ||
      typeof v.text.start !== 'number' ||
      typeof v.text.end !== 'number' ||
      typeof v.text.content !== 'string'
    ) {
      return false
    }
    ok = true
  }
  if (v.fig !== undefined) {
    if (
      !isRecord(v.fig) ||
      typeof v.fig.figId !== 'string' ||
      typeof v.fig.note !== 'string'
    ) {
      return false
    }
    if (
      v.fig.imageRef !== undefined &&
      typeof v.fig.imageRef !== 'string'
    ) {
      return false
    }
    ok = true
  }
  return ok
}

function isSource(v: unknown): v is AChunkSource {
  return (
    v === 'ocr' || v === 'pdf_text' || v === 'page_text' || v === 'layout_fig'
  )
}

function isKind(v: unknown): v is PlaceKind {
  return v === 'text' || v === 'fig'
}

export function saveBookIndex(index: BookIndex): void {
  try {
    // Drop large imageRef blobs from storage; rebuild will reattach from pages
    const slim: BookIndex = {
      ...index,
      chunks: index.chunks.map((c) => ({
        ...c,
        faces: {
          text: c.faces.text,
          fig: c.faces.fig
            ? {
                figId: c.faces.fig.figId,
                note: c.faces.fig.note,
                // keep short refs only
                imageRef:
                  c.faces.fig.imageRef &&
                  c.faces.fig.imageRef.length < 200
                    ? c.faces.fig.imageRef
                    : undefined,
              }
            : undefined,
        },
      })),
    }
    localStorage.setItem(STORAGE_PREFIX + index.docId, JSON.stringify(slim))
  } catch {
    /* quota */
  }
}

export function loadBookIndex(docId: string): BookIndex | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + docId)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    if (typeof parsed.docId !== 'string' || typeof parsed.stream !== 'string') {
      return null
    }
    if (!Array.isArray(parsed.chunks)) return null
    const chunks = []
    for (const item of parsed.chunks) {
      if (!isRecord(item) || !isFaces(item.faces) || !isSource(item.source)) {
        return null
      }
      if (!isKind(item.kind) || typeof item.key !== 'string') return null
      if (
        typeof item.ord !== 'number' ||
        typeof item.id !== 'string' ||
        typeof item.page !== 'number' ||
        typeof item.start !== 'number' ||
        typeof item.end !== 'number' ||
        typeof item.content !== 'string' ||
        !Array.isArray(item.bbox) ||
        item.bbox.length !== 4
      ) {
        return null
      }
      const bbox: [number, number, number, number] = [
        Number(item.bbox[0]),
        Number(item.bbox[1]),
        Number(item.bbox[2]),
        Number(item.bbox[3]),
      ]
      let inkBoxes: Array<[number, number, number, number]> | undefined
      if (Array.isArray(item.inkBoxes)) {
        inkBoxes = []
        for (const raw of item.inkBoxes) {
          if (!Array.isArray(raw) || raw.length !== 4) continue
          inkBoxes.push([
            Number(raw[0]),
            Number(raw[1]),
            Number(raw[2]),
            Number(raw[3]),
          ])
        }
        if (inkBoxes.length === 0) inkBoxes = undefined
      }
      const faces = item.faces
      const vBook = Array.isArray(item.vBook)
        ? item.vBook.map((x) => Number(x))
        : []
      const slotK =
        typeof item.slotK === 'number'
          ? item.slotK
          : typeof item.layoutK === 'number'
            ? item.layoutK
            : typeof item.ord === 'number'
              ? item.ord
              : 0
      const layoutK =
        typeof item.layoutK === 'number' ? item.layoutK : slotK
      chunks.push({
        ord: item.ord,
        id: item.id,
        page: item.page,
        bbox,
        inkBoxes,
        start: item.start,
        end: item.end,
        source: item.source,
        kind: item.kind,
        key: item.key,
        slotK,
        layoutK,
        faces,
        content: item.content,
        figId: typeof item.figId === 'string' ? item.figId : undefined,
        vBook,
      })
    }
    return {
      docId: parsed.docId,
      stream: parsed.stream,
      chunks,
      builtAt: typeof parsed.builtAt === 'number' ? parsed.builtAt : Date.now(),
    }
  } catch {
    return null
  }
}

export function clearBookIndex(docId: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + docId)
  } catch {
    /* ignore */
  }
}
