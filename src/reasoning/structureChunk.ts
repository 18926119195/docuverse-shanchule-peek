/**
 * Structural re-chunking on layout/OCR blocks (upstream refinement).
 * Produces ~512-char coherent units with union bbox for A1 key* registration.
 * Does not invent pages; only regroups existing blocks in reading order.
 *
 * Future MinerU/Docling adapters should emit LayoutBlock[] then call structureChunkBlocks.
 */

import type { PageTextChunk } from '../zigzag/types'

export interface StructureChunkOptions {
  /** Soft target size in characters (CJK ≈ tokens) */
  targetChars?: number
  minChars?: number
  maxChars?: number
  /** Max vertical gap (page_norm) to allow merge with next block */
  maxVerticalGap?: number
}

const DEFAULTS: Required<StructureChunkOptions> = {
  targetChars: 480,
  minChars: 100,
  maxChars: 720,
  maxVerticalGap: 48,
}

function unionBbox(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ]
}

function splitOversized(
  chunk: PageTextChunk,
  maxChars: number,
): PageTextChunk[] {
  const text = chunk.content.trim()
  if (text.length <= maxChars) return [chunk]

  const parts: string[] = []
  const sentences = text.split(/(?<=[。！？；!?;\n])/).filter((s) => s.trim())
  if (sentences.length === 0) {
    for (let i = 0; i < text.length; i += maxChars) {
      parts.push(text.slice(i, i + maxChars))
    }
  } else {
    let buf = ''
    for (const s of sentences) {
      if (buf.length + s.length > maxChars && buf.length >= maxChars * 0.4) {
        parts.push(buf)
        buf = s
      } else {
        buf += s
      }
      if (buf.length >= maxChars) {
        parts.push(buf)
        buf = ''
      }
    }
    if (buf.trim()) parts.push(buf)
  }

  return parts.map((content, i) => ({
    id: `${chunk.id}__s${i}`,
    content: content.trim(),
    bbox: [...chunk.bbox] as [number, number, number, number],
    inkBoxes: chunk.inkBoxes
      ? chunk.inkBoxes.map((b) => [...b] as [number, number, number, number])
      : [[...chunk.bbox] as [number, number, number, number]],
  }))
}

function canMerge(
  prev: PageTextChunk,
  next: PageTextChunk,
  maxVerticalGap: number,
): boolean {
  const gap = next.bbox[1] - prev.bbox[3]
  if (gap > maxVerticalGap) return false
  // Reject large horizontal jump (likely new column far away)
  const prevCx = (prev.bbox[0] + prev.bbox[2]) / 2
  const nextCx = (next.bbox[0] + next.bbox[2]) / 2
  if (Math.abs(nextCx - prevCx) > 280 && gap > 12) return false
  return true
}

function mergeInk(
  a: PageTextChunk,
  b: PageTextChunk,
): Array<[number, number, number, number]> {
  const left = a.inkBoxes?.length
    ? a.inkBoxes
    : [[...a.bbox] as [number, number, number, number]]
  const right = b.inkBoxes?.length
    ? b.inkBoxes
    : [[...b.bbox] as [number, number, number, number]]
  return [
    ...left.map((x) => [...x] as [number, number, number, number]),
    ...right.map((x) => [...x] as [number, number, number, number]),
  ]
}

/**
 * Regroup layout blocks into structural units suitable for one PlaceAtom / key*.
 * Merge ⇒ new unit (union bbox); constituent boxes kept in inkBoxes — never
 * re-match text to geometry later.
 */
export function structureChunkBlocks(
  blocks: PageTextChunk[],
  opts: StructureChunkOptions = {},
): PageTextChunk[] {
  const cfg = { ...DEFAULTS, ...opts }
  if (blocks.length === 0) return []

  const flat: PageTextChunk[] = []
  for (const b of blocks) {
    const t = b.content.trim()
    if (!t) continue
    flat.push(...splitOversized({ ...b, content: t }, cfg.maxChars))
  }
  if (flat.length === 0) return []

  const out: PageTextChunk[] = []
  let cur: PageTextChunk = { ...flat[0] }

  for (let i = 1; i < flat.length; i++) {
    const next = flat[i]
    const mergedLen = cur.content.length + 1 + next.content.length
    const wantMerge =
      cur.content.length < cfg.targetChars &&
      mergedLen <= cfg.maxChars &&
      canMerge(cur, next, cfg.maxVerticalGap)

    if (wantMerge) {
      cur = {
        id: `${cur.id}+${next.id}`,
        content: `${cur.content}\n${next.content}`,
        bbox: unionBbox(cur.bbox, next.bbox),
        inkBoxes: mergeInk(cur, next),
      }
      continue
    }

    // Flush if long enough, or if next cannot attach
    if (cur.content.length >= cfg.minChars || !canMerge(cur, next, cfg.maxVerticalGap)) {
      out.push(cur)
      cur = { ...next }
    } else {
      // Below min but adjacent: still merge to avoid tiny atoms
      cur = {
        id: `${cur.id}+${next.id}`,
        content: `${cur.content}\n${next.content}`,
        bbox: unionBbox(cur.bbox, next.bbox),
        inkBoxes: mergeInk(cur, next),
      }
    }
  }
  out.push(cur)

  // Final pass: merge tiny leftovers forward
  const cleaned: PageTextChunk[] = []
  for (const block of out) {
    const prev = cleaned[cleaned.length - 1]
    if (
      prev &&
      block.content.length < cfg.minChars &&
      prev.content.length + block.content.length <= cfg.maxChars &&
      canMerge(prev, block, cfg.maxVerticalGap * 1.5)
    ) {
      cleaned[cleaned.length - 1] = {
        id: `${prev.id}+${block.id}`,
        content: `${prev.content}\n${block.content}`,
        bbox: unionBbox(prev.bbox, block.bbox),
        inkBoxes: mergeInk(prev, block),
      }
    } else {
      cleaned.push(block)
    }
  }

  return cleaned.map((b, i) => ({
    ...b,
    id: b.id.includes('struct_') ? b.id : `struct_${i}_${b.id}`.slice(0, 120),
  }))
}

/** Adapter shape for future MinerU / Docling JSON → PageTextChunk */
export interface ExternalLayoutBlock {
  id: string
  page: number
  text: string
  bbox: [number, number, number, number]
  kind?: 'text' | 'title' | 'figure' | 'table' | string
}

export function externalBlocksToPageChunks(
  blocks: ExternalLayoutBlock[],
  page: number,
): PageTextChunk[] {
  return blocks
    .filter((b) => b.page === page && b.text.trim().length > 0)
    .filter((b) => !b.kind || !/^(figure|img|image|table)$/i.test(b.kind))
    .map((b) => ({
      id: b.id,
      content: b.text.trim(),
      bbox: b.bbox,
    }))
}
