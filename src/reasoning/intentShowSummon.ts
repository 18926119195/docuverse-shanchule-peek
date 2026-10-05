/**
 * 意图 Step4：show = 从本问 llmCall 台账猜要调哪几批集合面板，并立刻 summon。
 * 不调度写信台工种；不补增量。
 */

import { useAttentionIo } from './attentionIoStore'
import { usePanelSummonStore } from './panelSummonStore'
import {
  buildTurnJobGraph,
  resolveActiveQueryKey,
} from './turnJobProgress'
import type { LlmCallLedgerEntry } from './llmCallLedger'

export type ShowSummonPlan = {
  llmCallIds: string[]
  note: string
  source: 'llm' | 'jobs' | 'fallback_latest' | 'empty'
}

/** 进度边目录（喂给意图 LLM） */
export function formatCallCatalogForIntent(queryKey?: string): string {
  const graph = buildTurnJobGraph(resolveActiveQueryKey(queryKey))
  if (graph.edges.length === 0) {
    return '（本问尚无 LLM 调用批 / 进度边）'
  }
  return graph.edges
    .map(
      (e, i) =>
        `${i + 1}. id=${e.llmCallId} job=${e.job} kind=${e.keyKind} n=${e.memberKeys.length} seq=${e.turnSeq}`,
    )
    .join('\n')
}

function resolveCallsByJobs(
  jobs: string[],
  queryKey?: string,
): LlmCallLedgerEntry[] {
  const graph = buildTurnJobGraph(resolveActiveQueryKey(queryKey))
  const want = new Set(jobs.map((j) => j.trim().toLowerCase()).filter(Boolean))
  if (want.size === 0) return []
  // 每种 job 取本问最新一条
  const byJob = new Map<string, LlmCallLedgerEntry>()
  for (const c of graph.calls) {
    if (!want.has(c.job.toLowerCase())) continue
    const prev = byJob.get(c.job)
    if (!prev || c.turnSeq >= prev.turnSeq) byJob.set(c.job, c)
  }
  return [...byJob.values()]
}

/** 把 LLM / 启发式解析结果收成可召唤的 llmCallIds */
export function planShowSummon(input: {
  llmCallIds?: string[]
  jobs?: string[]
  note?: string
  queryKey?: string
}): ShowSummonPlan {
  const ledger = useAttentionIo.getState().llmCallLedger
  const known = new Set(ledger.map((c) => c.llmCallId))
  const fromIds = (input.llmCallIds ?? [])
    .map((id) => id.trim())
    .filter((id) => id && known.has(id))

  if (fromIds.length > 0) {
    return {
      llmCallIds: [...new Set(fromIds)],
      note: input.note || `调取 ${fromIds.length} 批`,
      source: 'llm',
    }
  }

  const byJobs = resolveCallsByJobs(input.jobs ?? [], input.queryKey)
  if (byJobs.length > 0) {
    return {
      llmCallIds: byJobs.map((c) => c.llmCallId),
      note: input.note || `按工种调取 ${byJobs.map((c) => c.job).join('+')}`,
      source: 'jobs',
    }
  }

  // 兜底：本问最新 2 批（够对比）；不足则全取
  const graph = buildTurnJobGraph(resolveActiveQueryKey(input.queryKey))
  const latest = graph.calls.slice(-2)
  if (latest.length > 0) {
    return {
      llmCallIds: latest.map((c) => c.llmCallId),
      note: input.note || `兜底调取最新 ${latest.length} 批`,
      source: 'fallback_latest',
    }
  }

  return {
    llmCallIds: [],
    note: input.note || '本问尚无进度边可调取',
    source: 'empty',
  }
}

/** 执行调取：亮集合面板；≥2 批时自动进软对比 */
export function executeShowSummon(plan: ShowSummonPlan): {
  ok: boolean
  note: string
} {
  if (plan.llmCallIds.length === 0) {
    useAttentionIo
      .getState()
      .setDeskPrompt(
        '写信台 · 调取失败：本问尚无 LLM 调用批。请先提问跑自动流，或点右上角进度边。',
      )
    return { ok: false, note: plan.note }
  }
  const store = usePanelSummonStore.getState()
  for (const id of plan.llmCallIds) store.summonCallBatch(id)
  store.clearEdgeSelect()
  for (const id of plan.llmCallIds) store.toggleEdgeSelect(id)

  let compareNote = ''
  if (plan.llmCallIds.length >= 2) {
    compareNote = ' · 可点壳拉链「对比」'
  }

  const note = `已调取集合面板 ×${plan.llmCallIds.length}（${plan.source}）${compareNote}`
  useAttentionIo.getState().setDeskPrompt(`写信台 · ${note}`)
  return { ok: true, note }
}
