import { useEffect, useMemo, useState } from 'react'
import { useDocuverse } from '../canvas/store'
import {
  demoIndexPhaseLabel,
  demoPageRef,
  isPublicDemo,
  sanitizePublicExcerpt,
} from '../demoMode'
import { buildInferBundle } from '../reasoning/bundle'
import { saveBookIndex } from '../reasoning/bookIndexStore'
import { useReasoning } from '../reasoning/closureStore'
import { refineCandidateBoxesAsync } from '../reasoning/inkHighlight'
import { useIndexGate } from '../reasoning/indexGate'
import { callLlmWithBundle } from '../reasoning/llmClient'
import type { LlmCallResult } from '../reasoning/types'
import {
  buildBookIndex,
  resolveVqToCandidates,
  type BookIndex,
  type CircleCandidate,
} from '../reasoning/pipelineA'

const DEMO_QUERY = '是否提到分子无意识'

type Phase = 'pick' | 'inferring' | 'done'
type ViewSide = 'truth' | 'A' | 'B' | null

function hitLine(c: CircleCandidate, rank: number): string {
  return `#${rank + 1} · 相关度 ${c.score.toFixed(2)} · ${demoPageRef(c.R.page)}`
}

function publicExcerpt(raw: string): string {
  return sanitizePublicExcerpt(raw, isPublicDemo ? 120 : 160)
}

function machineExcerpt(c: CircleCandidate): string {
  const fromFace = c.R.faces.text?.content?.trim()
  if (fromFace && fromFace.length > 0) return fromFace
  return publicExcerpt(c.excerpt)
}

/** 检索候选列表 + 要求模型在末尾写 依据:#n（NotebookLM 式生成侧引用） */
function buildDemoQuestion(q: string, pool: CircleCandidate[]): string {
  if (pool.length === 0) return q
  const catalog = pool
    .map(
      (c, i) =>
        `#${i + 1} · ${demoPageRef(c.R.page)} · ${publicExcerpt(c.excerpt).slice(0, 72)}`,
    )
    .join('\n')
  return `${q}

【检索候选列表（序号供回答末尾标注；正文仍只依据本次选定对象）】
${catalog}

请在结论末尾另起一行写：依据:#序号（1-${pool.length}）`
}

function parseCiteRank(text: string, max: number): number | null {
  const patterns = [
    /依据[:：]\s*#?\s*(\d+)/i,
    /引用[:：]\s*#?\s*(\d+)/i,
    /\[#?\s*(\d+)\s*\]\s*$/,
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (!m) continue
    const n = Number.parseInt(m[1], 10)
    if (n >= 1 && n <= max) return n
  }
  return null
}

/**
 * 对照台：同选一条 → 进主模型 → A=检索参考+生成引用 / B=进模型回执。
 */
export function InterviewAbPanel({ solo = false }: { solo?: boolean }) {
  const corpus = useDocuverse((s) => s.corpus)
  const uploadLabel = useDocuverse((s) => s.uploadLabel)
  const pages = useDocuverse((s) => s.pages)
  const ocrByStrand = useDocuverse((s) => s.ocrByStrand)
  const currentStrand = useDocuverse((s) => s.currentStrand)
  const swoopToPage = useDocuverse((s) => s.swoopToPage)

  const gatedIndex = useIndexGate((s) => s.bookIndex)
  const indexReady = useIndexGate((s) => s.ready)
  const indexPhase = useIndexGate((s) => s.phase)

  const activateResolved = useReasoning((s) => s.activateResolved)
  const clearActive = useReasoning((s) => s.clearActive)
  const pushLog = useReasoning((s) => s.pushLog)
  const setPendingQuestion = useReasoning((s) => s.setPendingQuestion)
  const setError = useReasoning((s) => s.setError)
  const lockBoxes = useReasoning((s) => s.lockBoxes)

  const [query, setQuery] = useState(DEMO_QUERY)
  const [phase, setPhase] = useState<Phase>('pick')
  const [busy, setBusy] = useState(false)
  const [pool, setPool] = useState<CircleCandidate[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const [fedCandidate, setFedCandidate] = useState<CircleCandidate | null>(null)
  const [inferResult, setInferResult] = useState<LlmCallResult | null>(null)
  const [retrievalPool, setRetrievalPool] = useState<CircleCandidate[]>([])
  const [citeRank, setCiteRank] = useState<number | null>(null)

  const [viewSide, setViewSide] = useState<ViewSide>(null)
  const [viewKey, setViewKey] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const docId = useMemo(() => {
    if (corpus === 'upload' && uploadLabel) return `upload:${uploadLabel}`
    return `corpus:${corpus}`
  }, [corpus, uploadLabel])

  const [baseIndex, setBaseIndex] = useState<BookIndex>({
    docId,
    stream: '',
    chunks: [],
    builtAt: 0,
  })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const idx = await buildBookIndex({ docId, pages, ocrByStrand })
        if (!cancelled) setBaseIndex(idx)
      } catch {
        /* index gate / status surfaces errors */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [docId, pages, ocrByStrand])

  const bookIndex: BookIndex =
    gatedIndex && gatedIndex.docId === docId ? gatedIndex : baseIndex

  const slotCount = bookIndex.chunks.length
  const canRun =
    pages.length > 0 &&
    slotCount > 0 &&
    (indexReady ||
      (corpus !== 'upload' &&
        indexPhase !== 'ocr' &&
        indexPhase !== 'embedding' &&
        indexPhase !== 'importing'))

  const selected = useMemo(
    () => pool.find((c) => c.R.key === selectedKey) ?? null,
    [pool, selectedKey],
  )

  const citeCandidate = useMemo(() => {
    if (citeRank === null || retrievalPool.length === 0) return null
    return retrievalPool[citeRank - 1] ?? null
  }, [citeRank, retrievalPool])

  const ensureIndexPersisted = () => {
    if (!gatedIndex || gatedIndex.docId !== docId) {
      saveBookIndex(baseIndex)
    }
  }

  const refineCandidate = async (c: CircleCandidate): Promise<CircleCandidate> => {
    const text = c.R.faces.text?.content?.trim() ?? ''
    const pageDoc = pages.find((p) => p.strandIndex === c.R.page)
    let refinedBoxes = c.boxes
    if (c.boxes.length > 0) {
      const refined = await refineCandidateBoxesAsync({
        text,
        page: c.R.page,
        fallback: c.boxes,
        pageChunks: pageDoc?.textChunks,
        ocrBlocks: ocrByStrand[c.R.page]?.blocks,
        imageUrl: pageDoc?.imageUrl,
      })
      refinedBoxes = refined.boxes
    }
    return { ...c, boxes: refinedBoxes }
  }

  const focusOnPage = async (
    c: CircleCandidate,
    side: ViewSide,
    list: CircleCandidate[],
  ) => {
    const chosen = await refineCandidate(c)
    const refinedList = list.map((item) =>
      item.R.key === c.R.key ? chosen : item,
    )
    activateResolved({ chosen, candidates: refinedList })
    setViewSide(side)
    setViewKey(c.R.key)
    if (c.R.page !== currentStrand) swoopToPage(c.R.page)
    setError(null)
  }

  const resetAfterPickChange = () => {
    setPhase('pick')
    setFedCandidate(null)
    setInferResult(null)
    setRetrievalPool([])
    setCiteRank(null)
    setViewSide(null)
    setViewKey(null)
  }

  const runRetrieve = () => {
    void (async () => {
      const q = query.trim()
      if (!q) {
        setStatus('先输入问题')
        return
      }
      if (!canRun) {
        setStatus(
          pages.length === 0
            ? '请先上传 PDF（左上角）'
            : '文献还在处理，请稍候',
        )
        return
      }
      setBusy(true)
      setStatus('正在检索…')
      setSelectedKey(null)
      resetAfterPickChange()
      clearActive()
      setPendingQuestion(q)
      try {
        ensureIndexPersisted()
        const { candidates } = await resolveVqToCandidates(bookIndex, q, 5)
        setPool(candidates)
        if (candidates.length === 0) {
          setStatus('未找到相关段落，可换问法或等待文献处理完成')
          return
        }
        setStatus('点选一条作为进模型的依据，再开始推理')
        pushLog(`对照 · 检索 · ${candidates.length}`)
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    })()
  }

  const pickBasis = (c: CircleCandidate) => {
    setSelectedKey(c.R.key)
    resetAfterPickChange()
    clearActive()
    setStatus(`已选 ${demoPageRef(c.R.page)} · 可开始推理`)
  }

  const runInfer = () => {
    void (async () => {
      const q = query.trim()
      if (!q || !selected) {
        setStatus('请先检索并选定一条依据')
        return
      }
      setPhase('inferring')
      setBusy(true)
      setStatus('正在调用主模型…')
      setInferResult(null)
      setRetrievalPool([...pool])
      setCiteRank(null)
      setViewSide(null)
      setViewKey(null)
      try {
        const chosen = await refineCandidate(selected)
        setFedCandidate(chosen)
        activateResolved({ chosen, candidates: [chosen] })

        const excerpt = machineExcerpt(chosen)
        const bundle = buildInferBundle({
          R: chosen.R,
          sourceExcerpt: excerpt,
          question: buildDemoQuestion(q, pool),
          forbid: [],
        })

        const result = await callLlmWithBundle(bundle)
        setInferResult(result)
        if (!result.ok) {
          setStatus(result.error ?? '推理失败')
          setPhase('pick')
          return
        }

        const parsed = parseCiteRank(result.conclusion, pool.length)
        setCiteRank(parsed)
        setPhase('done')
        setStatus('推理完成 · 分别点开进模型依据与回溯 A/B')
        pushLog(
          result.usedMock
            ? '对照 · 推理 Mock'
            : `对照 · 推理 OK · 依据:#${parsed ?? '?'}`,
        )
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e))
        setPhase('pick')
      } finally {
        setBusy(false)
      }
    })()
  }

  const openTruth = () => {
    if (!fedCandidate) return
    void (async () => {
      setBusy(true)
      try {
        await focusOnPage(fedCandidate, 'truth', [fedCandidate])
        pushLog('对照 · Truth 进模型依据')
      } finally {
        setBusy(false)
      }
    })()
  }

  const openRagRef = (c: CircleCandidate) => {
    void (async () => {
      setBusy(true)
      try {
        await focusOnPage(c, 'A', retrievalPool)
        pushLog(`对照 · A 参考来源 → ${demoPageRef(c.R.page)}`)
      } finally {
        setBusy(false)
      }
    })()
  }

  const openReceipt = () => {
    if (!fedCandidate) return
    void (async () => {
      setBusy(true)
      try {
        await focusOnPage(fedCandidate, 'B', [fedCandidate])
        pushLog('对照 · B 注入回执')
      } finally {
        setBusy(false)
      }
    })()
  }

  const panelClass = solo
    ? 'interview-ab-panel interview-ab-solo'
    : 'interview-ab-panel'

  const activeKey = viewKey
  const ragPrimaryRank = citeRank ?? 1

  return (
    <aside className={panelClass} aria-label="出处对照">
      <header className="reasoning-pilot-head">
        <div className="reasoning-pilot-title">出处对照</div>
        <div className="reasoning-pilot-sub">
          {indexReady
            ? `可对照 · ${slotCount} 段`
            : demoIndexPhaseLabel(indexPhase)}
          {lockBoxes.length > 0 ? ` · 页上 ${lockBoxes.length} 处` : ''}
        </div>
      </header>

      <section className="reasoning-block">
        <h3>问题</h3>
        <textarea
          className="reasoning-input"
          rows={2}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={busy || phase === 'inferring'}
        />
        <div className="reasoning-actions">
          <button
            type="button"
            className="upload-btn"
            onClick={runRetrieve}
            disabled={busy || phase === 'inferring'}
          >
            查找相关段落
          </button>
          {selected && phase !== 'done' && (
            <button
              type="button"
              className="upload-btn reasoning-cand-on"
              onClick={runInfer}
              disabled={busy || phase === 'inferring'}
            >
              {phase === 'inferring' ? '推理中…' : '开始推理'}
            </button>
          )}
        </div>
      </section>

      {pool.length > 0 && phase !== 'done' && (
        <section className="reasoning-block">
          <h3>选定进模型依据</h3>
          <p className="interview-demo-tip">
            演示提示：优先选<strong>匹配度更低</strong>的段落（不必选 #1）。
            A 路看「检索 Top / 模型写的依据:#n」；B 路看进模型回执——对比能否对上你选定的段落。
          </p>
          <ul className="interview-pick-list">
            {pool.map((c, i) => {
              const on = c.R.key === selectedKey
              return (
                <li key={c.R.key}>
                  <button
                    type="button"
                    className={
                      on
                        ? 'interview-pick-btn interview-pick-on'
                        : 'interview-pick-btn'
                    }
                    disabled={busy || phase === 'inferring'}
                    onClick={() => pickBasis(c)}
                  >
                    <span className="reasoning-mono">{hitLine(c, i)}</span>
                    <span className="reasoning-muted">
                      {publicExcerpt(c.excerpt)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {phase === 'done' && inferResult?.ok && fedCandidate && (
        <>
          <section className="reasoning-block">
            <h3>模型回答</h3>
            <p className="reasoning-muted">
              {inferResult.conclusion.slice(0, 280)}
              {inferResult.conclusion.length > 280 ? '…' : ''}
            </p>
            {citeRank !== null && (
              <p className="reasoning-mono interview-dual-tag">
                模型标注：依据 #{citeRank}
                {citeCandidate
                  ? ` · ${demoPageRef(citeCandidate.R.page)}`
                  : ''}
              </p>
            )}
          </section>

          <section className="reasoning-block interview-truth">
            <h3>进模型依据（对照基准）</h3>
            <button
              type="button"
              className={
                viewSide === 'truth'
                  ? 'interview-pick-btn interview-pick-on'
                  : 'interview-pick-btn interview-truth-btn'
              }
              disabled={busy}
              onClick={openTruth}
            >
              <span className="reasoning-mono">
                {demoPageRef(fedCandidate.R.page)} · 当时喂入的段落
              </span>
              <span className="reasoning-muted">
                {publicExcerpt(machineExcerpt(fedCandidate))}
              </span>
            </button>
          </section>

          <section className="reasoning-block interview-dual">
            <div className="interview-dual-col" data-side="A">
              <h3>回溯 A · 参考来源</h3>
              <p className="reasoning-mono interview-dual-tag">
                检索近似 + 生成侧引用 · ★ 为
                {citeRank !== null
                  ? ` 模型写的 #${citeRank}`
                  : ' 检索 Top1（模型未写依据）'}
              </p>
              <ul className="interview-idx-list">
                {retrievalPool.map((c, i) => {
                  const rank = i + 1
                  const isPrimary = rank === ragPrimaryRank
                  const active = viewSide === 'A' && activeKey === c.R.key
                  return (
                    <li key={`a-${c.R.key}`}>
                      <button
                        type="button"
                        className={
                          active
                            ? 'interview-idx-btn interview-idx-on'
                            : isPrimary
                              ? 'interview-idx-btn interview-idx-primary'
                              : 'interview-idx-btn'
                        }
                        disabled={busy}
                        onClick={() => openRagRef(c)}
                      >
                        [#{rank}] {demoPageRef(c.R.page)}
                        {isPrimary ? ' ★' : ''}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>

            <div className="interview-dual-col" data-side="B">
              <h3>回溯 B · 进模型回执</h3>
              <p className="reasoning-mono interview-dual-tag">
                打开推理前冻结的注入段落
              </p>
              <ul className="interview-idx-list">
                <li>
                  <button
                    type="button"
                    className={
                      viewSide === 'B' && activeKey === fedCandidate.R.key
                        ? 'interview-idx-btn interview-idx-on'
                        : 'interview-idx-btn interview-idx-primary'
                    }
                    disabled={busy}
                    onClick={openReceipt}
                  >
                    {demoPageRef(fedCandidate.R.page)} ★
                  </button>
                </li>
              </ul>
            </div>
          </section>
        </>
      )}

      {status && (
        <section className="reasoning-block">
          <p className="reasoning-muted">{status}</p>
        </section>
      )}
    </aside>
  )
}
