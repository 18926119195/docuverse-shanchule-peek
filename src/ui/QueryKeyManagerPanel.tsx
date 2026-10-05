/**
 * queryKey 管理：列出当前全部 qk；点开显示该问引出的增量 key 结构图。
 */

import { useMemo, useState } from 'react'
import { useAttentionIo } from '../reasoning/attentionIoStore'
import {
  buildQueryIncrementTree,
  groupIncrementNodes,
  listSettledQueryKeysNewestFirst,
  type QueryIncrementKind,
} from '../reasoning/queryIncrementTree'
import { usePanelSummonStore } from '../reasoning/panelSummonStore'
import { focusSettlementAuditBook } from '../canvas/settleFrame'
import { useIndexGate } from '../reasoning/indexGate'

function short(k: string, n = 12): string {
  const t = k.trim()
  if (t.length <= n) return t
  return `${t.slice(0, 4)}…${t.slice(-4)}`
}

const KIND_ORDER: QueryIncrementKind[] = [
  'solution',
  'path',
  'infer',
  'prospect',
  'brief',
  'norm',
  'neighbour',
  'reuse',
  'book',
]

const KIND_LABEL: Record<QueryIncrementKind, string> = {
  brief: 'briefKey',
  prospect: 'prospectKey',
  infer: 'inferKey',
  solution: 'solutionKey',
  path: 'pathKey',
  norm: 'normKey',
  neighbour: 'neighbourKey',
  reuse: 'reuseKey',
  book: 'bookKey',
}

export function QueryKeyManagerPanel({
  compact = false,
  defaultQueryKey,
  onPickBookKey,
}: {
  compact?: boolean
  /** 结算态默认钉到 pending 的 qk */
  defaultQueryKey?: string | null
  onPickBookKey?: (bookKey: string) => void
}) {
  const settled = useAttentionIo((s) => s.settledQueries)
  const parentOf = useAttentionIo((s) => s.queryParentOf)
  const inferEdges = useAttentionIo((s) => s.inferEdges)
  const paths = useAttentionIo((s) => s.paths)
  const prospects = useAttentionIo((s) => s.prospects)
  const norms = useAttentionIo((s) => s.norms)
  const neighbours = useAttentionIo((s) => s.neighbours)
  const reuseLinks = useAttentionIo((s) => s.queryReuseLinks)
  const briefMap = useAttentionIo((s) => s.queryKeyToBriefKeys)
  const bookIndex = useIndexGate((s) => s.bookIndex)
  const rows = useMemo(() => {
    void settled
    void parentOf
    return listSettledQueryKeysNewestFirst()
  }, [settled, parentOf])

  const [focusQk, setFocusQk] = useState<string | null>(
    defaultQueryKey ?? null,
  )
  const activeQk =
    focusQk && settled[focusQk]
      ? focusQk
      : defaultQueryKey && settled[defaultQueryKey]
        ? defaultQueryKey
        : rows[0]?.queryKey ?? null

  const tree = useMemo(
    () => (activeQk ? buildQueryIncrementTree(activeQk) : null),
    [
      activeQk,
      settled,
      parentOf,
      briefMap,
      inferEdges,
      paths,
      prospects,
      norms,
      neighbours,
      reuseLinks,
    ],
  )

  const grouped = useMemo(
    () => (tree ? groupIncrementNodes(tree.nodes) : null),
    [tree],
  )

  const onSummonKeys = (keys: string[]) => {
    if (!keys.length) return
    usePanelSummonStore.getState().summonKeys(keys)
  }

  const onBook = async (bk: string) => {
    if (onPickBookKey) {
      onPickBookKey(bk)
      return
    }
    if (!bookIndex) return
    await focusSettlementAuditBook({ bookKey: bk, bookIndex })
  }

  return (
    <div
      className={
        compact
          ? 'qk-manager qk-manager--compact'
          : 'qk-manager'
      }
      aria-label="queryKey 管理"
    >
      <header className="qk-manager-head">
        <span className="qk-manager-title">queryKey 管理</span>
        <span className="qk-manager-meta">qk×{rows.length}</span>
      </header>

      {rows.length === 0 ? (
        <p className="qk-manager-empty">尚无 queryKey · 提问后落账</p>
      ) : (
        <ul className="qk-manager-list">
          {rows.map((r) => (
            <li key={r.queryKey}>
              <button
                type="button"
                className={
                  activeQk === r.queryKey
                    ? 'qk-manager-qk active'
                    : 'qk-manager-qk'
                }
                title={r.queryKey}
                onClick={() => setFocusQk(r.queryKey)}
              >
                <code>{short(r.queryKey, 16)}</code>
                <span className="qk-manager-q">
                  {r.question.slice(0, 48)}
                  {r.question.length > 48 ? '…' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {tree && grouped ? (
        <div className="qk-manager-tree">
          <div className="qk-manager-tree-head">
            <span>结构图 · </span>
            <code title={tree.queryKey}>{short(tree.queryKey, 18)}</code>
            {tree.parentQueryKey ? (
              <span className="qk-manager-edge">
                ← parent{' '}
                <button
                  type="button"
                  className="qk-manager-link"
                  onClick={() => setFocusQk(tree.parentQueryKey)}
                >
                  {short(tree.parentQueryKey, 12)}
                </button>
              </span>
            ) : (
              <span className="qk-manager-edge">· 根问</span>
            )}
          </div>

          {(tree.childQueryKeys.length > 0 ||
            tree.ancestorQueryKeys.length > 0) && (
            <div className="qk-manager-lineage">
              {tree.ancestorQueryKeys.length > 0 ? (
                <span>
                  祖先{' '}
                  {tree.ancestorQueryKeys.map((a) => (
                    <button
                      key={a}
                      type="button"
                      className="qk-manager-chip"
                      onClick={() => setFocusQk(a)}
                    >
                      {short(a, 10)}
                    </button>
                  ))}
                </span>
              ) : null}
              {tree.childQueryKeys.length > 0 ? (
                <span>
                  子问{' '}
                  {tree.childQueryKeys.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="qk-manager-chip"
                      onClick={() => setFocusQk(c)}
                    >
                      {short(c, 10)}
                    </button>
                  ))}
                </span>
              ) : null}
            </div>
          )}

          <div className="qk-manager-flow" aria-label="增量结构">
            <div className="qk-manager-root">
              qk → 增量
              <button
                type="button"
                className="qk-manager-chip"
                onClick={() =>
                  onSummonKeys(
                    tree.nodes
                      .filter((n) => n.kind !== 'book')
                      .map((n) => n.key)
                      .slice(0, 24),
                  )
                }
              >
                调取本问微球
              </button>
            </div>
            {KIND_ORDER.map((kind) => {
              const list = grouped[kind]
              if (!list.length) return null
              return (
                <div key={kind} className="qk-manager-branch">
                  <div className="qk-manager-branch-label">
                    {KIND_LABEL[kind]} ×{list.length}
                  </div>
                  <ul className="qk-manager-branch-keys">
                    {list.map((n) => (
                      <li key={`${kind}:${n.key}`}>
                        <button
                          type="button"
                          className={`qk-manager-chip kind-${kind}`}
                          title={
                            n.meta
                              ? `${n.key}\n${n.meta}`
                              : n.key
                          }
                          onClick={() => {
                            if (kind === 'book') void onBook(n.key)
                            else onSummonKeys([n.key])
                          }}
                        >
                          {short(n.key, 14)}
                          {n.label && n.label !== KIND_LABEL[kind]
                            ? ` · ${n.label.slice(0, 16)}`
                            : ''}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}
