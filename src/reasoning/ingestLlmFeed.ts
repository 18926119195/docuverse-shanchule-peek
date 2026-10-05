/**
 * 后台 OCR 入账 → LLM 增量补给（热启 peek）。
 *
 * 与现有递送闸对齐（不得冲突）：
 * - 冷启：needsColdPeekPrecondition 一次闸；入账不重跑冷启
 * - decide：sufficient → 可铸/可往下；unread → 续滚优先；insufficient → 才热启
 * - letterDesk preferByStatus：insufficient 默认不塞进 decide 窗
 * - 本模块只把「新 bookKey」补给 **热启 peek**，不绕过三态直接塞 decide/infer
 *
 * 「够了」= 本问 decide 无 insufficient（listKeysNeedingMore 空）→ 清空饥饿，不再递新页
 */

import type { BookIndex } from './pipelineA'
import { useAttentionIo } from './attentionIoStore'
import {
  expandClosedSeedRangesToBookKeys,
  type SeedRange,
} from '../arch/seedRange'

export function hungerStillOpen(queryKey: string): boolean {
  const qk = queryKey.trim()
  if (!qk) return false
  return (
    useAttentionIo.getState().listKeysNeedingMore('decide', { queryKey: qk })
      .length > 0
  )
}

/** 自动流：热启展开为空 / 区间落在未 OCR 页时，挂起闭集等后台 */
export function stashHungerForIngest(input: {
  queryKey: string
  closed: SeedRange[]
  reason: string
}): void {
  const qk = input.queryKey.trim()
  if (!qk || input.closed.length === 0) return
  useAttentionIo.getState().setPendingHunger({
    queryKey: qk,
    closed: input.closed,
  })
  useAttentionIo
    .getState()
    .setDeskPrompt(
      `写信台 · ${input.reason} · 已挂起 seedRange 闭集×${input.closed.length}；后台页入账且本问仍 insufficient 时再补给热启`,
    )
}

/** syncPages 后：新 bookKey ∩ 饥饿闭集未开 → 记入待热启饲料 */
export function noteBookIndexAugmented(input: {
  docId: string
  bookIndex: BookIndex
  newBookKeys: string[]
}): { offered: string[]; note: string } {
  const newKeys = [...new Set(input.newBookKeys.map((k) => k.trim()).filter(Boolean))]
  if (newKeys.length === 0) {
    return { offered: [], note: '无新 bookKey' }
  }

  const io = useAttentionIo.getState()
  const hung = io.pendingHunger
  const qk = hung?.queryKey?.trim() || io.selectedQueryKey?.trim() || ''
  if (!qk) {
    return { offered: [], note: '无本问 queryKey · 不递饲料' }
  }
  if (!hungerStillOpen(qk)) {
    io.clearPendingHunger()
    io.clearPendingIngestFeed()
    return { offered: [], note: `qk=${qk} 已无 insufficient · 清饥饿` }
  }

  const closed = hung?.closed ?? []
  if (closed.length === 0) {
    return { offered: [], note: '无挂起闭集 · 新页入账但不自动扩（等 decide 写 seedRange）' }
  }

  const expanded = expandClosedSeedRangesToBookKeys({
    docId: input.docId,
    bookIndex: input.bookIndex,
    closed,
  })
  const unopened = new Set(expanded.unopened)
  const offered = newKeys.filter((k) => unopened.has(k))
  if (offered.length === 0) {
    return {
      offered: [],
      note: `新页×${newKeys.length} 未落入饥饿闭集未开（${expanded.note}）`,
    }
  }

  io.offerPendingIngestFeed(offered)
  io.setDeskPrompt(
    `写信台 · 后台新门×${offered.length} 已可补贴热启（本问仍 insufficient · 下次热启/自动流会吃）`,
  )
  return { offered, note: `饲料+${offered.length} · ${expanded.note}` }
}

/** 热启候选：饲料优先，但必须落在本次 expand 窗内；窗外饲料放回队列 */
export function mergeHotPeekCandidates(input: {
  expandedUnopened: string[]
  expandedAll: string[]
}): string[] {
  const feed = useAttentionIo.getState().takePendingIngestFeed()
  const allow = new Set(
    input.expandedAll.length > 0 ? input.expandedAll : input.expandedUnopened,
  )
  const useFeed: string[] = []
  const leftover: string[] = []
  for (const k of feed) {
    const t = k.trim()
    if (!t) continue
    if (allow.size === 0 || allow.has(t)) useFeed.push(t)
    else leftover.push(t)
  }
  if (leftover.length > 0) {
    useAttentionIo.getState().offerPendingIngestFeed(leftover)
  }
  const primary =
    input.expandedUnopened.length > 0
      ? input.expandedUnopened
      : input.expandedAll
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of [...useFeed, ...primary]) {
    const t = k.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}
