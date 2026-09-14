/**
 * Inference units (bags) — types + helpers.
 * Geometric window/cross compose DELETED (handbook §0.10: motion brain commands bags).
 */

import type { BookIndex, CircleCandidate, AChunk } from './pipelineA'
import { atomToCandidate } from './pipelineA'

export type FanoutUnitKind = 'fine' | 'cluster'

export interface FanoutInferUnit {
  kind: FanoutUnitKind
  label: string
  candidate: CircleCandidate
}

function chunkByKey(index: BookIndex, key: string): AChunk | undefined {
  return index.chunks.find((c) => c.key === key)
}

/** Build one unit from an ordered key bag (motion / instruction only). */
export async function unitFromMemberKeys(
  bookIndex: BookIndex,
  memberKeys: ReadonlyArray<string>,
  label?: string,
): Promise<FanoutInferUnit | null> {
  const keys = memberKeys.filter(Boolean)
  if (keys.length === 0) return null
  const run = keys
    .map((k) => {
      const c = chunkByKey(bookIndex, k)
      return c ? { ...c, score: 1 } : null
    })
    .filter((c): c is AChunk & { score: number } => Boolean(c))
  if (run.length === 0) return null
  const candidate = await atomToCandidate(
    bookIndex.docId,
    run,
    run.length === 1 ? 'instr_fine' : 'instr_cluster',
  )
  return {
    kind: run.length === 1 ? 'fine' : 'cluster',
    label:
      label ??
      (run.length === 1
        ? `门 ${run[0].key.slice(-10)}`
        : `指令袋×${run.length}`),
    candidate,
  }
}
