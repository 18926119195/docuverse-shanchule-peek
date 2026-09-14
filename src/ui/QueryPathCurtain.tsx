/**
 * 写信台提示 ↔ 输入框之间的自由幕布：
 * 一级历史 queryKey → 点开 pathKey → 展开解法详情（conclusion / steps / bookKey）
 * bookKey 点击上球审计。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAttentionIo } from '../reasoning/attentionIoStore'
import type { PendingReuseCandidate } from '../reasoning/attentionIoStore'
import { useIndexGate } from '../reasoning/indexGate'
import type { BookIndex } from '../reasoning/pipelineA'
import { useDocuverse } from '../canvas/store'
import {
  focusSettlementAuditBook,
  exitSettlementFrame,
} from '../canvas/settleFrame'
import { listSettledQueryKeysNewestFirst } from '../reasoning/queryIncrementTree'
import { usePanelSummonStore } from '../reasoning/panelSummonStore'
import { QueryKeyInfiniteCanvas } from './QueryKeyInfiniteCanvas'
import { formatDirectedPathIncrementReturn } from '../arch/pathIncrementReturn'
import { runAutoFlow } from '../reasoning/autoFlow'
import { newLlmCallId } from '../reasoning/settleMint'
import { prospectBookKey } from '../reasoning/pathLineageBind'

const CURTAIN_H_SPLIT_KEY = 'docuverse.curtain.auditRatio'
const CURTAIN_AUDIT_DEFAULT = 0.55
const CURTAIN_AUDIT_MIN = 0.04
const CURTAIN_AUDIT_MAX = 0.96

function loadCurtainAuditRatio(): number {
  try {
    const raw = sessionStorage.getItem(CURTAIN_H_SPLIT_KEY)
    if (!raw) return CURTAIN_AUDIT_DEFAULT
    const n = Number(raw)
    if (!Number.isFinite(n)) return CURTAIN_AUDIT_DEFAULT
    return Math.min(CURTAIN_AUDIT_MAX, Math.max(CURTAIN_AUDIT_MIN, n))
  } catch {
    return CURTAIN_AUDIT_DEFAULT
  }
}

function saveCurtainAuditRatio(n: number) {
  try {
    sessionStorage.setItem(CURTAIN_H_SPLIT_KEY, String(n))
  } catch {
    /* ignore */
  }
}

function short(k: string, n = 10): string {
  const t = k.trim()
  if (t.length <= n) return t
  return `${t.slice(0, 4)}…${t.slice(-4)}`
}

type PathProspect = {
  prospectKey: string
  briefKey: string
  bookKey: string
  text: string
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
    bookSlots?: number[]
    inferText: string
  }>
  prospects: PathProspect[]
  /** 复用提案附带 */
  normKey?: string
  normText?: string
  rationale?: string
  oldQueryKey?: string
}

function machineCode(n: number): string {
  if (n < 0) return `门${-n}`
  return `⟦${n}⟧`
}

function bookChipLabel(slot: number, page: number | undefined): string {
  const code = machineCode(slot)
  const pagePart = page != null ? ` · 页${page + 1}` : ''
  return `${code}${pagePart}`
}

function prospectChipLabel(
  slot: number,
  page: number | undefined,
  multiIndex?: number,
): string {
  const code =
    multiIndex != null && multiIndex > 0
      ? `${machineCode(slot)}.${multiIndex + 1}`
      : machineCode(slot)
  const pagePart = page != null ? ` · 页${page + 1}` : ''
  return `${code}${pagePart}`
}

function prospectsForBook(
  bookKey: string,
  prospects: PathProspect[],
): PathProspect[] {
  return prospects.filter(
    (pr) => pr.bookKey === bookKey || pr.briefKey === bookKey,
  )
}

/** 只认精确门键；禁止同页软对齐（会把别的槽的解挂到本门） */
function prospectsForStepBooks(
  stepBooks: string[],
  prospects: PathProspect[],
): PathProspect[] {
  return prospects.filter(
    (pr) =>
      stepBooks.includes(pr.bookKey) || stepBooks.includes(pr.briefKey),
  )
}

type BoundBookInfer = {
  /** 文内/窗内槽号（如 3、4），不是本解法随便编的序 */
  slot: number
  explain: string
}

/**
 * ⟦n⟧ ↔ bookKey 一一绑定（多门一步 = 分述 +【合推】）：
 * - bookSlots[i] = 窗内槽号 n ↔ bookKeys[i]（展开时写入）
 * - infer：各 ⟦n⟧ 分述 → 【合推】本步如何共同完成
 */
function bindStepInferToBooks(
  inferText: string,
  bookKeys: string[],
  bookSlots?: number[],
): {
  byBook: Map<string, BoundBookInfer>
  jointNote: string
} {
  const byBook = new Map<string, BoundBookInfer>()
  const text = (inferText || '').trim()
  if (!text || bookKeys.length === 0) {
    return { byBook, jointNote: '' }
  }

  const slots =
    bookSlots && bookSlots.length === bookKeys.length
      ? bookSlots
      : bookKeys.map((bk, i) => {
          const sm = /^⟦\s*(\d+)\s*⟧$/.exec(bk.trim())
          return sm ? Number(sm[1]) : i + 1
        })

  const splitJoint = (
    body: string,
  ): { head: string; joint: string } => {
    const jm =
      /(?:^|[\n。；;])\s*(?:【\s*合推\s*】|(?:两门|诸门)?合读[：:]|(?:本步)?合推[：:]|综上[：:])\s*([\s\S]*)$/u.exec(
        body,
      )
    if (!jm || jm.index == null) return { head: body.trim(), joint: '' }
    const joint = (jm[1] || '').trim()
    const head = body
      .slice(0, jm.index)
      .replace(/[。；;\s]+$/u, '')
      .trim()
    return { head, joint }
  }

  const re = /⟦\s*(\d+)\s*⟧/g
  const hits: Array<{ n: number; index: number; len: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    hits.push({ n: Number(m[1]), index: m.index, len: m[0].length })
  }

  if (hits.length === 0) {
    if (bookKeys.length >= 2) {
      for (let i = 0; i < bookKeys.length; i++) {
        byBook.set(bookKeys[i]!, { slot: slots[i]!, explain: '' })
      }
      const { head, joint } = splitJoint(text)
      return { byBook, jointNote: joint || head || text }
    }
    byBook.set(bookKeys[0]!, { slot: slots[0]!, explain: text })
    return { byBook, jointNote: '' }
  }

  let jointNote = ''
  {
    const peeled = splitJoint(text)
    if (peeled.joint) jointNote = peeled.joint
  }
  const workText = jointNote ? splitJoint(text).head || text : text

  const workHits: typeof hits = []
  re.lastIndex = 0
  while ((m = re.exec(workText))) {
    workHits.push({ n: Number(m[1]), index: m.index, len: m[0].length })
  }

  for (let i = 0; i < bookKeys.length; i++) {
    const slot = slots[i]!
    const bk = bookKeys[i]!
    const hitIdx = workHits.findIndex((h) => h.n === slot)
    if (hitIdx < 0) {
      byBook.set(bk, { slot, explain: '' })
      continue
    }
    const cur = workHits[hitIdx]!
    const start = cur.index + cur.len
    const nextHit = workHits.find((h, j) => j > hitIdx && h.index > cur.index)
    let body = workText
      .slice(start, nextHit ? nextHit.index : workText.length)
      .trim()
    body = body
      .replace(/^[\s;；。、:：·•]+/, '')
      .replace(/[;；、]+$/u, '')
      .trim()
    const peeled = splitJoint(body)
    if (peeled.joint && !jointNote) jointNote = peeled.joint
    byBook.set(bk, { slot, explain: peeled.head })
  }

  return { byBook, jointNote }
}

/**
 * 对齐：
 * - 左 = 文内 ⟦n⟧ 对该 bookKey 的分述（一一）
 * - 右 = 同 bookKey 上的 prospect
 * - 展开左右同步；合推句单独挂在末行下
 */
function StepBookProspectRows({
  stepIdx,
  stepInfer,
  bookKeys,
  bookSlots,
  prospects,
  activeBook,
  bookIndex,
  selectedProspectKeys,
  expandedKeys,
  onPickBook,
  onToggleProspect,
  onToggleRowExpand,
}: {
  stepIdx: number
  stepInfer: string
  bookKeys: string[]
  bookSlots?: number[]
  pathBookOrder?: string[]
  prospects: PathProspect[]
  activeBook: string | null
  bookIndex: BookIndex | null
  selectedProspectKeys: Set<string>
  /** `${stepIdx}::${bookKey}` 可多开，切步不关 */
  expandedKeys: Set<string>
  onPickBook: (bk: string) => void
  onToggleProspect: (pk: string) => void
  onToggleRowExpand: (stepIdx: number, bk: string) => void
}) {
  if (bookKeys.length === 0) {
    return <p className="curtain-hint">本步尚无材料门</p>
  }
  const { byBook, jointNote } = bindStepInferToBooks(
    stepInfer,
    bookKeys,
    bookSlots,
  )
  const expandId = (bk: string) => `${stepIdx}::${bk}`
  const jointOpen = bookKeys.some((bk) => expandedKeys.has(expandId(bk)))
  return (
    <ul className="bp-rows">
      {bookKeys.map((bk, i) => {
        const bound = byBook.get(bk)
        const slot = bound?.slot ?? -(i + 1)
        const page = bookIndex?.chunks.find((c) => c.key === bk)?.page
        const paired = prospectsForBook(bk, prospects)
        const open = expandedKeys.has(expandId(bk))
        const primaryPk = paired[0]?.prospectKey
        const explain = bound?.explain ?? ''
        const leftLabel = bookChipLabel(slot, page)
        return (
          <li
            key={`${bk}-${i}`}
            className={open ? 'bp-row bp-row--open' : 'bp-row'}
          >
            <div className="bp-row-head">
              <div className="bp-col bp-col-book">
                <button
                  type="button"
                  className={
                    activeBook === bk
                      ? 'curtain-chip active'
                      : 'curtain-chip'
                  }
                  title={`bookKey=${bk}\n文内槽=${slot > 0 ? `⟦${slot}⟧` : '无（未写门牌）'}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onPickBook(bk)
                  }}
                >
                  {leftLabel}
                </button>
                <button
                  type="button"
                  className="bp-expand-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleRowExpand(stepIdx, bk)
                    onPickBook(bk)
                  }}
                >
                  {open ? '收起对照' : '展开对照'}
                </button>
              </div>
              <span className="bp-row-vs">↔</span>
              <div className="bp-col bp-col-prospect">
                {paired.length === 0 ? (
                  <span
                    className="curtain-hint"
                    title="decide 未在此 bookKey 上落 prospect"
                  >
                    本门无 prospect
                  </span>
                ) : (
                  paired.map((pr, pi) => {
                    const on = selectedProspectKeys.has(pr.prospectKey)
                    const pPage = bookIndex?.chunks.find(
                      (c) => c.key === (pr.bookKey || pr.briefKey),
                    )?.page
                    const pLabel = prospectChipLabel(
                      slot,
                      pPage ?? page,
                      paired.length > 1 ? pi : undefined,
                    )
                    return (
                      <div key={pr.prospectKey} className="bp-prospect-item">
                        <label className="bp-prospect-pick">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() =>
                              onToggleProspect(pr.prospectKey)
                            }
                            onClick={(e) => e.stopPropagation()}
                          />
                          <button
                            type="button"
                            className={
                              open && primaryPk === pr.prospectKey
                                ? 'curtain-chip bp-pk active'
                                : 'curtain-chip bp-pk'
                            }
                            title={
                              `prospectKey=${pr.prospectKey}\n` +
                              `同门 bookKey=${bk}`
                            }
                            onClick={(e) => {
                              e.stopPropagation()
                              onToggleRowExpand(stepIdx, bk)
                              onPickBook(bk)
                            }}
                          >
                            {pLabel}
                            {open ? ' · 收起' : ' · 展开'}
                          </button>
                        </label>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
            {open ? (
              <div className="bp-compare">
                <div className="bp-compare-col">
                  <div className="bp-compare-label">
                    {leftLabel} · infer 分述
                    {slot > 0
                      ? ''
                      : explain
                        ? ' · 文内无门牌，整段挂本门'
                        : ' · 待 ⟦n⟧ 分述'}
                  </div>
                  <pre className="curtain-text bp-prospect-text">
                    {explain ||
                      (bookKeys.length > 1
                        ? '（本门尚无 ⟦n⟧ 分述 · 见下方【合推】）'
                        : '（文内无该槽分述）')}
                  </pre>
                </div>
                <div className="bp-compare-col">
                  <div className="bp-compare-label">
                    {leftLabel} · prospect
                  </div>
                  {paired.length > 0 ? (
                    paired.map((pr) => (
                      <pre
                        key={pr.prospectKey}
                        className="curtain-text bp-prospect-text"
                      >
                        {pr.text || '（空）'}
                      </pre>
                    ))
                  ) : (
                    <p className="curtain-hint">本门无 prospect</p>
                  )}
                </div>
              </div>
            ) : null}
          </li>
        )
      })}
                  {jointOpen && jointNote ? (
        <li className="bp-row bp-row--joint">
          <div className="bp-compare-label">
            【合推】本步如何共同完成
            {bookKeys.length > 1 ? ` · ${bookKeys.length}门` : ''}
          </div>
          <pre className="curtain-text bp-prospect-text">{jointNote}</pre>
        </li>
      ) : null}
    </ul>
  )
}


function attachProspectsFromStore(
  queryKey: string,
  bookKeys: string[],
  existing: PathProspect[],
): PathProspect[] {
  if (existing.length > 0) return existing
  const bookSet = new Set(bookKeys)
  const st = useAttentionIo.getState()
  const docId = useIndexGate.getState().bookIndex?.docId?.trim() ?? ''
  const out: PathProspect[] = []
  const seen = new Set<string>()
  for (const p of st.prospects) {
    if (p.queryKey !== queryKey) continue
    const pk = p.prospectKey.trim()
    if (!pk || seen.has(pk)) continue
    const book =
      (docId
        ? prospectBookKey(docId, p, st.deskDeliveries)
        : null) ||
      p.briefKey.trim() ||
      null
    if (!book) continue
    if (bookSet.size > 0 && !bookSet.has(book) && !bookSet.has(p.briefKey)) {
      continue
    }
    seen.add(pk)
    out.push({
      prospectKey: pk,
      briefKey: p.briefKey,
      bookKey: book,
      text: p.text,
    })
  }
  return out
}

function resolveProspectsForReusePath(input: {
  oldQueryKey: string
  bookKeys: string[]
  prospectKeys: string[]
}): PathProspect[] {
  const st = useAttentionIo.getState()
  const docId = useIndexGate.getState().bookIndex?.docId?.trim() ?? ''
  const wantPk = new Set(input.prospectKeys.map((k) => k.trim()).filter(Boolean))
  const bookSet = new Set(input.bookKeys.map((k) => k.trim()).filter(Boolean))
  const out: PathProspect[] = []
  const seen = new Set<string>()

  const push = (p: (typeof st.prospects)[0]) => {
    const pk = p.prospectKey.trim()
    if (!pk || seen.has(pk)) return
    const book =
      (docId
        ? prospectBookKey(docId, p, st.deskDeliveries)
        : null) ||
      p.briefKey.trim() ||
      null
    if (!book) return
    seen.add(pk)
    out.push({
      prospectKey: pk,
      briefKey: p.briefKey,
      bookKey: book,
      text: p.text,
    })
  }

  // 1) 提案 / path 明示的 prospectKeys（仍须能解析到 book）
  if (wantPk.size > 0) {
    for (const p of st.prospects) {
      if (wantPk.has(p.prospectKey)) push(p)
    }
  }
  // 2) 旧问线上、父门落在本解法 bookKeys 上的 prospect（精确门）
  if (input.oldQueryKey && bookSet.size > 0) {
    for (const p of st.prospects) {
      if (p.queryKey !== input.oldQueryKey) continue
      const book =
        (docId
          ? prospectBookKey(docId, p, st.deskDeliveries)
          : null) ||
        p.briefKey.trim() ||
        null
      if (!book) continue
      if (!bookSet.has(book) && !bookSet.has(p.briefKey)) continue
      push(p)
    }
  }
  // 禁止「旧问全部 prospect」兜底：那会把无关解挂到审计里
  return out
}

function buildPathRowsForReuse(
  candidates: PendingReuseCandidate[],
  paths: ReturnType<typeof useAttentionIo.getState>['paths'],
): PathRow[] {
  const out: PathRow[] = []
  const seen = new Set<string>()
  for (const c of candidates) {
    if (seen.has(c.pathKey)) continue
    seen.add(c.pathKey)
    const rec = paths.find((p) => p.pathKey === c.pathKey)
    const fromSteps = [
      ...new Set(
        (rec?.steps ?? []).flatMap((s) => s.bookKeys.map((k) => k.trim())),
      ),
    ].filter(Boolean)
    const bookKeysSequence = [
      ...new Set(
        [
          ...(rec?.bookKeysSequence ?? []),
          ...fromSteps,
          ...(c.bookKeys ?? []),
        ].map((k) => k.trim()).filter(Boolean),
      ),
    ]
    const oldQk = c.oldQueryKey || rec?.queryKey || ''
    const prospectKeys = [
      ...new Set(
        [
          ...(c.prospectKeys ?? []),
          ...(rec?.prospectKeys ?? []),
          ...(rec?.prospectKey ? [rec.prospectKey] : []),
        ]
          .map((k) => k.trim())
          .filter(Boolean),
      ),
    ]
    out.push({
      pathKey: c.pathKey,
      solutionKey: rec?.solutionKey ?? '',
      conclusion: rec?.conclusion || c.normText || '',
      bookKeysSequence,
      steps:
        rec?.steps?.map((s) => ({
          inferKey: s.inferKey,
          role: s.role,
          bookKeys: s.bookKeys,
          bookSlots: s.bookSlots,
          inferText: s.infer,
        })) ?? [],
      prospects: resolveProspectsForReusePath({
        oldQueryKey: oldQk,
        bookKeys: bookKeysSequence,
        prospectKeys,
      }),
      normKey: c.normKey,
      normText: c.normText,
      rationale: c.rationale,
      oldQueryKey: oldQk,
    })
  }
  return out
}

function buildPathRowsForQuery(
  queryKey: string,
  pendingPath: ReturnType<
    typeof useAttentionIo.getState
  >['pendingPathMatch'],
  paths: ReturnType<typeof useAttentionIo.getState>['paths'],
): PathRow[] {
  const normalize = (row: PathRow): PathRow => {
    const fromSteps = [...new Set(row.steps.flatMap((s) => s.bookKeys))]
    const bookKeysSequence =
      row.bookKeysSequence.length > 0 ? row.bookKeysSequence : fromSteps
    return {
      ...row,
      bookKeysSequence,
      prospects: attachProspectsFromStore(
        queryKey,
        bookKeysSequence,
        row.prospects,
      ),
    }
  }

  if (
    pendingPath &&
    pendingPath.queryKey === queryKey &&
    (pendingPath.boundPairs?.length || pendingPath.pathKeys?.length)
  ) {
    const pairs = pendingPath.boundPairs ?? []
    if (pairs.length > 0) {
      return pairs.map((p) => {
        const rec = paths.find((x) => x.pathKey === p.pathKey)
        return normalize({
          pathKey: p.pathKey,
          solutionKey: p.solutionKey || rec?.solutionKey || '',
          conclusion: p.conclusion || rec?.conclusion || '',
          bookKeysSequence: p.bookKeysSequence?.length
            ? p.bookKeysSequence
            : p.sharedBookKeys ?? [],
          steps:
            p.steps?.map((s) => ({
              inferKey: s.inferKey,
              role: s.role,
              bookKeys: s.bookKeys,
              bookSlots: s.bookSlots,
              inferText: s.inferText,
            })) ??
            rec?.steps?.map((s) => ({
              inferKey: s.inferKey,
              role: s.role,
              bookKeys: s.bookKeys,
              bookSlots: s.bookSlots,
              inferText: s.infer,
            })) ??
            [],
          prospects: (p.prospects ?? []).map((pr) => ({
            prospectKey: pr.prospectKey,
            briefKey: pr.briefKey,
            bookKey: pr.bookKey || pr.briefKey,
            text: pr.text,
          })),
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
            bookSlots: s.bookSlots,
            inferText: s.infer,
          })) ?? [],
        prospects: [],
      })
    })
  }

  return paths
    .filter((p) => p.queryKey === queryKey)
    .map((rec) =>
      normalize({
        pathKey: rec.pathKey,
        solutionKey: rec.solutionKey ?? '',
        conclusion: rec.conclusion ?? '',
        bookKeysSequence: rec.bookKeysSequence ?? [],
        steps:
          rec.steps?.map((s) => ({
            inferKey: s.inferKey,
            role: s.role,
            bookKeys: s.bookKeys,
            bookSlots: s.bookSlots,
            inferText: s.infer,
          })) ?? [],
        prospects: [],
      }),
    )
}

export function QueryPathCurtain() {
  const settled = useAttentionIo((s) => s.settledQueries)
  const selectedQueryKey = useAttentionIo((s) => s.selectedQueryKey)
  const pendingPath = useAttentionIo((s) => s.pendingPathMatch)
  const pendingReuse = useAttentionIo((s) => s.pendingReuseProposal)
  const pendingReuseWait = useAttentionIo((s) => s.pendingReuseWait)
  const paths = useAttentionIo((s) => s.paths)
  const prospects = useAttentionIo((s) => s.prospects)
  const inferEdges = useAttentionIo((s) => s.inferEdges)
  const lastStatus = useAttentionIo((s) => s.lastStatus)
  const bookIndex = useIndexGate((s) => s.bookIndex)

  const qkRows = useMemo(() => {
    void settled
    return listSettledQueryKeysNewestFirst()
  }, [settled])

  const [focusQk, setFocusQk] = useState<string | null>(null)
  const [focusPathKey, setFocusPathKey] = useState<string | null>(null)
  const [focusStepIdx, setFocusStepIdx] = useState<number | null>(null)
  const [activeBook, setActiveBook] = useState<string | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [selectedNorms, setSelectedNorms] = useState<Set<string>>(new Set())
  const [selectedProspectKeys, setSelectedProspectKeys] = useState<Set<string>>(
    new Set(),
  )
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [auditRatio, setAuditRatio] = useState(loadCurtainAuditRatio)
  const [hSplitDragging, setHSplitDragging] = useState(false)
  const curtainSplitRef = useRef<HTMLDivElement>(null)
  const hSplitDragRef = useRef(false)
  const auditRatioRef = useRef(auditRatio)
  auditRatioRef.current = auditRatio

  const applyCurtainHSplit = useCallback((clientX: number) => {
    const root = curtainSplitRef.current
    if (!root) return
    const rect = root.getBoundingClientRect()
    const usable = Math.max(160, rect.width - 8)
    const x = clientX - rect.left
    const next = Math.min(
      CURTAIN_AUDIT_MAX,
      Math.max(CURTAIN_AUDIT_MIN, x / usable),
    )
    auditRatioRef.current = next
    setAuditRatio(next)
  }, [])

  useEffect(() => {
    if (!hSplitDragging) return
    const onMove = (e: PointerEvent) => {
      if (!hSplitDragRef.current) return
      e.preventDefault()
      applyCurtainHSplit(e.clientX)
    }
    const onUp = () => {
      hSplitDragRef.current = false
      setHSplitDragging(false)
      saveCurtainAuditRatio(auditRatioRef.current)
      window.dispatchEvent(new Event('resize'))
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [hSplitDragging, applyCurtainHSplit])

  // 对话一铸 qk / 结算 pending → 幕布立刻钉到该问
  useEffect(() => {
    if (selectedQueryKey && settled[selectedQueryKey]) {
      setFocusQk(selectedQueryKey)
    }
  }, [selectedQueryKey, settled])

  const activeQk =
    focusQk && settled[focusQk]
      ? focusQk
      : selectedQueryKey && settled[selectedQueryKey]
        ? selectedQueryKey
        : pendingReuse?.queryKey && settled[pendingReuse.queryKey]
          ? pendingReuse.queryKey
          : pendingPath?.queryKey && settled[pendingPath.queryKey]
            ? pendingPath.queryKey
            : qkRows[0]?.queryKey ?? null

  /** 仅当左侧正盯着「待批复用」那条现问时，才走复用审计 UI */
  const reuseAuditActive = Boolean(
    pendingReuse && activeQk && pendingReuse.queryKey === activeQk,
  )

  const pathRows = useMemo(() => {
    if (
      pendingReuse &&
      activeQk &&
      pendingReuse.queryKey === activeQk
    ) {
      return buildPathRowsForReuse(pendingReuse.candidates, paths)
    }
    return activeQk ? buildPathRowsForQuery(activeQk, pendingPath, paths) : []
  }, [activeQk, pendingPath, pendingReuse, paths])

  const pendingForActive =
    Boolean(pendingPath && pendingPath.queryKey === activeQk) ||
    reuseAuditActive

  // 进入复用提案：钉到现问 qk，展开首候选，勾选全部 norm
  useEffect(() => {
    if (!pendingReuse) return
    usePanelSummonStore.getState().dismissAll()
    setFocusQk(pendingReuse.queryKey)
    useAttentionIo.getState().openQueryKey(pendingReuse.queryKey)
    const rows = buildPathRowsForReuse(
      pendingReuse.candidates,
      useAttentionIo.getState().paths,
    )
    setSelectedNorms(
      new Set(pendingReuse.candidates.map((c) => c.normKey).filter(Boolean)),
    )
    setSelectedPaths(new Set(rows.map((r) => r.pathKey)))
    if (rows[0]) {
      setFocusPathKey(rows[0].pathKey)
      setFocusStepIdx(0)
    }
    useAttentionIo.getState().setDeskPrompt(
      `结算 · 复用审计×${rows.length} · 批准/撤销→新铸` +
        (pendingReuse.question
          ? ` · ${pendingReuse.question.slice(0, 40)}`
          : ''),
    )
  }, [pendingReuse?.createdAt, pendingReuse?.queryKey])

  // 进入待结算问：收起刷屏微球，默认展开该 qk / 首 path
  useEffect(() => {
    if (!pendingPath || pendingReuse) return
    usePanelSummonStore.getState().dismissAll()
    setFocusQk(pendingPath.queryKey)
    const rows = buildPathRowsForQuery(
      pendingPath.queryKey,
      pendingPath,
      useAttentionIo.getState().paths,
    )
    setSelectedPaths(new Set(rows.map((r) => r.pathKey)))
    if (rows[0]) {
      setFocusPathKey(rows[0].pathKey)
      setFocusStepIdx(0)
    }
    useAttentionIo.getState().setDeskPrompt(
      `结算 · 解法 path×${rows.length} · 确认/撤销` +
        (pendingPath.question
          ? ` · ${pendingPath.question.slice(0, 40)}`
          : ''),
    )
  }, [pendingPath?.createdAt, pendingPath?.queryKey, pendingReuse])

  // 切 path 时默认勾选该解法全部 prospect；展开态按 path 清空
  useEffect(() => {
    if (!focusPathKey) return
    const row = pathRows.find((r) => r.pathKey === focusPathKey)
    if (!row) return
    setSelectedProspectKeys(new Set(row.prospects.map((p) => p.prospectKey)))
    setExpandedKeys(new Set())
  }, [focusPathKey])

  const onToggleRowExpand = (stepIdx: number, bk: string) => {
    const id = `${stepIdx}::${bk}`
    setExpandedKeys((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  const onToggleProspect = (pk: string) => {
    setSelectedProspectKeys((prev) => {
      const n = new Set(prev)
      if (n.has(pk)) n.delete(pk)
      else n.add(pk)
      return n
    })
  }

  // 预物化当前解法 bookKeys → 球
  useEffect(() => {
    if (!bookIndex || !focusPathKey) return
    const row = pathRows.find((r) => r.pathKey === focusPathKey)
    if (!row || row.bookKeysSequence.length === 0) return
    let cancelled = false
    void (async () => {
      const store = useDocuverse.getState()
      store.clearAuditSphereStrands()
      usePanelSummonStore.getState().dismissAll()
      const strands = new Set<number>()
      for (const bk of row.bookKeysSequence) {
        const chunk = bookIndex.chunks.find((c) => c.key === bk)
        if (chunk) strands.add(chunk.page)
      }
      for (const strand of strands) {
        if (cancelled) return
        await store.ensurePageForAudit(strand, { focus: false })
        store.registerAuditSphereStrand(strand)
      }
      if (cancelled) return
      const first =
        row.steps[focusStepIdx ?? 0]?.bookKeys[0] ?? row.bookKeysSequence[0]
      if (first) {
        setActiveBook(first)
        const ok = await focusSettlementAuditBook({
          bookKey: first,
          bookIndex,
        })
        setStatus(
          ok
            ? `上球 · 页材料`
            : `上球失败 · 查材料槽`,
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [focusPathKey, bookIndex?.docId, pathRows])

  const onPickBook = async (bk: string) => {
    if (!bookIndex) {
      setStatus('无 bookIndex · 请先上传 PDF')
      return
    }
    setActiveBook(bk)
    usePanelSummonStore.getState().dismissAll()
    const ok = await focusSettlementAuditBook({ bookKey: bk, bookIndex })
    const strand = bookIndex.chunks.find((c) => c.key === bk)?.page
    const page = useDocuverse
      .getState()
      .pages.find((p) => p.strandIndex === strand)
    setStatus(
      ok
        ? `上球 · 页${strand != null ? strand + 1 : '?'}${page?.imageUrl ? ' · 有图' : ' · 纸页'}`
        : `上球失败 · 页${strand != null ? strand + 1 : '∅'}`,
    )
  }

  const onConfirmPaths = () => {
    if (!pendingPath || busy || selectedPaths.size === 0) return
    setBusy(true)
    void (async () => {
      try {
        const confirmedQk = pendingPath.queryKey
        const res = useAttentionIo.getState().settleUserPathMatches({
          queryKey: confirmedQk,
          pathKeys: [...selectedPaths],
        })
        setStatus(res.note)
        if (!res.ok) return

        exitSettlementFrame()
        useAttentionIo.getState().clearDeskPrompt()

        const wait = useAttentionIo.getState().pendingReuseWait
        const shouldResume =
          Boolean(wait) &&
          res.normKeys.length > 0 &&
          Boolean(
            wait &&
              wait.awaitingHistoricQueryKeys.includes(confirmedQk),
          )
        if (!shouldResume || !wait) return

        const docId = bookIndex?.docId?.trim() || ''
        setStatus('复用停泊续跑 · 复用闸…')
        const { runReuseGate } = await import('../reasoning/letterDeskDispatch')
        const gate = await runReuseGate({
          qNow: wait.question,
          queryKey: wait.queryKey,
          docId: docId || undefined,
          excludeNormKeys: wait.exhaustedNormKeys,
          onProgress: (msg) => setStatus(msg),
        })
        if (gate.awaitingApproval) {
          useAttentionIo.getState().setDeskPrompt(
            `写信台 · 复用提案（停泊续跑）：批准铸 reuse→norm。qk=${gate.queryKey ?? wait.queryKey}`,
          )
          setStatus(gate.note)
          return
        }
        if (gate.awaitingMoreNorms) {
          useAttentionIo.getState().setDeskPrompt(
            `复用停泊 · 等历史问确认 path 后续跑 · qk=${gate.queryKey ?? wait.queryKey}` +
              (gate.awaitingHistoricQueryKeys?.length
                ? ` · 待：${gate.awaitingHistoricQueryKeys.map((k) => k.slice(0, 18)).join(',')}`
                : ''),
          )
          setStatus(gate.note)
          return
        }
        // 邻域 norm 已尽仍不够 → 落入新铸由用户再开；不自动 decide
        useAttentionIo.getState().setDeskPrompt(
          `复用已尽试 · ${gate.note} · 可再问或手动续跑新铸`,
        )
        useAttentionIo.getState().setLastStatus(
          `复用停泊结束 · ${gate.note}`,
        )
        setStatus(`复用已尽试 · ${gate.note}`)
      } finally {
        setBusy(false)
      }
    })()
  }

  const onAbandonReuseWait = () => {
    const wait = useAttentionIo.getState().pendingReuseWait
    if (!wait || busy || !bookIndex) return
    setBusy(true)
    void (async () => {
      try {
        useAttentionIo.getState().clearPendingReuseWait()
        useAttentionIo.getState().clearDeskPrompt()
        exitSettlementFrame()
        setStatus('已放弃停泊 · 落入新铸…')
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
          question: wait.question,
          bookIndex,
          skipReuse: true,
          sealItems,
          onProgress: (msg) => setStatus(msg),
        })
        useAttentionIo.getState().setDeskPrompt(out.note)
        setStatus(out.note)
      } finally {
        setBusy(false)
      }
    })()
  }

  const onRevokePaths = () => {
    if (!pendingPath || busy) return
    setBusy(true)
    try {
      useAttentionIo.getState().clearPendingPathMatch()
      useAttentionIo.getState().clearDeskPrompt()
      useAttentionIo.getState().setLastStatus('已撤销 path 候选 · 未登记 norm')
      exitSettlementFrame()
      setStatus('已撤销')
    } finally {
      setBusy(false)
    }
  }

  const onApproveReuse = () => {
    if (!pendingReuse || busy || selectedNorms.size === 0) return
    setBusy(true)
    try {
      const res = useAttentionIo.getState().approvePendingReuse({
        normKeys: [...selectedNorms],
        llmCallId: newLlmCallId('reuse'),
      })
      setStatus(res.note)
      if (res.ok) {
        const pathReturn = formatDirectedPathIncrementReturn({
          question: pendingReuse.question,
          hopOutputs: [],
          mode: 'reuse',
          queryKey: pendingReuse.queryKey,
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
    if (!pendingReuse || busy || !bookIndex) return
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

  const onSelectQk = (qk: string) => {
    setFocusQk(qk)
    useAttentionIo.getState().openQueryKey(qk)
    const st = useAttentionIo.getState()
    const pending = st.pendingReuseProposal
    const rows =
      pending && pending.queryKey === qk
        ? buildPathRowsForReuse(pending.candidates, st.paths)
        : buildPathRowsForQuery(qk, st.pendingPathMatch, st.paths)
    if (pending && pending.queryKey === qk) {
      setSelectedNorms(
        new Set(pending.candidates.map((c) => c.normKey).filter(Boolean)),
      )
    }
    if (rows[0]) {
      setFocusPathKey(rows[0].pathKey)
      setFocusStepIdx(0)
      setSelectedPaths(new Set(rows.map((r) => r.pathKey)))
      const bk = rows[0].steps[0]?.bookKeys[0] ?? rows[0].bookKeysSequence[0]
      if (bk) void onPickBook(bk)
    } else {
      setFocusPathKey(null)
      setFocusStepIdx(null)
    }
  }

  const toggleReuseCandidate = (row: PathRow) => {
    const nk = row.normKey
    if (!nk) return
    setSelectedNorms((prev) => {
      const n = new Set(prev)
      if (n.has(nk)) n.delete(nk)
      else n.add(nk)
      return n
    })
    setSelectedPaths((prev) => {
      const n = new Set(prev)
      if (n.has(row.pathKey)) n.delete(row.pathKey)
      else n.add(row.pathKey)
      return n
    })
  }

  const canvasRatio = Math.max(0.01, 1 - auditRatio)

  return (
    <div
      ref={curtainSplitRef}
      className={
        hSplitDragging
          ? 'query-path-curtain query-path-curtain--split curtain-hsplit--dragging'
          : 'query-path-curtain query-path-curtain--split'
      }
      style={{
        gridTemplateColumns: `minmax(0, ${auditRatio}fr) 8px minmax(0, ${canvasRatio}fr)`,
      }}
      aria-label="queryKey 幕布"
    >
      <div className="curtain-audit" aria-label="解法审计">
        {!activeQk ? (
          <p className="curtain-hint">
            下方幕布点选 queryKey → 此处呈现该问的 path / steps / bookKey
          </p>
        ) : (
          <>
            <div className="curtain-now-qk">
              <span className="curtain-layer-label">
                {reuseAuditActive
                  ? '复用审计 · queryKey'
                  : '审计 · queryKey'}
              </span>
              <code title={activeQk}>{short(activeQk, 18)}</code>
              <span className="curtain-q">
                {(settled[activeQk] || pendingReuse?.question || '').slice(
                  0,
                  56,
                )}
                {(
                  settled[activeQk] ||
                  pendingReuse?.question ||
                  ''
                ).length > 56
                  ? '…'
                  : ''}
              </span>
            </div>
            {pendingReuseWait ? (
              <p className="curtain-hint curtain-hint--reuse-park">
                复用停泊 · 等历史问确认 path 后续跑
                {pendingReuseWait.awaitingHistoricQueryKeys.length > 0 ? (
                  <>
                    {' · 待 '}
                    {pendingReuseWait.awaitingHistoricQueryKeys
                      .map((k) => short(k, 12))
                      .join(', ')}
                  </>
                ) : null}
                {' · '}
                <button
                  type="button"
                  className="curtain-inline-link"
                  disabled={busy}
                  onClick={onAbandonReuseWait}
                >
                  放弃停泊·落入新铸
                </button>
              </p>
            ) : null}
            {pendingReuse && !reuseAuditActive ? (
              <p className="curtain-hint curtain-hint--reuse-park">
                另有复用提案待批 · 点幕布现问{' '}
                <button
                  type="button"
                  className="curtain-inline-link"
                  onClick={() => onSelectQk(pendingReuse.queryKey)}
                >
                  {short(pendingReuse.queryKey, 14)}
                </button>{' '}
                回到批准/撤销
              </p>
            ) : null}

            <div className="curtain-layer curtain-paths">
              <div className="curtain-layer-label">
                {reuseAuditActive
                  ? `复用候选×${pathRows.length} · 同审计对照 · 待批准`
                  : `path×${pathRows.length}${pendingForActive ? ' · 待结算' : ''}`}
              </div>
              {pathRows.length === 0 ? (
                <p className="curtain-hint">
                  {reuseAuditActive ? (
                    '复用提案无 path'
                  ) : (
                    <>
                      此问尚无 path
                      {(() => {
                        const pq = prospects.filter(
                          (p) => p.queryKey === activeQk,
                        ).length
                        const iq = inferEdges.filter(
                          (e) => e.queryKey === activeQk,
                        ).length
                        const bits: string[] = []
                        if (pq) bits.push(`prospect×${pq}`)
                        if (iq) bits.push(`infer×${iq}`)
                        if (bits.length) return ` · 已有 ${bits.join(' · ')}（待 infer 落 path 或确认）`
                        if (lastStatus?.includes('decide') || lastStatus?.includes('复用') || lastStatus?.includes('预取')) {
                          return ` · 自动流未完成：${lastStatus.slice(0, 48)}`
                        }
                        return ' · 需跑完 decide→infer 才有解法审计'
                      })()}
                    </>
                  )}
                </p>
              ) : (
                <ul className="curtain-path-list">
                  {pathRows.map((row) => (
                    <li key={row.pathKey}>
                      <button
                        type="button"
                        className={
                          focusPathKey === row.pathKey
                            ? 'curtain-path-btn active'
                            : 'curtain-path-btn'
                        }
                        onClick={() => {
                          setFocusPathKey(row.pathKey)
                          setFocusStepIdx(0)
                          const bk =
                            row.steps[0]?.bookKeys[0] ??
                            row.bookKeysSequence[0]
                          if (bk) void onPickBook(bk)
                        }}
                      >
                        {reuseAuditActive && row.normKey ? (
                          <input
                            type="checkbox"
                            checked={selectedNorms.has(row.normKey)}
                            onChange={(e) => {
                              e.stopPropagation()
                              toggleReuseCandidate(row)
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : pendingForActive && !reuseAuditActive ? (
                          <input
                            type="checkbox"
                            checked={selectedPaths.has(row.pathKey)}
                            onChange={(e) => {
                              e.stopPropagation()
                              setSelectedPaths((prev) => {
                                const n = new Set(prev)
                                if (n.has(row.pathKey)) n.delete(row.pathKey)
                                else n.add(row.pathKey)
                                return n
                              })
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : null}
                        {reuseAuditActive && row.normKey ? (
                          <code title={row.normKey}>
                            nk={short(row.normKey, 12)}
                          </code>
                        ) : null}
                        <code title={row.pathKey}>
                          {short(row.pathKey, 16)}
                        </code>
                        {row.oldQueryKey ? (
                          <span className="curtain-sk">
                            ←{short(row.oldQueryKey, 8)}
                          </span>
                        ) : row.solutionKey ? (
                          <span className="curtain-sk">
                            sk={short(row.solutionKey, 8)}
                          </span>
                        ) : null}
                        <span className="curtain-path-preview">
                          {(row.normText || row.conclusion || '').slice(0, 56)}
                          {(row.normText || row.conclusion || '').length > 56
                            ? '…'
                            : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {focusPathKey
              ? (() => {
                  const row = pathRows.find((r) => r.pathKey === focusPathKey)
                  if (!row) return null
                  return (
                    <div className="curtain-layer curtain-detail">
                      {reuseAuditActive && row.normText ? (
                        <>
                          <div className="curtain-k">
                            norm · 归一化推理
                            {row.oldQueryKey
                              ? ` · 来自 ${short(row.oldQueryKey, 14)}`
                              : ''}
                          </div>
                          <pre className="curtain-text">
                            {row.normText}
                          </pre>
                          {row.rationale ? (
                            <>
                              <div className="curtain-k">复用闸 rationale</div>
                              <pre className="curtain-text">
                                {row.rationale}
                              </pre>
                            </>
                          ) : null}
                        </>
                      ) : null}
                      <div className="curtain-k">conclusion · 解法总览</div>
                      <pre className="curtain-text">
                        {row.conclusion || '（无 conclusion）'}
                      </pre>
                      <div className="curtain-k">
                        steps×{row.steps.length} · 文内 ⟦n⟧ ↔ 该步 bookKey
                        一一分述；prospect 同门挂载
                        {row.prospects.length
                          ? ` · 本解 prospect×${row.prospects.length}`
                          : ''}
                        {' · '}
                        已选解×{selectedProspectKeys.size}
                      </div>
                      {row.prospects.length === 0 ? (
                        <p className="curtain-hint">
                          本解法账上未挂到 prospect（请查旧问 decide 落账 /
                          path.prospectKeys）
                        </p>
                      ) : null}
                      <ul className="curtain-steps">
                        {row.steps.map((st, idx) => {
                          const stepActive = focusStepIdx === idx
                          const stepBooks =
                            st.bookKeys.length > 0
                              ? st.bookKeys
                              : row.bookKeysSequence
                          const stepProspects = prospectsForStepBooks(
                            stepBooks,
                            row.prospects,
                          )
                          return (
                            <li
                              key={st.inferKey || idx}
                              className={
                                stepActive
                                  ? 'curtain-step active'
                                  : 'curtain-step'
                              }
                            >
                              <button
                                type="button"
                                className="curtain-step-btn"
                                onClick={() => {
                                  setFocusStepIdx(idx)
                                  const bk = stepBooks[0]
                                  if (bk) void onPickBook(bk)
                                }}
                              >
                                <span className="curtain-k">
                                  步骤 {idx + 1}
                                  {st.role ? ` · ${st.role}` : ''}
                                  {' · '}
                                  book×{stepBooks.length}
                                  {stepProspects.length
                                    ? ` · 解×${stepProspects.length}`
                                    : ''}
                                </span>
                              </button>
                              <StepBookProspectRows
                                stepIdx={idx}
                                stepInfer={st.inferText}
                                bookKeys={stepBooks}
                                bookSlots={st.bookSlots}
                                prospects={stepProspects}
                                activeBook={activeBook}
                                bookIndex={bookIndex}
                                selectedProspectKeys={selectedProspectKeys}
                                expandedKeys={expandedKeys}
                                onPickBook={(bk) => {
                                  setFocusStepIdx(idx)
                                  void onPickBook(bk)
                                }}
                                onToggleProspect={onToggleProspect}
                                onToggleRowExpand={onToggleRowExpand}
                              />
                            </li>
                          )
                        })}
                      </ul>
                      {row.prospects.length > 0 ? (
                        <div className="curtain-layer">
                          <div className="curtain-k">
                            本解法 prospect 全表×{row.prospects.length}
                            （按父门；步内「本门无」= 该步门未命中）
                          </div>
                          <ul className="curtain-path-list">
                            {row.prospects.map((pr, i) => {
                              const bk = pr.bookKey || pr.briefKey
                              const page = bookIndex?.chunks.find(
                                (c) => c.key === bk,
                              )?.page
                              return (
                                <li key={pr.prospectKey}>
                                  <button
                                    type="button"
                                    className="curtain-path-btn"
                                    title={pr.prospectKey}
                                    onClick={() => {
                                      if (bk) void onPickBook(bk)
                                    }}
                                  >
                                    <code>
                                      {page != null ? `页${page + 1}` : `解${i + 1}`}
                                    </code>
                                    <span className="curtain-path-preview">
                                      {(pr.text || '').slice(0, 64)}
                                      {(pr.text || '').length > 64 ? '…' : ''}
                                    </span>
                                  </button>
                                </li>
                              )
                            })}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  )
                })()
              : activeQk ? (
                  <p className="curtain-hint">点上方 path 展开 steps / bookKey</p>
                ) : null}

            {reuseAuditActive ? (
              <div className="curtain-actions">
                <button
                  type="button"
                  className="curtain-btn primary"
                  disabled={busy || selectedNorms.size === 0}
                  onClick={onApproveReuse}
                >
                  批准复用
                </button>
                <button
                  type="button"
                  className="curtain-btn danger"
                  disabled={busy}
                  onClick={() => void onRejectReuse()}
                >
                  撤销 → 新铸
                </button>
              </div>
            ) : pendingForActive ? (
              <div className="curtain-actions">
                <button
                  type="button"
                  className="curtain-btn primary"
                  disabled={busy || selectedPaths.size === 0}
                  onClick={onConfirmPaths}
                >
                  确认
                </button>
                <button
                  type="button"
                  className="curtain-btn danger"
                  disabled={busy}
                  onClick={onRevokePaths}
                >
                  撤销
                </button>
              </div>
            ) : null}
            {status ? <p className="curtain-status">{status}</p> : null}
          </>
        )}
      </div>

      <div
        className="curtain-hsplit-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="左右拖动：调审计与 queryKey 幕布宽度"
        aria-valuemin={Math.round(CURTAIN_AUDIT_MIN * 100)}
        aria-valuemax={Math.round(CURTAIN_AUDIT_MAX * 100)}
        aria-valuenow={Math.round(auditRatio * 100)}
        title="左右拖动 · 双击复位 · 左=审计全局 / 右=qk 幕布全局"
        onPointerDown={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
          hSplitDragRef.current = true
          setHSplitDragging(true)
          applyCurtainHSplit(e.clientX)
        }}
        onDoubleClick={() => {
          auditRatioRef.current = CURTAIN_AUDIT_DEFAULT
          setAuditRatio(CURTAIN_AUDIT_DEFAULT)
          saveCurtainAuditRatio(CURTAIN_AUDIT_DEFAULT)
          window.dispatchEvent(new Event('resize'))
        }}
      >
        <span className="curtain-hsplit-grip" aria-hidden />
      </div>

      <div className="curtain-qk-canvas" aria-label="queryKey 管理幕布">
        <QueryKeyInfiniteCanvas
          activeQueryKey={activeQk}
          onSelectQueryKey={onSelectQk}
        />
      </div>
    </div>
  )
}
