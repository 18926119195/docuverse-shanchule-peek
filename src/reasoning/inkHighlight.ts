/**
 * Highlight uses registered slot AABB only.
 * Text→bbox rematch is kept as a dead-end helper (not used on the main path).
 */

import type { OcrBlock } from '../data/ocrService'
import type { PageTextChunk } from '../zigzag/types'
import type { LockBox } from './types'

export function normalizeInkText(s: string): string {
  return s
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/\\[a-z]+\{([^}]*)\}/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function unionBbox(
  boxes: Array<[number, number, number, number]>,
): [number, number, number, number] | null {
  if (boxes.length === 0) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b[0])
    y0 = Math.min(y0, b[1])
    x1 = Math.max(x1, b[2])
    y1 = Math.max(y1, b[3])
  }
  if (!(x1 > x0 && y1 > y0)) return null
  return [x0, y0, x1, y1]
}

type LayoutUnit = {
  content: string
  bbox: [number, number, number, number]
}

function layoutUnitsFromPage(input: {
  pageChunks?: PageTextChunk[]
  ocrBlocks?: OcrBlock[]
}): LayoutUnit[] {
  const fromPdf = (input.pageChunks ?? [])
    .filter((c) => c.content.trim().length > 0)
    .map((c) => ({ content: c.content.trim(), bbox: c.bbox }))
  if (fromPdf.length > 0) return fromPdf
  return (input.ocrBlocks ?? [])
    .filter((b) => b.content.trim().length > 0)
    .map((b) => ({ content: b.content.trim(), bbox: b.bbox }))
}

/**
 * Legacy helper — do not use on main restore path.
 * Prefer candidate.boxes / slot AABB registered at emission.
 */
export function resolveInkBoxes(input: {
  text: string
  page: number
  pageChunks?: PageTextChunk[]
  ocrBlocks?: OcrBlock[]
}): LockBox[] {
  const needle = normalizeInkText(input.text)
  if (needle.length < 12) return []

  const units = layoutUnitsFromPage(input)
  if (units.length === 0) return []

  const norms = units.map((u) => normalizeInkText(u.content))
  let pageStream = ''
  const spans: Array<{ start: number; end: number; idx: number }> = []
  for (let i = 0; i < norms.length; i++) {
    const n = norms[i]
    if (!n) continue
    if (pageStream.length > 0) pageStream += ' '
    const start = pageStream.length
    pageStream += n
    spans.push({ start, end: pageStream.length, idx: i })
  }
  if (!pageStream || spans.length === 0) return []

  let hitStart = pageStream.indexOf(needle)
  let hitEnd = hitStart >= 0 ? hitStart + needle.length : -1

  if (hitStart < 0) {
    const prefixLen = Math.min(96, Math.max(24, Math.floor(needle.length * 0.35)))
    const prefix = needle.slice(0, prefixLen)
    hitStart = pageStream.indexOf(prefix)
    if (hitStart >= 0) {
      const rest = needle.slice(prefixLen)
      const after = pageStream.slice(hitStart + prefix.length)
      const restHit = rest.length >= 12 ? after.indexOf(rest.slice(0, 48)) : 0
      hitEnd =
        restHit >= 0
          ? hitStart + prefix.length + restHit + Math.min(48, rest.length)
          : hitStart + Math.min(needle.length, pageStream.length - hitStart)
    }
  }

  if (hitStart < 0) {
    const contained = units
      .map((u, idx) => ({ u, idx, n: norms[idx] }))
      .filter(({ n }) => n.length >= 16 && needle.includes(n))
    if (contained.length === 0) return []
    return contained.map(({ u }) => ({
      page: input.page,
      bbox: u.bbox,
    }))
  }

  const covered = spans.filter((s) => s.end > hitStart && s.start < hitEnd)
  if (covered.length === 0) return []

  return covered.map((s) => ({
    page: input.page,
    bbox: units[s.idx].bbox,
  }))
}

export function unionLockBoxes(
  boxes: LockBox[],
): [number, number, number, number] | null {
  return unionBbox(boxes.map((b) => b.bbox))
}

/** Always prefer registered fallback (slot AABB). Rematch disabled on main path. */
export function refineCandidateBoxes(input: {
  text: string
  page: number
  fallback: LockBox[]
  pageChunks?: PageTextChunk[]
  ocrBlocks?: OcrBlock[]
}): LockBox[] {
  void input.text
  void input.pageChunks
  void input.ocrBlocks
  if (input.fallback.length > 0) return input.fallback
  return []
}

export type InkRefineResult = {
  boxes: LockBox[]
  method: 'slot_aabb' | 'slot_inkBoxes'
  note: string
}

/**
 * Main restore path: use boxes already on the candidate (emission AABB).
 * Does not call vision_ground or text rematch.
 */
export async function refineCandidateBoxesAsync(input: {
  text: string
  page: number
  fallback: LockBox[]
  pageChunks?: PageTextChunk[]
  ocrBlocks?: OcrBlock[]
  imageUrl?: string
}): Promise<InkRefineResult> {
  void input.text
  void input.pageChunks
  void input.ocrBlocks
  void input.imageUrl
  const boxes =
    input.fallback.filter((b) => b.page === input.page).length > 0
      ? input.fallback.filter((b) => b.page === input.page)
      : input.fallback
  return {
    boxes,
    method: 'slot_aabb',
    note: `排放槽 AABB ×${boxes.length}（禁止 T→框换绑）`,
  }
}
