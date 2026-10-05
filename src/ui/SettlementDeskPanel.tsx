/**
 * 结算面（三栏中段）：
 * - 解法 path（conclusion）为主票；点 path → 展开 steps
 * - bookKey 只挂在各 step 内可点，按步审计并同步 PDF
 * - prospect 载荷按当前步的门过滤（便于逐步对照）
 * - 确认 / 撤销
 */

import { useEffect, useMemo, useState } from 'react'
import { useAttentionIo } from '../reasoning/attentionIoStore'
import { useIndexGate } from '../reasoning/indexGate'
import type { BookIndex } from '../reasoning/pipelineA'
import { useDocuverse } from '../canvas/store'
import {
  enterSettlementSingleAnchor,
  exitSettlementFrame,
  focusSettlementAuditBook,
  settlementSelectBookKey,
} from '../canvas/settleFrame'
import { formatDirectedPathIncrementReturn } from '../arch/pathIncrementReturn'
import { runAutoFlow } from '../reasoning/autoFlow'
import { newLlmCallId } from '../reasoning/settleMint'

function short(k: string, n = 10): string {
  const t = k.trim()
  if (t.length <= n) return t
  return `${t.slice(0, 4)}…${t.slice(-4)}`
}

function BookKeyChips({
  bookKeys,
  activeBook,
  bookIndex,
  onPick,
}: {
  bookKeys: string[]
  activeBook: string | null
  bookIndex: BookIndex | null
  onPick: (bk: string) => void
}) {
  if (bookKeys.length === 0) {
    return <p className="settlement-hint">本解法尚无 bookKey</p>
  }
  return (
    <ul className="settlement-book-chips">
      {bookKeys.map((bk) => {
        const page = bookIndex?.chunks.find((c) => c.key === bk)?.page
        return (
          <li key={bk}>
            <button
              type="button"
              className={
                activeBook === bk
                  ? 'settlement-chip active'
                  : 'settlement-chip'
              }
              title={bk}
              onClick={(e) => {
                e.stopPropagation()
                onPick(bk)
              }}
            >
              {short(bk, 14)}
              {page != null ? ` · p${page + 1}` : ''}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

type PathRow = {
  pathKey: string
  solutionKey: string
  conclusion: string
  bookKeysSequence: string[]
  steps: Array<{
    inferKey: string
    role: string
    bookKeys: string[]
    inferText: string
  }>
  prospects: Array<{
    prospectKey: string
    briefKey: string
    bookKey: string
    text: string
  }>
}

export function SettlementDeskPanel({
  layout = 'float',
}: {
  /** tri-mid = 结算三栏中段；float = 旧浮动（复用闸仍可用） */
  layout?: 'float' | 'tri-mid'
}) {
  const pendingReuse = useAttentionIo((s) => s.pendingReuseProposal)
  const pendingPath = useAttentionIo((s) => s.pendingPathMatch)
  const bookIndex = useIndexGate((s) => s.bookIndex)
  const paths = useAttentionIo((s) => s.paths)

  const [busy, setBusy] = useState(false)
  const [selectedNorms, setSelectedNorms] = useState<Set<string>>(new Set())
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<string | null>(null)
  const [activeBook, setActiveBook] = useState<string | null>(null)
  const [focusPathKey, setFocusPathKey] = useState<string | null>(null)
  const [focusStepIdx, setFocusStepIdx] = useState<number | null>(null)

  const mode: 'reuse' | 'path' | null = pendingReuse
    ? 'reuse'
    : pendingPath
      ? 'path'
      : null

  const pathRows = useMemo((): PathRow[] => {
    if (!pendingPath) return []
    const pairs = pendingPath.boundPairs ?? []
    const normalize = (row: PathRow): PathRow => {
      const fromSteps = [
        ...new Set(row.steps.flatMap((s) => s.bookKeys)),
      ]
      const bookKeysSequence =
        row.bookKeysSequence.length > 0
          ? row.bookKeysSequence
          : fromSteps
      return { ...row, bookKeysSequence }
    }
    if (pairs.length > 0) {
      return pairs.map((p) => {
        const rec = paths.find((x) => x.pathKey === p.pathKey)
        return normalize({
          pathKey: p.pathKey,
          solutionKey: p.solutionKey || rec?.solutionKey || '',
          conclusion: p.conclusion || rec?.conclusion || '',
          bookKeysSequence:
            p.bookKeysSequence?.length
              ? p.bookKeysSequence
              : p.sharedBookKeys ?? [],
          steps:
            p.steps?.map((s) => ({
              inferKey: s.inferKey,
              role: s.role,
              bookKeys: s.bookKeys,
              inferText: s.inferText,
            })) ??
            rec?.steps?.map((s) => ({
              inferKey: s.inferKey,
              role: s.role,
              bookKeys: s.bookKeys,
              inferText: s.infer,
            })) ??
            [],
          prospects: p.prospects ?? [],
        })
      })
    }
    return (pendingPath.pathKeys ?? []).map((pathKey) => {
      const rec = paths.find((p) => p.pathKey === pathKey)
      return normalize({
        pathKey,
        solutionKey: rec?.solutionKey ?? '',
        conclusion: rec?.conclusion ?? '',
        bookKeysSequence: rec?.bookKeysSequence ?? [],
        steps:
          rec?.steps?.map((s) => ({
            inferKey: s.inferKey,
            role: s.role,
            bookKeys: s.bookKeys,
            inferText: s.infer,
          })) ?? [],
        prospects: [],
      })
    })
  }, [pendingPath, paths])

  const pathStats = useMemo(() => {
    const stepCount = pathRows.reduce((n, r) => n + r.steps.length, 0)
    return { solutions: pathRows.length, steps: stepCount }
  }, [pathRows])

  const reuseBookKeys = useMemo(() => {
    if (!pendingReuse) return [] as string[]
    return [
      ...new Set(pendingReuse.candidates.flatMap((c) => c.bookKeys)),
    ].filter(Boolean)
  }, [pendingReuse])

  const boundBookKeys = useMemo(
    () => [...new Set(pathRows.flatMap((r) => r.bookKeysSequence))],
    [pathRows],
  )

  const boundBookKeySig = boundBookKeys.join('|')
  const pathKeySig = pathRows.map((r) => r.pathKey).join('|')

  useEffect(() => {
    if (!mode) {
      exitSettlementFrame()
      setStatus(null)
      setActiveBook(null)
      setFocusPathKey(null)
      setFocusStepIdx(null)
      return
    }
    if (pendingReuse) {
      setSelectedNorms(new Set(pendingReuse.candidates.map((c) => c.normKey)))
    }
    if (pendingPath) {
      setSelectedPaths(new Set(pathRows.map((r) => r.pathKey)))
      useAttentionIo.getState().setDeskPrompt(
        `结算 · 解法 path×${pathRows.length} · 确认/撤销` +
          (pendingPath.question
            ? ` · ${pendingPath.question.slice(0, 40)}`
            : ''),
      )
      useAttentionIo.getState().setLastStatus(
        `等待确认 · 解法×${pathStats.solutions} · steps×${pathStats.steps}`,
      )
      if (pathRows[0]) {
        setFocusPathKey(pathRows[0].pathKey)
        setFocusStepIdx(0)
      }
    }
  }, [mode, pendingReuse?.createdAt, pendingPath?.createdAt, pathKeySig])

  // 预物化 + 默认锚到第一个 bookKey
  useEffect(() => {
    if (mode !== 'path' || !bookIndex || boundBookKeys.length === 0) return
    let cancelled = false
    void (async () => {
      const store = useDocuverse.getState()
      store.clearAuditSphereStrands()
      const strands = new Set<number>()
      for (const bk of boundBookKeys) {
        const chunk = bookIndex.chunks.find((c) => c.key === bk)
        if (chunk) strands.add(chunk.page)
      }
      for (const strand of strands) {
        if (cancelled) return
        await store.ensurePageForAudit(strand, { focus: false })
        store.registerAuditSphereStrand(strand)
      }
      if (cancelled) return
      const first = boundBookKeys[0]!
      setActiveBook(first)
      if (layout === 'tri-mid') {
        await focusSettlementAuditBook({
          bookKey: first,
          bookIndex,
        })
      } else {
        await enterSettlementSingleAnchor({
          kind: 'path',
          bookKey: first,
          bookIndex,
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mode, bookIndex?.docId, boundBookKeySig, layout])

  if (!mode) return null

  const onPickBook = async (bk: string) => {
    if (!bookIndex) return
    setActiveBook(bk)
    if (layout === 'tri-mid') {
      await focusSettlementAuditBook({ bookKey: bk, bookIndex })
    } else {
      await settlementSelectBookKey({ bookKey: bk, bookIndex })
    }
  }

  const onPickPath = (pathKey: string) => {
    setFocusPathKey(pathKey)
    setFocusStepIdx(0)
    const row = pathRows.find((r) => r.pathKey === pathKey)
    const bk = row?.steps[0]?.bookKeys[0]
    if (bk) void onPickBook(bk)
  }

  const onPickStep = (pathKey: string, stepIdx: number) => {
    setFocusPathKey(pathKey)
    setFocusStepIdx(stepIdx)
    const row = pathRows.find((r) => r.pathKey === pathKey)
    const step = row?.steps[stepIdx]
    const bk = step?.bookKeys[0]
    if (bk) void onPickBook(bk)
  }

  const onApproveReuse = () => {
    if (busy) return
    setBusy(true)
    try {
      const res = useAttentionIo.getState().approvePendingReuse({
        normKeys: [...selectedNorms],
        llmCallId: newLlmCallId('reuse'),
      })
      setStatus(res.note)
      if (res.ok) {
        const pathReturn = formatDirectedPathIncrementReturn({
          question: pendingReuse!.question,
          hopOutputs: [],
          mode: 'reuse',
          queryKey: pendingReuse!.queryKey,
        })
        useAttentionIo.getState().setDeskPrompt(`复用已批准 · ${res.note}`)
        useAttentionIo.getState().setLastStatus(pathReturn.slice(0, 200))
        exitSettlementFrame()
      }
    } finally {
      setBusy(false)
    }
  }

  const onRejectReuse = async () => {
    if (busy || !bookIndex) return
    setBusy(true)
    try {
      const r = useAttentionIo.getState().rejectPendingReuse()
      if (!r) return
      exitSettlementFrame()
      setStatus('已撤销复用 · 续跑新铸…')
      const sealItems = (
        items: Array<{
          key: string
          brief: string
          briefKey: string
          bookText?: string
        }>,
      ) => {
        const sealAttentionBond = useDocuverse.getState().sealAttentionBond
        return items.map((it) => {
          const chunk = bookIndex.chunks.find((c) => c.key === it.key)
          const bbox = chunk
            ? ([...chunk.bbox] as [number, number, number, number])
            : ([0, 0, 100, 100] as [number, number, number, number])
          const bondId = sealAttentionBond({
            strandIndex: chunk?.page ?? 0,
            bbox,
            confirmedText: it.bookText || it.key,
            comment: it.brief,
            bookKey: it.key,
            briefKey: it.briefKey,
          })
          return { ...it, bondId }
        })
      }
      const out = await runAutoFlow({
        question: r.question,
        bookIndex,
        skipReuse: true,
        excludeBriefKeys: r.excludeBriefKeys,
        sealItems,
        onProgress: (msg) => setStatus(msg),
      })
      useAttentionIo.getState().setDeskPrompt(out.note)
      setStatus(out.note)
    } finally {
      setBusy(false)
    }
  }

  const onConfirmPaths = () => {
    if (busy) return
    setBusy(true)
    try {
      const res = useAttentionIo.getState().settleUserPathMatches({
        queryKey: pendingPath?.queryKey,
        pathKeys: [...selectedPaths],
      })
      setStatus(res.note)
      if (res.ok) {
        useAttentionIo.getState().setLastStatus(res.note)
        exitSettlementFrame()
      }
    } finally {
      setBusy(false)
    }
  }

  const onRevokePaths = () => {
    if (busy) return
    setBusy(true)
    try {
      useAttentionIo.getState().clearPendingPathMatch()
      useAttentionIo.getState().setLastStatus('已撤销 path 候选 · 未登记 norm')
      setStatus('已撤销')
      exitSettlementFrame()
    } finally {
      setBusy(false)
    }
  }

  const shellClass =
    layout === 'tri-mid'
      ? 'settlement-desk settlement-desk--tri-mid'
      : mode === 'path'
        ? 'settlement-desk settlement-desk--path-only'
        : 'settlement-desk'

  return (
    <aside className={shellClass} aria-label="结算面板">
      <header className="settlement-desk-head">
        <span className="settlement-desk-title">
          {mode === 'reuse' ? '结算 · 复用闸' : '结算 · 确认解法 path'}
        </span>
        {status ? <span className="settlement-desk-status">{status}</span> : null}
      </header>

      {mode === 'path' && pendingPath ? (
        <div className="settlement-body">
          <div className="settlement-k">
            query{' '}
            <code title={pendingPath.queryKey}>
              {short(pendingPath.queryKey, 16)}
            </code>
            {pendingPath.question ? (
              <span className="settlement-q">
                {' '}
                · {pendingPath.question.slice(0, 72)}
                {pendingPath.question.length > 72 ? '…' : ''}
              </span>
            ) : null}
          </div>
          <div className="settlement-audit-line">
            解法 path×{pathStats.solutions} · steps×{pathStats.steps}
          </div>

          <ul className="settlement-rows">
            {pathRows.map((row) => {
              const open = focusPathKey === row.pathKey
              return (
                <li
                  key={row.pathKey}
                  className={
                    open
                      ? 'settlement-row settlement-row--open'
                      : 'settlement-row'
                  }
                >
                  <div className="settlement-path-line">
                    <label className="settlement-check">
                      <input
                        type="checkbox"
                        checked={selectedPaths.has(row.pathKey)}
                        onChange={() => {
                          setSelectedPaths((prev) => {
                            const n = new Set(prev)
                            if (n.has(row.pathKey)) n.delete(row.pathKey)
                            else n.add(row.pathKey)
                            return n
                          })
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="settlement-path-btn"
                      title="点击本解法：展开 steps，按步点 bookKey 审计"
                      onClick={() => onPickPath(row.pathKey)}
                    >
                      解法{' '}
                      <code title={row.pathKey}>{short(row.pathKey, 18)}</code>
                      {row.solutionKey ? (
                        <span className="settlement-badge">
                          {' '}
                          sk={short(row.solutionKey, 10)}
                        </span>
                      ) : null}
                    </button>
                  </div>

                  <div className="settlement-k">conclusion · 解法总览</div>
                  <pre className="settlement-path-text">
                    {row.conclusion || '（无 conclusion）'}
                  </pre>

                  <div className="settlement-book-list">
                    <div className="settlement-k">
                      本解法 bookKey×{row.bookKeysSequence.length}
                      {!open ? ' · 可直接点门上球' : ''}
                    </div>
                    <BookKeyChips
                      bookKeys={row.bookKeysSequence}
                      activeBook={activeBook}
                      bookIndex={bookIndex}
                      onPick={(bk) => {
                        setFocusPathKey(row.pathKey)
                        void onPickBook(bk)
                      }}
                    />
                  </div>

                  {open ? (
                    <>
                      <div className="settlement-k">
                        steps×{row.steps.length} · 点步 / 点该步门牌 → 上球审计
                      </div>
                      {row.steps.length === 0 ? (
                        <p className="settlement-hint">
                          无独立 step（单门锋利解可直接点上方 bookKey）
                        </p>
                      ) : null}
                      <ul className="settlement-steps">
                        {row.steps.map((st, idx) => {
                          const stepActive =
                            focusPathKey === row.pathKey &&
                            focusStepIdx === idx
                          const stepBooks =
                            st.bookKeys.length > 0
                              ? st.bookKeys
                              : row.bookKeysSequence
                          return (
                            <li
                              key={st.inferKey || idx}
                              className={
                                stepActive
                                  ? 'settlement-step settlement-step--active'
                                  : 'settlement-step'
                              }
                            >
                              <button
                                type="button"
                                className="settlement-step-btn"
                                onClick={() => onPickStep(row.pathKey, idx)}
                              >
                                <span className="settlement-k">
                                  步骤 {idx + 1}
                                  {st.role ? ` · ${st.role}` : ''}
                                  {' · '}
                                  <code title={st.inferKey}>
                                    {short(st.inferKey || '∅', 10)}
                                  </code>
                                </span>
                                <pre className="settlement-path-text">
                                  {st.inferText || '（空）'}
                                </pre>
                              </button>
                              <div className="settlement-book-list settlement-book-list--step">
                                <div className="settlement-k">
                                  本步 bookKey×{stepBooks.length}
                                </div>
                                <BookKeyChips
                                  bookKeys={stepBooks}
                                  activeBook={
                                    stepActive ? activeBook : null
                                  }
                                  bookIndex={bookIndex}
                                  onPick={(bk) => {
                                    setFocusPathKey(row.pathKey)
                                    setFocusStepIdx(idx)
                                    void onPickBook(bk)
                                  }}
                                />
                              </div>
                            </li>
                          )
                        })}
                      </ul>

                      {(() => {
                        const stepBooks =
                          focusStepIdx != null
                            ? new Set(
                                row.steps[focusStepIdx]?.bookKeys
                                  ?.length
                                  ? row.steps[focusStepIdx]!.bookKeys
                                  : row.bookKeysSequence,
                              )
                            : null
                        const stepProspects = stepBooks
                          ? row.prospects.filter((pr) =>
                              stepBooks.has(pr.bookKey),
                            )
                          : row.prospects
                        return (
                          <>
                            <div className="settlement-k">
                              prospect 载荷
                              {stepBooks
                                ? `（本步）×${stepProspects.length}`
                                : `×${row.prospects.length}`}
                            </div>
                            {stepProspects.length > 0 ? (
                              <ul className="settlement-prospect-payload">
                                {stepProspects.map((pr) => (
                                  <li key={pr.prospectKey}>
                                    <code title={pr.prospectKey}>
                                      {short(pr.prospectKey, 12)}
                                    </code>
                                    {' · '}
                                    <button
                                      type="button"
                                      className="settlement-chip"
                                      title={pr.bookKey}
                                      onClick={() =>
                                        void onPickBook(pr.bookKey)
                                      }
                                    >
                                      {short(pr.bookKey, 12)}
                                    </button>
                                    <pre className="settlement-path-text">
                                      {pr.text || '（空）'}
                                    </pre>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="settlement-hint">
                                {stepBooks
                                  ? '本步门上暂无 decide prospect'
                                  : '本解法 book 上暂无 decide prospect'}
                              </p>
                            )}
                          </>
                        )
                      })()}
                    </>
                  ) : (
                    <p className="settlement-hint">
                      点击上方解法展开 steps；bookKey 已可直接点
                    </p>
                  )}
                </li>
              )
            })}
          </ul>

          <div className="settlement-actions">
            <button
              type="button"
              className="settlement-btn primary"
              disabled={busy || selectedPaths.size === 0}
              onClick={onConfirmPaths}
            >
              确认
            </button>
            <button
              type="button"
              className="settlement-btn danger"
              disabled={busy}
              onClick={onRevokePaths}
            >
              撤销
            </button>
          </div>
        </div>
      ) : null}

      {mode === 'reuse' && pendingReuse ? (
        <div className="settlement-body">
          {reuseBookKeys.length > 0 ? (
            <div className="settlement-book-list">
              <div className="settlement-k">
                材料 bookKey×{reuseBookKeys.length}
              </div>
              <ul className="settlement-book-chips">
                {reuseBookKeys.map((bk) => (
                  <li key={bk}>
                    <button
                      type="button"
                      className={
                        activeBook === bk
                          ? 'settlement-chip active'
                          : 'settlement-chip'
                      }
                      title={bk}
                      onClick={() => void onPickBook(bk)}
                    >
                      {short(bk, 14)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="settlement-k">
            提案 normKey×{pendingReuse.candidates.length}
          </div>
          <ul className="settlement-rows">
            {pendingReuse.candidates.map((c) => (
              <li key={c.normKey} className="settlement-row">
                <label className="settlement-check">
                  <input
                    type="checkbox"
                    checked={selectedNorms.has(c.normKey)}
                    onChange={() => {
                      setSelectedNorms((prev) => {
                        const n = new Set(prev)
                        if (n.has(c.normKey)) n.delete(c.normKey)
                        else n.add(c.normKey)
                        return n
                      })
                    }}
                  />
                  <span>
                    norm <code>{short(c.normKey)}</code> · path{' '}
                    <code>{short(c.pathKey)}</code>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="settlement-actions">
            <button
              type="button"
              className="settlement-btn primary"
              disabled={busy || selectedNorms.size === 0}
              onClick={onApproveReuse}
            >
              批准复用
            </button>
            <button
              type="button"
              className="settlement-btn danger"
              disabled={busy}
              onClick={() => void onRejectReuse()}
            >
              撤销 → 新铸
            </button>
          </div>
        </div>
      ) : null}
    </aside>
  )
}
