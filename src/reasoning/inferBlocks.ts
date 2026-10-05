/**
 * Build infer-ops blocks from fanout units + book index (compiler fallback source).
 */

import type { FanoutInferUnit } from './fanoutCompose'
import type { AbBlock } from './formalPath'
import { shortHandle } from './ocrSlot'
import type { BookIndex } from './pipelineA'
import { unitMemberKeysOf } from './letterDesk'

export function blocksFromInferUnit(
  unit: FanoutInferUnit,
  bookIndex: BookIndex,
): AbBlock[] {
  const keys = unitMemberKeysOf(unit)
  const blocks: AbBlock[] = []
  for (const key of keys) {
    const chunk = bookIndex.chunks.find((c) => c.key === key)
    const text = (
      chunk?.faces.text?.content ??
      chunk?.content ??
      ''
    ).trim()
    if (!text) continue
    blocks.push({
      key,
      text,
      page: chunk?.page ?? unit.candidate.R.page,
      shortHandle: shortHandle(key),
    })
  }
  if (blocks.length === 0) {
    const excerpt = unit.candidate.excerpt.replace(/^【[^\n]*】\n?/, '').trim()
    if (excerpt) {
      blocks.push({
        key: unit.candidate.R.key,
        text: excerpt,
        page: unit.candidate.R.page,
        shortHandle: shortHandle(unit.candidate.R.key),
      })
    }
  }
  return blocks
}
