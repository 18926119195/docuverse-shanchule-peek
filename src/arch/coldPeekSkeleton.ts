/**
 * 冷启材料骨架（书进窗前置，类 embedding）：
 * 按小节/书序取每段头尾各 ~15% 的 bookKey；中间 ~70% 留给热启 seedRange。
 * 有 TOC memberKeys 时按分节；否则整书书序两端。
 */

import type { BookIndex } from '../reasoning/pipelineA'
import type { BookSemanticIndex } from '../reasoning/semanticIndex'
import { orderedRetrievableBookKeys } from './seedRange'

const HEAD_TAIL_RATIO = 0.15
/** 单节过短时至少取两端各 1 个（若有） */
const MIN_EDGE = 1

function edgeSlice(keys: string[]): string[] {
  if (keys.length === 0) return []
  if (keys.length <= 3) return [...keys]
  const n = Math.max(MIN_EDGE, Math.ceil(keys.length * HEAD_TAIL_RATIO))
  const head = keys.slice(0, n)
  const tail = keys.slice(-n)
  return [...new Set([...head, ...tail])]
}

/**
 * 冷启应点名的 bookKey 子集（头尾骨架）。
 * 空数组 = 调用方回退整表冷启。
 */
export function selectColdPeekSkeletonKeys(input: {
  bookIndex: BookIndex
  semantic?: BookSemanticIndex | null
}): string[] {
  const ordered = orderedRetrievableBookKeys(input.bookIndex)
  if (ordered.length === 0) return []

  const sections = (input.semantic?.sections ?? []).filter(
    (s) => (s.memberKeys?.length ?? 0) > 0,
  )
  if (sections.length > 0) {
    const orderIndex = new Map(ordered.map((k, i) => [k, i]))
    const picked: string[] = []
    const seen = new Set<string>()
    for (const sec of sections) {
      const members = [...(sec.memberKeys ?? [])]
        .filter((k) => orderIndex.has(k))
        .sort((a, b) => (orderIndex.get(a)! - orderIndex.get(b)!))
      for (const k of edgeSlice(members)) {
        if (seen.has(k)) continue
        seen.add(k)
        picked.push(k)
      }
    }
    if (picked.length > 0) return picked
  }

  return edgeSlice(ordered)
}
