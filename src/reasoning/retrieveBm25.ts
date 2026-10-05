/**
 * BM25-only recall over A1 atoms (no embedding / vBook).
 */

import {
  atomSearchText,
  bm25Rank,
  isRetrievableAtom,
  refineDraftHits,
  scoreGapAllowsAutoLock,
} from './hybridRetrieve'
import {
  atomToCandidate,
  type BookIndex,
  type CircleCandidate,
} from './pipelineA'
import { facesToReadout } from './intrinsicKey'

export async function recallCandidatesByBm25(input: {
  bookIndex: BookIndex
  query: string
  topK: number
  /** When set, only keys in this set are eligible */
  allowedKeys?: ReadonlySet<string> | null
}): Promise<{
  candidates: CircleCandidate[]
  poolSize: number
  autoLockOk: boolean
  weakFigOnly: boolean
}> {
  const q = input.query.trim()
  const topK = input.topK
  const index = input.bookIndex

  if (!q || index.chunks.length === 0) {
    return {
      candidates: [],
      poolSize: 0,
      autoLockOk: false,
      weakFigOnly: false,
    }
  }

  const weakFigOnly =
    index.chunks.length > 0 && index.chunks.every((c) => c.kind === 'fig')

  const pool = index.chunks
    .map((chunk, indexInBook) => ({ chunk, indexInBook }))
    .filter(({ chunk }) => {
      if (!isRetrievableAtom(chunk)) return false
      if (input.allowedKeys && !input.allowedKeys.has(chunk.key)) return false
      return true
    })

  if (pool.length === 0) {
    return {
      candidates: [],
      poolSize: 0,
      autoLockOk: false,
      weakFigOnly,
    }
  }

  const docTexts = pool.map(({ chunk }) => atomSearchText(chunk))
  const poolFetch = Math.min(Math.max(topK * 4, topK), pool.length)
  const rankedRaw = bm25Rank(q, docTexts, poolFetch)
  const ranked = refineDraftHits({
    hits: rankedRaw.map((h) => ({
      index: h.index,
      dense: 0,
      sparse: h.score,
      fused: h.score,
    })),
    docTexts,
    query: q,
    topK: Math.min(topK, pool.length),
  })

  const candidates = await Promise.all(
    ranked.map(async (hit) => {
      const { chunk } = pool[hit.index]
      const c = await atomToCandidate(
        index.docId,
        [{ ...chunk, score: Math.max(0.01, hit.fused) }],
        'bm25_anchor',
      )
      c.excerpt = facesToReadout(c.R.faces)
      return c
    }),
  )

  const autoLockOk = scoreGapAllowsAutoLock(
    ranked.map((h) => h.fused),
    0.08,
    0.35,
  )

  return {
    candidates,
    poolSize: pool.length,
    autoLockOk,
    weakFigOnly,
  }
}
