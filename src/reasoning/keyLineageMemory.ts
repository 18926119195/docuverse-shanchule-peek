/**
 * 长期记忆：key 身份 + 母系血缘（谁挂谁），非写信台调度过程。
 * 供语料包跨网页恢复 → 复用闸 / decide / infer 续跑。
 */

import {
  useAttentionIo,
  type InferEdge,
  type NeighbourRecord,
  type NormRecord,
  type PathRecord,
  type ProspectRecord,
  type QueryReuseLink,
} from './attentionIoStore'
import type { DeskDeliveryLink } from './deskDelivery'
import type { KeyIncrementStatusRow } from '../arch/keyIncrementStatus'
import {
  getKeyDecisionStore,
  saveKeyDecisionStore,
  type KeyDecisionStore,
} from './keyDecisionState'

export const KEY_LINEAGE_KIND = 'docuverse-key-lineage' as const
export const KEY_LINEAGE_VERSION = 1 as const

/** 可水合回 attentionIo + 门账；不含 steps/pending/deskPackages 等过程态 */
export type KeyLineageSnapshot = {
  kind: typeof KEY_LINEAGE_KIND
  version: typeof KEY_LINEAGE_VERSION
  docId: string
  exportedAt: number
  /** queryKey → 问原文 */
  settledQueries: Record<string, string>
  /** 深化：子 query → 父 query */
  queryParentOf: Record<string, string>
  /** 问线挂过的 brief */
  queryKeyToBriefKeys: Record<string, string[]>
  prospects: ProspectRecord[]
  paths: PathRecord[]
  norms: NormRecord[]
  inferEdges: InferEdge[]
  neighbours: NeighbourRecord[]
  queryReuseLinks: QueryReuseLink[]
  /** 可选：工种落账边（fromKeys→toKey），便于复原谱系边 */
  deskDeliveries: DeskDeliveryLink[]
  /** 三态（按问线续滚）；挂 queryKey 的行优先保留 */
  keyIncrementStatuses: KeyIncrementStatusRow[]
  /** 下一 settle 序号，避免水合后碰撞 */
  nextSettleSeq: number
  /** bookKey 门上 brief 母系（含 history 版本） */
  keyDecision: KeyDecisionStore
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** 从当前内存台账抽出长期记忆 */
export function snapshotKeyLineage(docId: string): KeyLineageSnapshot {
  const io = useAttentionIo.getState()
  const door = getKeyDecisionStore(docId)
  return {
    kind: KEY_LINEAGE_KIND,
    version: KEY_LINEAGE_VERSION,
    docId,
    exportedAt: Date.now(),
    settledQueries: { ...io.settledQueries },
    queryParentOf: { ...io.queryParentOf },
    queryKeyToBriefKeys: { ...io.queryKeyToBriefKeys },
    prospects: [...io.prospects],
    paths: [...io.paths],
    norms: [...io.norms],
    inferEdges: [...io.inferEdges],
    neighbours: [...io.neighbours],
    queryReuseLinks: [...io.queryReuseLinks],
    deskDeliveries: [...io.deskDeliveries],
    keyIncrementStatuses: [...io.keyIncrementStatuses],
    nextSettleSeq: Math.max(1, io.nextSettleSeq || 1),
    keyDecision: {
      docId: door.docId,
      byKey: { ...door.byKey },
      updatedAt: door.updatedAt,
    },
  }
}

export function parseKeyLineageSnapshot(raw: unknown): {
  ok: true
  snap: KeyLineageSnapshot
} | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'lineage 不是对象' }
  if (raw.kind !== KEY_LINEAGE_KIND) {
    return { ok: false, error: '不是 key-lineage 快照' }
  }
  if (raw.version !== KEY_LINEAGE_VERSION) {
    return { ok: false, error: `不支持 lineage 版本 ${String(raw.version)}` }
  }
  if (typeof raw.docId !== 'string' || !raw.docId.trim()) {
    return { ok: false, error: 'lineage 缺 docId' }
  }
  return { ok: true, snap: raw as unknown as KeyLineageSnapshot }
}

/**
 * 水合进 attentionIo + KeyDecision（覆盖同 doc 门账；台账合并按 key 去重追加）。
 */
export function hydrateKeyLineage(snap: KeyLineageSnapshot): {
  ok: boolean
  note: string
} {
  const parsed = parseKeyLineageSnapshot(snap)
  if (!parsed.ok) return { ok: false, note: parsed.error }

  const s = parsed.snap
  saveKeyDecisionStore({
    docId: s.docId,
    byKey: s.keyDecision?.byKey ?? {},
    updatedAt: Date.now(),
  })

  useAttentionIo.getState().hydrateKeyLineageMemory({
    settledQueries: s.settledQueries ?? {},
    queryParentOf: s.queryParentOf ?? {},
    queryKeyToBriefKeys: s.queryKeyToBriefKeys ?? {},
    prospects: s.prospects ?? [],
    paths: s.paths ?? [],
    norms: s.norms ?? [],
    inferEdges: s.inferEdges ?? [],
    neighbours: s.neighbours ?? [],
    queryReuseLinks: s.queryReuseLinks ?? [],
    deskDeliveries: s.deskDeliveries ?? [],
    keyIncrementStatuses: s.keyIncrementStatuses ?? [],
    nextSettleSeq: s.nextSettleSeq,
  })

  const nQ = Object.keys(s.settledQueries ?? {}).length
  const nBrief = Object.keys(s.keyDecision?.byKey ?? {}).length
  const nPath = (s.paths ?? []).length
  return {
    ok: true,
    note: `长期记忆已水合 · qk×${nQ} · 门brief×${nBrief} · path×${nPath} · prospect×${(s.prospects ?? []).length} · infer×${(s.inferEdges ?? []).length}`,
  }
}

/** 空记忆（仅材料、尚无问线） */
export function emptyKeyLineage(docId: string): KeyLineageSnapshot {
  return {
    kind: KEY_LINEAGE_KIND,
    version: KEY_LINEAGE_VERSION,
    docId,
    exportedAt: Date.now(),
    settledQueries: {},
    queryParentOf: {},
    queryKeyToBriefKeys: {},
    prospects: [],
    paths: [],
    norms: [],
    inferEdges: [],
    neighbours: [],
    queryReuseLinks: [],
    deskDeliveries: [],
    keyIncrementStatuses: [],
    nextSettleSeq: 1,
    keyDecision: {
      docId,
      byKey: {},
      updatedAt: Date.now(),
    },
  }
}
