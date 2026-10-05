/**
 * 入口闸（两层，勿混）：
 * 0) 材料前置：书进窗冷启 brief（类 embedding），与问线无关
 * 1) 问线分叉：有历史 queryKey → 先试 reuse；否则新铸
 *
 * 顶层不再用「有没有 briefKey」决定走不走复用。
 */

import { useAttentionIo } from '../reasoning/attentionIoStore'
import { needsColdBookSkeleton } from './noPeekExperiment'
import {
  buildWindowAliasTable,
  resolveWindowDoorplate,
} from './windowAlias'

/** 问线分叉：复用前置 vs 新铸（结算两路的上游） */
export type AskLineBranch =
  | { kind: 'try_reuse' }
  | { kind: 'mint' }

/**
 * @deprecated 旧三态把冷启混进问线。请用 needsColdPeekPrecondition + resolveAskLineBranch。
 * 保留映射：peek≈需冷启；stageA≈try_reuse；brief_skip_A≈mint。
 */
export type AutoEntryBranch =
  | { kind: 'peek' }
  | { kind: 'stageA_then_brief' }
  | { kind: 'brief_skip_A' }

/** 材料层：实验 → 无 prospect 时注入骨架 bookKey（不再 peek LLM） */
export function needsColdPeekPrecondition(docId: string): boolean {
  return needsColdBookSkeleton(docId)
}

/**
 * 问线分叉：排除本轮 queryKey 后，是否仍有历史问线。
 * 有 → 先 stage A + reuse（候选须挂 norm，闸内再滤）；无 → 直接新铸。
 */
export function resolveAskLineBranch(nowQueryKey?: string): AskLineBranch {
  const historic = listHistoricQueryEntriesForNeighbour(nowQueryKey)
  if (historic.length > 0) return { kind: 'try_reuse' }
  return { kind: 'mint' }
}

/**
 * @deprecated 兼容旧调用；语义已拆。
 * 注意：勿在 ensureQueryKey 之后用「账上有无任意 qk」当历史——本轮刚铸的也算。
 */
export function resolveFirstStepBranch(docId: string): AutoEntryBranch {
  if (needsColdPeekPrecondition(docId)) {
    return { kind: 'peek' }
  }
  // 无 nowQK：用「是否存在任一 settled qk」近似历史（旧行为）
  const ask = resolveAskLineBranch(undefined)
  return ask.kind === 'try_reuse'
    ? { kind: 'stageA_then_brief' }
    : { kind: 'brief_skip_A' }
}

export function deskHasSettledQueryKeys(): boolean {
  return Object.keys(useAttentionIo.getState().settledQueries).length > 0
}

export function listSettledQueryEntries(): Array<{
  queryKey: string
  qText: string
  parentQueryKey?: string
}> {
  const st = useAttentionIo.getState()
  const settled = st.settledQueries
  const parentOf = st.queryParentOf
  return Object.entries(settled).map(([queryKey, qText]) => ({
    queryKey,
    qText,
    parentQueryKey: parentOf[queryKey],
  }))
}

/**
 * queryLLM 历史池：含各题族的根与深化子问，排除 Q_now 自身。
 * 深化子问会出现在池中，供 neighbour 与父/兄比较。
 */
export function listHistoricQueryEntriesForNeighbour(nowQueryKey?: string): Array<{
  queryKey: string
  qText: string
  parentQueryKey?: string
  familyRole: 'root' | 'deepen'
}> {
  const now = nowQueryKey?.trim() || ''
  return listSettledQueryEntries()
    .filter((e) => e.queryKey !== now)
    .map((e) => ({
      queryKey: e.queryKey,
      qText: e.qText,
      parentQueryKey: e.parentQueryKey,
      familyRole: e.parentQueryKey ? ('deepen' as const) : ('root' as const),
    }))
}

/**
 * LLM 回传的 historic 门牌 → 全长 queryKey。
 * 窗序 = listHistoricQueryEntriesForNeighbour（与阶段 A 组窗一致）。
 */
export function expandHistoricQueryKey(
  raw: string,
  nowQueryKey?: string,
): string | null {
  const t = raw.trim()
  if (!t) return null
  const st = useAttentionIo.getState()
  if (st.settledQueries[t] != null) return t
  const pool = listHistoricQueryEntriesForNeighbour(nowQueryKey).map(
    (e) => e.queryKey,
  )
  const table = buildWindowAliasTable(pool)
  const fromAlias = resolveWindowDoorplate(t, table)
  if (fromAlias) return fromAlias
  const n = Number(t)
  if (Number.isInteger(n) && n >= 1 && n <= pool.length) return pool[n - 1]!
  if (t.startsWith('qk_')) return t
  return null
}

/**
 * 历史问线上是否已有可喂 reuse 的 norm（经 path）。
 * 有历史但无 norm → 仍可走 try_reuse（跑 neighbour），闸会空返回再落入新铸。
 */
export function historicQueryKeysWithNorms(nowQueryKey?: string): string[] {
  const st = useAttentionIo.getState()
  const out: string[] = []
  for (const e of listHistoricQueryEntriesForNeighbour(nowQueryKey)) {
    const norms = st.listNormsForQueryKey(e.queryKey).filter((n) => n.text.trim())
    if (norms.length > 0) out.push(e.queryKey)
  }
  return out
}
