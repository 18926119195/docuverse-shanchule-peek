/**
 * 本轮 LLM 入窗带上 bookKey 时：并行物化对应页图并亮球（不等结算）。
 * 调度序可乱；门牌仍按书序 strand。
 */

import type { BookIndex } from './pipelineA'
import { runBatchesParallel } from '../arch/parallelLlmBatch'

const PREFETCH_CONCURRENCY = 4

/** bookKey → 去重 strand（按书序） */
export function strandsForBookKeys(
  bookKeys: string[],
  bookIndex: BookIndex,
): number[] {
  const want = new Set(bookKeys.map((k) => k.trim()).filter(Boolean))
  if (want.size === 0) return []
  const strands = new Set<number>()
  for (const c of bookIndex.chunks) {
    if (want.has(c.key)) strands.add(c.page)
  }
  return [...strands].sort((a, b) => a - b)
}

/**
 * 与 LLM 并行触发：不阻塞调用方（返回 Promise 供可选 await）。
 * 仅 letterWorkbench / 金库有图时才真正解码；已有 imageUrl 则只亮球。
 */
export function prefetchPagesForBookKeys(input: {
  bookKeys: string[]
  bookIndex: BookIndex
  onProgress?: (msg: string) => void
}): Promise<{ ok: boolean; note: string; strands: number[] }> {
  const strands = strandsForBookKeys(input.bookKeys, input.bookIndex)
  if (strands.length === 0) {
    return Promise.resolve({
      ok: true,
      note: '无 bookKey 页可预取',
      strands: [],
    })
  }

  return (async () => {
    const { useDocuverse } = await import('../canvas/store')
    const store = useDocuverse.getState()
    store.revealSphereForAudit()
    input.onProgress?.(
      `页图预取 · ${strands.length} 页并行（入窗 bookKey）…`,
    )

    const parallel = await runBatchesParallel({
      batches: strands,
      concurrency: PREFETCH_CONCURRENCY,
      run: async (strand) => {
        const r = await useDocuverse
          .getState()
          .ensurePageForAudit(strand, { focus: false })
        return r
      },
    })

    let okN = 0
    let failN = 0
    for (const r of parallel.results) {
      if (r.ok && r.value.ok) okN += 1
      else failN += 1
    }

    // 焦点落到书序第一页（有图优先）
    const focus =
      strands.find((s) =>
        useDocuverse.getState().pages.some((p) => p.strandIndex === s && p.imageUrl),
      ) ?? strands[0]!
    useDocuverse.setState({
      currentStrand: focus,
      sphereAuditOpen: true,
      settlementSphereEpoch:
        useDocuverse.getState().settlementSphereEpoch + 1,
    })

    const note = `页图预取 · 成功 ${okN} · 失败 ${failN} · 焦点 s${focus}`
    input.onProgress?.(note)
    return { ok: failN === 0, note, strands }
  })()
}

/** peek / infer 等吃 book 原文的工种 */
export function jobTakesBookKeysAsInput(job: string): boolean {
  return job === 'peek' || job === 'infer' || job === 'supervise'
}
