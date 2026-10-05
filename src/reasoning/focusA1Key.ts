/**
 * Focus an A1 key on the PDF poker stage (swoop + lockBoxes outline).
 */

import type { BookIndex } from './pipelineA'
import { atomSearchText } from './hybridRetrieve'
import { useReasoning } from './closureStore'
import type { CircleCandidate } from './pipelineA'

function pickBbox(
  chunk: BookIndex['chunks'][number],
): [number, number, number, number] {
  const area = (b: [number, number, number, number]) =>
    Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
  const full = 0.82 * 1_000_000
  if (area(chunk.bbox) < full) return chunk.bbox
  const ink = (chunk.inkBoxes ?? []).find((b) => area(b) < full)
  return ink ?? chunk.bbox
}

export function focusA1KeyOnPdf(input: {
  key: string
  bookIndex: BookIndex
  swoopToPage: (strand: number) => void
  /** Highlight all of these keys' boxes; focus `key`. */
  alsoKeys?: string[]
}): boolean {
  const { key, bookIndex, swoopToPage } = input
  const focusChunk = bookIndex.chunks.find((c) => c.key === key)
  if (!focusChunk) return false

  const keySet = new Set<string>([key, ...(input.alsoKeys ?? [])])
  const boxes: Array<{
    page: number
    bbox: [number, number, number, number]
    focus?: boolean
  }> = []
  for (const c of bookIndex.chunks) {
    if (!keySet.has(c.key)) continue
    boxes.push({
      page: c.page,
      bbox: pickBbox(c),
      focus: c.key === key,
    })
  }
  if (boxes.length === 0) return false

  const excerpt = atomSearchText(focusChunk)
  swoopToPage(focusChunk.page)
  useReasoning.getState().activateResolved({
    chosen: {
      R: {
        docId: bookIndex.docId,
        kind: focusChunk.kind,
        key: focusChunk.key,
        start: focusChunk.start,
        end: focusChunk.end,
        page: focusChunk.page,
        slotK: focusChunk.slotK,
        emphasisId: 'a1_chat',
        chunkIds: [focusChunk.id],
        source: focusChunk.source,
        faces: focusChunk.faces,
      },
      excerpt: excerpt || ' ',
      score: 1,
      chunkIds: [focusChunk.id],
      boxes: boxes as CircleCandidate['boxes'],
      members: boxes.map((b) => ({
        slotId: key,
        pctStart: 0,
        pctEnd: 100,
        page: b.page,
        bbox: b.bbox,
      })),
    },
    candidates: [],
  })
  return true
}
