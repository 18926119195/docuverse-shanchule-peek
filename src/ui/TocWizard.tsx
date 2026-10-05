/**
 * 建库向导 · 目录分节（toc_map）：
 * ① 选目录页 → LLM 出标题+印码范围
 * ② 核对印码
 * ③ 选正文页输入印码+机器码校准 → strand
 * ④ 确认挂 memberKeys
 * 浮窗可隐去/重显，方便看 PDF 细节。
 */

import { useEffect, useMemo, useState } from 'react'
import { useDocuverse } from '../canvas/store'
import { useIndexGate } from '../reasoning/indexGate'
import {
  emptyTocEntry,
  fillEndPrinted,
  type TocEntryDraft,
} from '../reasoning/tocParse'
import {
  applyPrintedCalibration,
  runTocMapLlm,
} from '../reasoning/tocMapLlm'
import {
  calibrationNote,
  makeCalibration,
} from '../reasoning/pageCalibration'
import { atomSearchText } from '../reasoning/hybridRetrieve'
import { peekPageImageDataUri } from '../data/pageImageVault'
import type { PageDocument } from '../zigzag/types'

type Step = 'pick_toc' | 'edit' | 'calibrate' | 'preview'

function pageThumbSrc(p: PageDocument): string | null {
  if (p.imageUrl?.trim()) return p.imageUrl
  const vault = peekPageImageDataUri(p.strandIndex)
  return vault?.trim() || null
}

export function TocWizard() {
  const open = useIndexGate((s) => s.tocWizardOpen)
  const revealEpoch = useIndexGate((s) => s.tocWizardRevealEpoch)
  const tocStatus = useIndexGate((s) => s.tocStatus)
  const bookIndex = useIndexGate((s) => s.bookIndex)
  const pageCalibration = useIndexGate((s) => s.pageCalibration)
  const setPageCalibration = useIndexGate((s) => s.setPageCalibration)
  const confirmTocWizard = useIndexGate((s) => s.confirmTocWizard)
  const skipTocWizard = useIndexGate((s) => s.skipTocWizard)
  const closeTocWizard = useIndexGate((s) => s.closeTocWizard)

  const pages = useDocuverse((s) => s.pages)
  const currentStrand = useDocuverse((s) => s.currentStrand)
  const swoopToPage = useDocuverse((s) => s.swoopToPage)
  const ensurePageForAudit = useDocuverse((s) => s.ensurePageForAudit)
  const ocrByStrand = useDocuverse((s) => s.ocrByStrand)

  const [step, setStep] = useState<Step>('pick_toc')
  const [tocStrands, setTocStrands] = useState<number[]>([])
  const [entries, setEntries] = useState<TocEntryDraft[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [panelHidden, setPanelHidden] = useState(false)
  const [anchorPrintedInput, setAnchorPrintedInput] = useState('')
  /** 双页展开时同机牌上的另一印码 */
  const [anchorPrintedOtherInput, setAnchorPrintedOtherInput] = useState('')
  const [anchorStrandInput, setAnchorStrandInput] = useState('0')
  /** 1=单页扫描；2=一机牌两印码（本书常见） */
  const [printedPerStrand, setPrintedPerStrand] = useState<1 | 2>(2)

  useEffect(() => {
    if (!open) return
    setPanelHidden(false)
    setErr(null)
  }, [open, revealEpoch])

  useEffect(() => {
    if (!open) return
    setStep('pick_toc')
    setStatus(null)
  }, [open])

  useEffect(() => {
    setAnchorStrandInput(String(currentStrand))
  }, [currentStrand])

  const maxStrand = useMemo(() => {
    if (!bookIndex?.chunks.length) return Math.max(0, pages.length - 1)
    return Math.max(0, ...bookIndex.chunks.map((c) => c.page))
  }, [bookIndex, pages.length])

  const currentPage = useMemo(
    () => pages.find((p) => p.strandIndex === currentStrand) ?? null,
    [pages, currentStrand],
  )
  const currentPreviewSrc = currentPage ? pageThumbSrc(currentPage) : null

  /** 点缩略图：先物化页图再跳转/多选 */
  const focusStrand = async (strand: number, toggleSelect: boolean) => {
    setErr(null)
    const r = await ensurePageForAudit(strand, { focus: true })
    swoopToPage(strand)
    if (toggleSelect) toggleTocStrand(strand)
    if (!r.ok) {
      setStatus(`strand ${strand}：${r.note}（可隐去浮窗看球上页）`)
    }
  }

  useEffect(() => {
    if (!open) return
    void ensurePageForAudit(currentStrand, { focus: false })
  }, [open, currentStrand, ensurePageForAudit])

  const remappedEntries = useMemo(() => {
    if (!pageCalibration || entries.length === 0) return entries
    return applyPrintedCalibration(entries, pageCalibration, maxStrand)
  }, [entries, pageCalibration, maxStrand])

  const previewRows = useMemo(() => {
    if (remappedEntries.length === 0 || !bookIndex) return []
    return remappedEntries.map((e) => {
      const startPage = e.startStrand ?? 0
      const endPage = e.endStrand ?? startPage
      let keyCount = 0
      for (const c of bookIndex.chunks) {
        if (c.page >= startPage && c.page <= endPage) keyCount += 1
      }
      return { ...e, startPage, endPage, keyCount }
    })
  }, [remappedEntries, bookIndex])

  if (!open || tocStatus === 'confirmed') return null

  const pageText = (strand: number): string => {
    const ocr = ocrByStrand[strand]
    if (ocr?.blocks?.length) {
      return ocr.blocks.map((b) => b.content || '').join('\n')
    }
    const page = pages.find((p) => p.strandIndex === strand)
    if (page?.textChunks?.length) {
      return page.textChunks.map((c) => c.content).join('\n')
    }
    if (bookIndex) {
      return bookIndex.chunks
        .filter((c) => c.page === strand)
        .map((c) => atomSearchText(c))
        .join('\n')
    }
    return page?.text ?? ''
  }

  const toggleTocStrand = (s: number) => {
    setTocStrands((prev) =>
      prev.includes(s)
        ? prev.filter((x) => x !== s)
        : [...prev, s].sort((a, b) => a - b),
    )
  }

  const onSaveCalibration = () => {
    const printed = Number(anchorPrintedInput)
    const strand = Number(anchorStrandInput)
    if (!Number.isFinite(printed) || printed < 0) {
      setErr('请输入书上印码（阿拉伯数字）')
      return
    }
    if (!Number.isFinite(strand) || strand < 0 || strand > maxStrand) {
      setErr(`机器码 strand 须在 0…${maxStrand}`)
      return
    }
    let other: number | undefined
    if (printedPerStrand === 2) {
      const o = Number(anchorPrintedOtherInput)
      if (!Number.isFinite(o) || o < 0) {
        setErr('双页展开：请填本机牌上的两个印码（左/右）')
        return
      }
      if (Math.abs(o - printed) !== 1 && Math.abs(o - printed) !== 0) {
        // 允许非相邻（偶发错页），但提醒；硬拒相同外的大跨度
        if (Math.abs(o - printed) > 2) {
          setErr('双页展开：两印码应是本机牌左右页（通常相差 1）')
          return
        }
      }
      other = o
    }
    const cal = makeCalibration(Math.floor(strand), printed, {
      printedPerStrand,
      anchorPrintedOther: other,
    })
    setPageCalibration(cal)
    setErr(null)
    setStatus(calibrationNote(cal))
  }

  const onRunTocMap = async () => {
    setErr(null)
    if (!bookIndex) {
      setErr('尚无 A1 索引')
      return
    }
    if (tocStrands.length === 0) {
      setErr('请至少点选一页与目录有关的渲染页')
      return
    }
    setBusy(true)
    try {
      const res = await runTocMapLlm({
        tocStrands,
        pageText,
        bookIndex,
        maxStrand,
        calibration: null,
        onProgress: (m) => setStatus(m),
      })
      setEntries(fillEndPrinted(res.entries))
      setStatus(res.note)
      if (!res.ok) setErr(res.note)
      else setErr(null)
      setStep('edit')
    } finally {
      setBusy(false)
    }
  }

  const onConfirm = () => {
    setErr(null)
    if (!pageCalibration) {
      setErr('缺少印码→strand 校准')
      return
    }
    const mapped = applyPrintedCalibration(
      fillEndPrinted(entries),
      pageCalibration,
      maxStrand,
    )
    const r = confirmTocWizard(mapped)
    if (!r.ok) setErr(r.error || '确认失败')
  }

  const thumbLimit = pages.length

  if (panelHidden) {
    return (
      <button
        type="button"
        className="toc-wizard-restore"
        onClick={() => setPanelHidden(false)}
        title="重新显示目录向导"
      >
        目录向导 · 点此恢复
        {step === 'calibrate' ? '（校准中）' : ''}
      </button>
    )
  }

  return (
    <div
      className={
        step === 'calibrate' || step === 'pick_toc'
          ? 'toc-wizard-backdrop toc-wizard-backdrop-soft'
          : 'toc-wizard-backdrop'
      }
      role="dialog"
      aria-modal={step !== 'calibrate' && step !== 'pick_toc'}
    >
      <div className="toc-wizard">
        <header className="toc-wizard-head">
          <div>
            <div className="toc-wizard-title">建库向导 · 目录分节（toc_map）</div>
            <div className="toc-wizard-sub">
              选目录页 → LLM 出标题+印码 → 再校准（印码↔机器码）→ strand 挂
              bookKey
            </div>
          </div>
          <div className="toc-wizard-actions" style={{ gap: 6 }}>
            <button
              type="button"
              className="fanout-btn"
              onClick={() => setPanelHidden(true)}
              title="隐去浮窗，方便看 PDF"
            >
              隐去浮窗
            </button>
            <button
              type="button"
              className="fanout-btn"
              onClick={() => skipTocWizard()}
            >
              跳过
            </button>
          </div>
        </header>

        <nav className="toc-wizard-steps">
          <span className={step === 'pick_toc' ? 'on' : ''}>① 选目录</span>
          <span className={step === 'edit' ? 'on' : ''}>② 核对印码</span>
          <span className={step === 'calibrate' ? 'on' : ''}>③ 校准</span>
          <span className={step === 'preview' ? 'on' : ''}>④ 确认</span>
        </nav>

        {step === 'pick_toc' && (
          <section className="toc-wizard-body">
            <p className="toc-wizard-p">
              多选与目录有关的渲染页（总目/续目等）。本步<strong>不校准</strong>
              ；LLM 只读目录上的印码页范围。浮窗已半透明，可直接看背后球上页；也可「隐去浮窗」。
              当前球上：strand {currentStrand}。
            </p>
            <div className="toc-preview-pane">
              {currentPreviewSrc ? (
                <img src={currentPreviewSrc} alt={`strand ${currentStrand}`} />
              ) : (
                <div className="toc-preview-empty">
                  strand {currentStrand} 暂无页图
                  <br />
                  点下方缩略图或「隐去浮窗」看球
                </div>
              )}
              <div className="toc-preview-caption">
                预览 · strand {currentStrand} · 机器第 {currentStrand + 1} 张
              </div>
            </div>
            <div className="toc-thumb-row toc-thumb-row-lg">
              {pages.slice(0, thumbLimit).map((p) => {
                const src = pageThumbSrc(p)
                return (
                  <button
                    key={p.strandIndex}
                    type="button"
                    className={
                      tocStrands.includes(p.strandIndex)
                        ? 'toc-thumb on'
                        : 'toc-thumb'
                    }
                    onClick={() => void focusStrand(p.strandIndex, true)}
                    title={`strand ${p.strandIndex}${src ? '' : '（点选物化页图）'}`}
                  >
                    {src ? (
                      <img src={src} alt="" />
                    ) : (
                      <span className="toc-thumb-miss">s{p.strandIndex}</span>
                    )}
                    <em>{p.strandIndex}</em>
                  </button>
                )
              })}
            </div>
            <p className="toc-wizard-p">
              已选目录 strand×{tocStrands.length}
              {tocStrands.length
                ? `：${tocStrands.join(', ')}`
                : '（无）'}
            </p>
            <div className="toc-wizard-actions">
              <button
                type="button"
                className="fanout-btn"
                onClick={() => void focusStrand(currentStrand, true)}
              >
                选中当前页
              </button>
              <button
                type="button"
                className="fanout-btn primary"
                disabled={busy || tocStrands.length === 0}
                onClick={() => void onRunTocMap()}
              >
                {busy ? 'toc_map 分节中…' : '送入 toc_map（读印码）→'}
              </button>
            </div>
            {status ? <p className="toc-wizard-p">{status}</p> : null}
          </section>
        )}

        {step === 'edit' && (
          <section className="toc-wizard-body">
            <p className="toc-wizard-p">
              核对章名与目录中的<strong>印码</strong>起止（还不是
              strand）。下一页再选正文页做校准。
            </p>
            <div className="toc-entry-table">
              <div className="toc-entry-head toc-entry-head-strand">
                <span>章/节名</span>
                <span>起印码</span>
                <span>止印码</span>
                <span />
              </div>
              {entries.map((e, i) => (
                <div key={e.id} className="toc-entry-row toc-entry-row-strand">
                  <input
                    value={e.title}
                    onChange={(ev) => {
                      const v = ev.target.value
                      setEntries((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, title: v } : r)),
                      )
                    }}
                  />
                  <input
                    type="number"
                    value={e.startPrinted}
                    onChange={(ev) => {
                      const n = Number(ev.target.value)
                      setEntries((rows) =>
                        rows.map((r, j) =>
                          j === i
                            ? {
                                ...r,
                                startPrinted: Number.isFinite(n)
                                  ? n
                                  : r.startPrinted,
                              }
                            : r,
                        ),
                      )
                    }}
                  />
                  <input
                    type="number"
                    value={e.endPrinted}
                    onChange={(ev) => {
                      const n = Number(ev.target.value)
                      setEntries((rows) =>
                        rows.map((r, j) =>
                          j === i
                            ? {
                                ...r,
                                endPrinted: Number.isFinite(n)
                                  ? n
                                  : r.endPrinted,
                              }
                            : r,
                        ),
                      )
                    }}
                  />
                  <button
                    type="button"
                    className="fanout-linkish"
                    onClick={() =>
                      setEntries((rows) => rows.filter((_, j) => j !== i))
                    }
                  >
                    删
                  </button>
                </div>
              ))}
            </div>
            <div className="toc-wizard-actions">
              <button
                type="button"
                className="fanout-btn"
                onClick={() =>
                  setEntries((rows) => {
                    const last = rows.at(-1)
                    return [
                      ...rows,
                      {
                        ...emptyTocEntry(0),
                        startPrinted: (last?.endPrinted ?? 0) + 1,
                        endPrinted: (last?.endPrinted ?? 0) + 1,
                      },
                    ]
                  })
                }
              >
                + 加一节
              </button>
              <button
                type="button"
                className="fanout-btn"
                onClick={() => setStep('pick_toc')}
              >
                ← 重选目录页
              </button>
              <button
                type="button"
                className="fanout-btn primary"
                onClick={() => {
                  setEntries(fillEndPrinted(entries))
                  setStep('calibrate')
                  setPanelHidden(false)
                }}
              >
                下一步：校准 →
              </button>
            </div>
          </section>
        )}

        {step === 'calibrate' && (
          <section className="toc-wizard-body">
            <p className="toc-wizard-p">
              转到任一<strong>正文页</strong>（可隐去浮窗细看），填该书
              <strong>印码</strong>与<strong>机器码 strand</strong>
              （默认跟当前球上页）。保存后才能把印码换成 strand。
            </p>
            <p className="toc-wizard-p">
              本书若一机牌含两印刷页，选「双页展开」并填<strong>本机牌上左右两个印码</strong>
              （勿用目录页、勿只填其中一个却当 1:1）。
            </p>
            <p className="toc-wizard-p">
              当前球上：strand {currentStrand}（机器第 {currentStrand + 1}{' '}
              张）。点缩略图可跳页。
            </p>
            <div className="toc-preview-pane">
              {currentPreviewSrc ? (
                <img src={currentPreviewSrc} alt={`strand ${currentStrand}`} />
              ) : (
                <div className="toc-preview-empty">
                  strand {currentStrand} 暂无页图 · 点缩略图物化或隐去浮窗看球
                </div>
              )}
            </div>
            <div className="toc-thumb-row toc-thumb-row-lg">
              {pages.slice(0, thumbLimit).map((p) => {
                const src = pageThumbSrc(p)
                return (
                  <button
                    key={p.strandIndex}
                    type="button"
                    className={
                      currentStrand === p.strandIndex
                        ? 'toc-thumb on'
                        : 'toc-thumb'
                    }
                    onClick={() => void focusStrand(p.strandIndex, false)}
                    title={`strand ${p.strandIndex}`}
                  >
                    {src ? (
                      <img src={src} alt="" />
                    ) : (
                      <span className="toc-thumb-miss">s{p.strandIndex}</span>
                    )}
                    <em>{p.strandIndex}</em>
                  </button>
                )
              })}
            </div>
            <div
              className="toc-wizard-actions"
              style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
            >
              <label>
                版式{' '}
                <select
                  value={printedPerStrand}
                  onChange={(ev) =>
                    setPrintedPerStrand(
                      Number(ev.target.value) === 1 ? 1 : 2,
                    )
                  }
                >
                  <option value={2}>双页展开（1 strand = 2 印码）</option>
                  <option value={1}>单页（1 strand = 1 印码）</option>
                </select>
              </label>
              <label>
                {printedPerStrand === 2 ? '左印码' : '书上印码'}{' '}
                <input
                  type="number"
                  value={anchorPrintedInput}
                  onChange={(ev) => setAnchorPrintedInput(ev.target.value)}
                  style={{ width: 72 }}
                />
              </label>
              {printedPerStrand === 2 ? (
                <label>
                  右印码{' '}
                  <input
                    type="number"
                    value={anchorPrintedOtherInput}
                    onChange={(ev) =>
                      setAnchorPrintedOtherInput(ev.target.value)
                    }
                    style={{ width: 72 }}
                  />
                </label>
              ) : null}
              <label>
                机器码 strand{' '}
                <input
                  type="number"
                  value={anchorStrandInput}
                  onChange={(ev) => setAnchorStrandInput(ev.target.value)}
                  style={{ width: 72 }}
                />
              </label>
              <button
                type="button"
                className="fanout-btn"
                onClick={() => setAnchorStrandInput(String(currentStrand))}
              >
                用当前页
              </button>
              <button
                type="button"
                className="fanout-btn primary"
                onClick={onSaveCalibration}
              >
                保存校准
              </button>
            </div>
            {pageCalibration ? (
              <p className="toc-wizard-p">{calibrationNote(pageCalibration)}</p>
            ) : (
              <p className="toc-wizard-p">尚未校准</p>
            )}
            <div className="toc-wizard-actions">
              <button
                type="button"
                className="fanout-btn"
                onClick={() => setStep('edit')}
              >
                ← 改印码
              </button>
              <button
                type="button"
                className="fanout-btn primary"
                disabled={!pageCalibration}
                onClick={() => setStep('preview')}
              >
                预览 key 分配 →
              </button>
            </div>
          </section>
        )}

        {step === 'preview' && (
          <section className="toc-wizard-body">
            <p className="toc-wizard-p">
              确认后按校准后的 strand 闭集写 pageRange；memberKeys = 页界 ∩ 当前
              A1。
              {pageCalibration
                ? ` ${calibrationNote(pageCalibration)}`
                : ''}
            </p>
            <ul className="toc-preview-list">
              {previewRows.map((r) => (
                <li key={r.id}>
                  <strong>{r.title}</strong>
                  <span>
                    {' '}
                    · 印码 {r.startPrinted}–{r.endPrinted} → strand{' '}
                    {r.startPage}–{r.endPage} · key×{r.keyCount}
                  </span>
                </li>
              ))}
            </ul>
            <div className="toc-wizard-actions">
              <button
                type="button"
                className="fanout-btn"
                onClick={() => setStep('calibrate')}
              >
                ← 校准
              </button>
              <button
                type="button"
                className="fanout-btn primary"
                onClick={onConfirm}
              >
                确认目录并分配 key
              </button>
            </div>
          </section>
        )}

        {err ? (
          <p className="toc-wizard-p" style={{ color: '#b00' }}>
            {err}
          </p>
        ) : null}
        <div className="toc-wizard-actions">
          <button
            type="button"
            className="fanout-btn"
            onClick={() => closeTocWizard()}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
