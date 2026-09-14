/**
 * 由 queryKey 展开的增量 key 结构（只读台账，不调 LLM）。
 */

import { useAttentionIo } from './attentionIoStore'
import { listQueryChildren, listQueryAncestors } from '../arch/queryLineage'

export type QueryIncrementKind =
  | 'brief'
  | 'prospect'
  | 'infer'
  | 'solution'
  | 'path'
  | 'norm'
  | 'neighbour'
  | 'reuse'
  | 'book'

export type QueryIncrementNode = {
  kind: QueryIncrementKind
  key: string
  label: string
  parentKey?: string
  meta?: string
}

export type QueryIncrementTree = {
  queryKey: string
  question: string
  parentQueryKey: string | null
  childQueryKeys: string[]
  ancestorQueryKeys: string[]
  nodes: QueryIncrementNode[]
  /** bookKey 去重并集（infer + prospect） */
  bookKeys: string[]
}

export function listSettledQueryKeysNewestFirst(): Array<{
  queryKey: string
  question: string
}> {
  const settled = useAttentionIo.getState().settledQueries
  return Object.entries(settled)
    .map(([queryKey, question]) => ({ queryKey, question }))
    .reverse()
}

/** 点开某 queryKey → 它如何引出后续增量 key */
export function buildQueryIncrementTree(queryKey: string): QueryIncrementTree {
  const st = useAttentionIo.getState()
  const qk = queryKey.trim()
  const parentOf = st.queryParentOf
  const question = st.settledQueries[qk] ?? ''
  const parentQueryKey = parentOf[qk] ?? null
  const childQueryKeys = listQueryChildren(parentOf, qk)
  const ancestorQueryKeys = listQueryAncestors(parentOf, qk)

  const nodes: QueryIncrementNode[] = []
  const bookSet = new Set<string>()

  for (const bk of st.queryKeyToBriefKeys[qk] ?? []) {
    nodes.push({
      kind: 'brief',
      key: bk,
      label: 'brief',
      parentKey: qk,
    })
  }

  for (const pr of st.prospects.filter((p) => p.queryKey === qk)) {
    const book = pr.briefKey
    nodes.push({
      kind: 'prospect',
      key: pr.prospectKey,
      label: 'prospect',
      parentKey: book || qk,
      meta: book,
    })
    if (book) bookSet.add(book)
  }

  const solutionSeen = new Set<string>()
  for (const edge of st.inferEdges.filter((e) => e.queryKey === qk)) {
    nodes.push({
      kind: 'infer',
      key: edge.inferKey,
      label: edge.role || 'infer',
      parentKey: edge.solutionKey || qk,
      meta: edge.bookKeys.join(' · '),
    })
    for (const bk of edge.bookKeys) bookSet.add(bk)
    if (edge.solutionKey && !solutionSeen.has(edge.solutionKey)) {
      solutionSeen.add(edge.solutionKey)
      nodes.push({
        kind: 'solution',
        key: edge.solutionKey,
        label: 'solution',
        parentKey: qk,
        meta: edge.conclusion?.slice(0, 80),
      })
    }
  }

  for (const path of st.paths.filter((p) => p.queryKey === qk)) {
    nodes.push({
      kind: 'path',
      key: path.pathKey,
      label: 'path',
      parentKey: path.solutionKey || qk,
      meta: path.conclusion?.slice(0, 80),
    })
    for (const bk of path.bookKeysSequence ?? []) bookSet.add(bk)
  }

  for (const n of st.norms.filter((x) => x.queryKey === qk)) {
    nodes.push({
      kind: 'norm',
      key: n.normKey,
      label: 'norm',
      parentKey: n.pathKey || qk,
    })
  }

  for (const nb of st.neighbours.filter(
    (x) => x.nowQueryKey === qk || x.historicQueryKey === qk,
  )) {
    nodes.push({
      kind: 'neighbour',
      key: nb.neighbourKey,
      label: nb.nowQueryKey === qk ? '→hist' : '←now',
      parentKey: qk,
      meta:
        nb.nowQueryKey === qk ? nb.historicQueryKey : nb.nowQueryKey,
    })
  }

  for (const ru of st.queryReuseLinks.filter((x) => x.fromQueryKey === qk)) {
    nodes.push({
      kind: 'reuse',
      key: ru.reuseKey,
      label: 'reuse',
      parentKey: qk,
      meta: ru.normKey || ru.pathKey,
    })
  }

  const bookKeys = [...bookSet]
  for (const bk of bookKeys) {
    nodes.push({
      kind: 'book',
      key: bk,
      label: 'book',
      parentKey: qk,
    })
  }

  return {
    queryKey: qk,
    question,
    parentQueryKey,
    childQueryKeys,
    ancestorQueryKeys,
    nodes,
    bookKeys,
  }
}

export function groupIncrementNodes(nodes: QueryIncrementNode[]): Record<
  QueryIncrementKind,
  QueryIncrementNode[]
> {
  const empty = (): QueryIncrementNode[] => []
  const out: Record<QueryIncrementKind, QueryIncrementNode[]> = {
    brief: empty(),
    prospect: empty(),
    infer: empty(),
    solution: empty(),
    path: empty(),
    norm: empty(),
    neighbour: empty(),
    reuse: empty(),
    book: empty(),
  }
  for (const n of nodes) out[n.kind].push(n)
  return out
}
