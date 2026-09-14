/**
 * 本问进度图：按 LLM 调用序拼工种节点 + out 整批边（咬尾蛇 / 撬开）。
 * 只读台账，不调 LLM。
 */

import type { AttentionKeyKind } from '../arch/attentionPanel'
import { useAttentionIo } from './attentionIoStore'
import type { LlmCallLedgerEntry } from './llmCallLedger'

export type TurnJobNode =
  | {
      id: string
      kind: 'queryKey'
      queryKey: string
      role: 'now' | 'historic'
      status: 'done' | 'pending'
    }
  | {
      id: string
      kind: 'job'
      job: string
      status: 'done' | 'pending' | 'historic'
    }

export type TurnJobEdge = {
  id: string
  llmCallId: string
  job: string
  keyKind: AttentionKeyKind
  memberKeys: string[]
  /** 本问调用序 */
  turnSeq: number
  label: string
}

export type TurnJobGraph = {
  queryKeyNow: string
  nodes: TurnJobNode[]
  edges: TurnJobEdge[]
  /** 按 turnSeq 排序的调用批 */
  calls: LlmCallLedgerEntry[]
}

/** 当前活跃本问：最近一条 settled query，或显式传入 */
export function resolveActiveQueryKey(explicit?: string): string {
  const qk = explicit?.trim()
  if (qk) return qk
  const settled = useAttentionIo.getState().settledQueries
  const keys = Object.keys(settled)
  return keys[keys.length - 1] ?? ''
}

export function buildTurnJobGraph(queryKey?: string): TurnJobGraph {
  const st = useAttentionIo.getState()
  const qkNow = resolveActiveQueryKey(queryKey)
  const nodes: TurnJobNode[] = []
  const edges: TurnJobEdge[] = []

  if (!qkNow) {
    return { queryKeyNow: '', nodes, edges, calls: [] }
  }

  nodes.push({
    id: `qk:${qkNow}`,
    kind: 'queryKey',
    queryKey: qkNow,
    role: 'now',
    status: 'done',
  })

  const histFromNb = [
    ...new Set(
      st.neighbours
        .filter((n) => n.nowQueryKey === qkNow)
        .map((n) => n.historicQueryKey),
    ),
  ]
  for (const hq of histFromNb) {
    nodes.push({
      id: `qk:${hq}`,
      kind: 'queryKey',
      queryKey: hq,
      role: 'historic',
      status: 'done',
    })
  }

  const calls = st.llmCallLedger
    .filter((c) => c.queryKey === qkNow || histFromNb.includes(c.queryKey))
    .slice()
    .sort((a, b) => a.turnSeq - b.turnSeq || a.createdAt - b.createdAt)

  // 本问调用（含挂在 now 上的 neighbour/reuse；史问材料调用标 historic）
  const jobsSeen = new Set<string>()
  for (const c of calls) {
    const onNow = c.queryKey === qkNow
    const jobId = `job:${c.job}:${onNow ? 'now' : c.queryKey}`
    if (!jobsSeen.has(jobId)) {
      jobsSeen.add(jobId)
      nodes.push({
        id: jobId,
        kind: 'job',
        job: c.job,
        status: onNow ? 'done' : 'historic',
      })
    }
    edges.push({
      id: `edge:${c.llmCallId}`,
      llmCallId: c.llmCallId,
      job: c.job,
      keyKind: c.keyKind,
      memberKeys: c.memberKeys,
      turnSeq: c.turnSeq,
      label: `${c.job}·${c.keyKind}×${c.memberKeys.length}`,
    })
  }

  // 史问已有 path 但本问未写入 ledger 时：仍标 path 工种 historic（咬尾尾）
  for (const hq of histFromNb) {
    const paths = st.listPathsForQueryKey(hq)
    if (paths.length === 0) continue
    const jobId = `job:path:${hq}`
    if (!jobsSeen.has(jobId)) {
      jobsSeen.add(jobId)
      nodes.push({
        id: jobId,
        kind: 'job',
        job: 'path',
        status: 'historic',
      })
    }
  }

  return { queryKeyNow: qkNow, nodes, edges, calls }
}

/** 点某 instance key → 相邻 deskDelivery 细边涉及的 llmCall 批（若可解析） */
export function adjacentCallIdsForKey(key: string): {
  inbound: string[]
  outbound: string[]
} {
  const st = useAttentionIo.getState()
  const k = key.trim()
  const inbound: string[] = []
  const outbound: string[] = []
  for (const d of st.deskDeliveries) {
    if (d.toKey === k) {
      const hit = st.llmCallLedger.find((c) => c.memberKeys.includes(k))
      if (hit) inbound.push(hit.llmCallId)
      for (const fk of d.fromKeys) {
        const src = st.llmCallLedger.find((c) => c.memberKeys.includes(fk))
        if (src) inbound.push(src.llmCallId)
      }
    }
    if (d.fromKeys.includes(k)) {
      const hit = st.llmCallLedger.find((c) => c.memberKeys.includes(d.toKey))
      if (hit) outbound.push(hit.llmCallId)
      const self = st.llmCallLedger.find((c) => c.memberKeys.includes(k))
      if (self) outbound.push(self.llmCallId)
    }
  }
  return {
    inbound: [...new Set(inbound)],
    outbound: [...new Set(outbound)],
  }
}

export function memberKeysForLlmCall(llmCallId: string): string[] {
  const hit = useAttentionIo
    .getState()
    .llmCallLedger.find((c) => c.llmCallId === llmCallId)
  return hit?.memberKeys ?? []
}
