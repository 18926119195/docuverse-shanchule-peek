/**
 * Extract pdf.js text layer → A-pipeline chunks in page_norm_0_1000.
 * Same viewport as the rendered page image so circling maps onto glyphs.
 */

import type { PageTextChunk } from '../zigzag/types'

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

function asTextItem(v: unknown): {
  str: string
  transform: number[]
  width: number
  height: number
} | null {
  const rec = asRecord(v)
  if (!rec) return null
  if (typeof rec.str !== 'string') return null
  if (!Array.isArray(rec.transform) || rec.transform.length < 6) return null
  const transform = rec.transform.map((n) => Number(n))
  if (transform.some((n) => Number.isNaN(n))) return null
  return {
    str: rec.str,
    transform,
    width: typeof rec.width === 'number' && Number.isFinite(rec.width) ? rec.width : 0,
    height:
      typeof rec.height === 'number' && Number.isFinite(rec.height) ? rec.height : 0,
  }
}

function clamp1000(n: number): number {
  return Math.max(0, Math.min(1000, n))
}

function readViewport(v: unknown): {
  width: number
  height: number
  scale: number
  convertToViewportPoint: (x: number, y: number) => number[]
} | null {
  const rec = asRecord(v)
  if (!rec) return null
  if (typeof rec.width !== 'number' || typeof rec.height !== 'number') return null
  if (typeof rec.convertToViewportPoint !== 'function') return null
  // Must keep `this` = viewport; extracting the method breaks pdf.js (reads .transform).
  const convert = rec.convertToViewportPoint as (
    this: unknown,
    x: number,
    y: number,
  ) => unknown
  return {
    width: rec.width,
    height: rec.height,
    scale: typeof rec.scale === 'number' && rec.scale > 0 ? rec.scale : 1,
    convertToViewportPoint: (x, y) => {
      const pt = convert.call(v, x, y)
      if (!Array.isArray(pt) || pt.length < 2) return []
      return [Number(pt[0]), Number(pt[1])]
    },
  }
}

function itemToBbox(
  item: { str: string; transform: number[]; width: number; height: number },
  viewport: {
    width: number
    height: number
    scale: number
    convertToViewportPoint: (x: number, y: number) => number[]
  },
): [number, number, number, number] | null {
  const tr = item.transform
  const pdfX = tr[4]
  const pdfY = tr[5]
  const fontPdf = Math.hypot(tr[2], tr[3]) || Math.abs(tr[3]) || 9
  const widthPdf =
    item.width > 0 ? item.width : Math.abs(tr[0]) * Math.max(1, item.str.length) * 0.45
  const pt = viewport.convertToViewportPoint(pdfX, pdfY)
  if (pt.length < 2 || Number.isNaN(pt[0]) || Number.isNaN(pt[1])) return null
  const vx = pt[0]
  const vy = pt[1]
  const fontPx = fontPdf * viewport.scale
  const widthPx = widthPdf * viewport.scale
  const top = vy - fontPx
  const bottom = vy + Math.max(1, item.height * viewport.scale * 0.15)
  const vw = viewport.width
  const vh = viewport.height
  if (vw < 1 || vh < 1) return null
  const x0 = clamp1000((vx / vw) * 1000)
  const x1 = clamp1000(((vx + widthPx) / vw) * 1000)
  const y0 = clamp1000((top / vh) * 1000)
  const y1 = clamp1000((bottom / vh) * 1000)
  if (x1 - x0 < 0.4 || y1 - y0 < 0.4) return null
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]
}

type RawBox = {
  str: string
  bbox: [number, number, number, number]
}

function yCenter(b: [number, number, number, number]): number {
  return (b[1] + b[3]) / 2
}

function mergeBoxes(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ]
}

/** Cluster glyphs into lines, then adjacent lines into paragraph chunks. */
function mergeToChunks(items: RawBox[], strandIndex: number): PageTextChunk[] {
  if (items.length === 0) return []
  const sorted = [...items].sort((a, b) => {
    const dy = yCenter(a.bbox) - yCenter(b.bbox)
    if (Math.abs(dy) > 4) return dy
    return a.bbox[0] - b.bbox[0]
  })

  const lines: RawBox[] = []
  let cur: RawBox = { str: sorted[0].str, bbox: [...sorted[0].bbox] }
  for (let i = 1; i < sorted.length; i++) {
    const it = sorted[i]
    const sameLine = Math.abs(yCenter(it.bbox) - yCenter(cur.bbox)) <= 10
    if (sameLine) {
      const gap = it.bbox[0] - cur.bbox[2]
      const joiner = gap > 4 ? ' ' : ''
      cur = {
        str: (cur.str + joiner + it.str).replace(/\s+/g, ' '),
        bbox: mergeBoxes(cur.bbox, it.bbox),
      }
    } else {
      if (cur.str.trim()) lines.push(cur)
      cur = { str: it.str, bbox: [...it.bbox] }
    }
  }
  if (cur.str.trim()) lines.push(cur)

  const paras: RawBox[] = []
  let p: RawBox | null = null
  for (const line of lines) {
    const text = line.str.trim()
    if (!text) continue
    if (!p) {
      p = { str: text, bbox: [...line.bbox] }
      continue
    }
    const gap = line.bbox[1] - p.bbox[3]
    const lineH = Math.max(8, line.bbox[3] - line.bbox[1])
    if (gap >= 0 && gap <= lineH * 1.55) {
      p = {
        str: `${p.str}\n${text}`,
        bbox: mergeBoxes(p.bbox, line.bbox),
      }
    } else {
      paras.push(p)
      p = { str: text, bbox: [...line.bbox] }
    }
  }
  if (p) paras.push(p)

  return paras.map((box, i) => ({
    id: `pdf_s${strandIndex}_c${i}`,
    content: box.str.trim(),
    bbox: box.bbox,
  }))
}

export async function extractPdfTextChunks(
  page: unknown,
  viewportRaw: unknown,
  strandIndex: number,
): Promise<PageTextChunk[]> {
  const viewport = readViewport(viewportRaw)
  const pageRec = asRecord(page)
  if (!viewport || !pageRec || typeof pageRec.getTextContent !== 'function') {
    return []
  }
  // Must call as method on page — extracting loses `this` → `_transport` undefined.
  const getTextContent = pageRec.getTextContent as (params?: {
    includeMarkedContent?: boolean
  }) => Promise<unknown>
  try {
    const contentRaw = await getTextContent.call(page, {
      includeMarkedContent: false,
    })
    const content = asRecord(contentRaw)
    const items = content && Array.isArray(content.items) ? content.items : []
    const raw: RawBox[] = []
    for (const item of items) {
      const ti = asTextItem(item)
      if (!ti) continue
      const str = ti.str.replace(/\s+/g, ' ').trim()
      if (!str) continue
      const bbox = itemToBbox(ti, viewport)
      if (!bbox) continue
      raw.push({ str, bbox })
    }
    return mergeToChunks(raw, strandIndex)
  } catch (err) {
    console.warn(`PDF text layer extract failed (strand ${strandIndex})`, err)
    return []
  }
}
