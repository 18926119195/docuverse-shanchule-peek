import { useEffect, useMemo, useState } from 'react'
import { useDocuverse } from '../canvas/store'
import { saveBookIndex } from '../reasoning/bookIndexStore'
import { buildInferBundle } from '../reasoning/bundle'
import { useReasoning } from '../reasoning/closureStore'
import { useIndexGate } from '../reasoning/indexGate'
import { formatRLabel } from '../reasoning/intrinsicKey'
import { shortHandle } from '../reasoning/ocrSlot'
import { callLlmWithBundle } from '../reasoning/llmClient'
import {
  loadDualModelConfig,
  saveDualModelConfig,
  dualModelStatus,
  type DualModelConfig,
} from '../reasoning/modelRuntimeConfig'
import { embedConfigStatus } from '../reasoning/embedClient'
import {
  buildBookIndex,
  reembedBookIndex,
  resolveCircleToR,
  resolveVqToCandidates,
} from '../reasoning/pipelineA'
import type { BookIndex, CircleCandidate } from '../reasoning/pipelineA'
import { confirmEmphasizeMintBookKey } from '../reasoning/emphasizeMint'
import type { EmphasisEdge } from '../data/emphasis'
import { refineCandidateBoxesAsync } from '../reasoning/inkHighlight'
import { exportPageSlotDataset } from '../reasoning/slotDatasetExport'
import type { LinkType } from '../reasoning/types'

const LEAVE_LINK_OPTIONS: Array<{ id: LinkType; label: string }> = [
  { id: 'none', label: '不继承（只换对象）' },
  { id: 'contrast', label: '对比验证 contrast' },
  { id: 'depend', label: '依赖推导 depend' },
  { id: 'explore', label: '探索发现 explore' },
  { id: 'refine', label: '精炼 refine' },
  { id: 'incremental', label: '增量 incremental' },
]

export function ReasoningPilotPanel() {
  const corpus = useDocuverse((s) => s.corpus)
  const uploadLabel = useDocuverse((s) => s.uploadLabel)
  const pages = useDocuverse((s) => s.pages)
  const [pendingEmphMint, setPendingEmphMint] = useState<EmphasisEdge | null>(
    null,
  )
  const [emphMintBusy, setEmphMintBusy] = useState(false)
  const selectedEmphasisId = useDocuverse((s) => s.selectedEmphasisId)
  const emphasisEdges = useDocuverse((s) => s.emphasisEdges)
  const ocrByStrand = useDocuverse((s) => s.ocrByStrand)
  const selectEmphasis = useDocuverse((s) => s.selectEmphasis)
  const swoopToPage = useDocuverse((s) => s.swoopToPage)
  const currentStrand = useDocuverse((s) => s.currentStrand)

  const gatedIndex = useIndexGate((s) => s.bookIndex)
  const indexReady = useIndexGate((s) => s.ready)
  const indexPhase = useIndexGate((s) => s.phase)
  const indexMessage = useIndexGate((s) => s.message)
  const finalizeIndex = useIndexGate((s) => s.finalizeIndex)
  const setGatedBookIndex = useIndexGate((s) => s.setBookIndex)

  const setCorpus = useReasoning((s) => s.setCorpus)
  const activateResolved = useReasoning((s) => s.activateResolved)
  const setLockFailure = useReasoning((s) => s.setLockFailure)
  const clearActive = useReasoning((s) => s.clearActive)
  const activeR = useReasoning((s) => s.activeR)
  const activeKey = useReasoning((s) => s.activeKey)
  const activeExcerpt = useReasoning((s) => s.activeExcerpt)
  const lockCandidates = useReasoning((s) => s.lockCandidates)
  const lockError = useReasoning((s) => s.lockError)
  const closures = useReasoning((s) => s.closures)
  const phase = useReasoning((s) => s.phase)
  const pendingQuestion = useReasoning((s) => s.pendingQuestion)
  const setPendingQuestion = useReasoning((s) => s.setPendingQuestion)
  const runLocalMatch = useReasoning((s) => s.runLocalMatch)
  const forbidIds = useReasoning((s) => s.forbidIds)
  const pendingInferStay = useReasoning((s) => s.pendingInferStay)
  const consumePendingInferStay = useReasoning((s) => s.consumePendingInferStay)
  const leaveFromKey = useReasoning((s) => s.leaveFromKey)
  const previewLeaveCandidate = useReasoning((s) => s.previewLeaveCandidate)
  const cancelLeave = useReasoning((s) => s.cancelLeave)
  const confirmLeaveToResolved = useReasoning((s) => s.confirmLeaveToResolved)
  const rememberInferResult = useReasoning((s) => s.rememberInferResult)
  const pushLog = useReasoning((s) => s.pushLog)
  const lastLog = useReasoning((s) => s.lastLog)
  const lastBundle = useReasoning((s) => s.lastBundle)
  const error = useReasoning((s) => s.error)
  const setError = useReasoning((s) => s.setError)
  const setPhase = useReasoning((s) => s.setPhase)
  const pendingEdge = useReasoning((s) => s.pendingEdge)

  const [linkType, setLinkType] = useState<LinkType>('none')
  const [leavePickKey, setLeavePickKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [vqCandidates, setVqCandidates] = useState<CircleCandidate[]>([])
  const [modelCfg, setModelCfg] = useState<DualModelConfig>(() =>
    loadDualModelConfig(),
  )
  const [embedBusy, setEmbedBusy] = useState(false)
  const embed = embedConfigStatus()
  const modelStatus = dualModelStatus(modelCfg)

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
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [docId, pages, ocrByStrand, setError])

  const bookIndex: BookIndex =
    gatedIndex && gatedIndex.docId === docId ? gatedIndex : baseIndex

  useEffect(() => {
    // Keep local fallback in sync when gate empty (e.g. demo corpus)
    if (!gatedIndex || gatedIndex.docId !== docId) {
      if (baseIndex.chunks.length > 0) saveBookIndex(baseIndex)
    }
  }, [baseIndex, gatedIndex, docId])

  useEffect(() => {
    setCorpus(corpus)
  }, [corpus, setCorpus])

  const indexStats = useMemo(() => {
    let dual = 0
    let figOnly = 0
    let textOnly = 0
    for (const c of bookIndex.chunks) {
      const t = Boolean(c.faces.text)
      const f = Boolean(c.faces.fig)
      if (t && f) dual += 1
      else if (f) figOnly += 1
      else textOnly += 1
    }
    return {
      total: bookIndex.chunks.length,
      dual,
      figOnly,
      textOnly,
    }
  }, [bookIndex])

  const onSaveModels = () => {
    saveDualModelConfig(modelCfg)
    pushLog(
          `模型部署已保存 · OCR=${modelCfg.ocr.model || '空'} · 审计/推理已锁定（Flash + Qwen Embed） · 上传自动OCR=${modelCfg.autoOcrOnUpload ? '开' : '关'} · 文字层=${modelCfg.pdfHasTextLayer ? '有(跳过OCR)' : '无(走OCR)'}`,
    )
    setError(null)
  }

  const onReembed = async () => {
    setEmbedBusy(true)
    setError(null)
    try {
      const { index, usedApi } = await reembedBookIndex(bookIndex)
      setGatedBookIndex(index, true)
      pushLog(
        usedApi
          ? `审计 Embedding 已重算 V_book · ${index.chunks.length} 原子 · ${modelCfg.embed.model}`
          : `未配置审计 Key，V_book 仍用本地假向量 · ${index.chunks.length} 原子`,
      )
      if (!usedApi) {
        setError(
          '审计 Embedding 未配置 API Key：V_book 仍是假向量。请在下方「模型部署」填写后保存，再点重算。',
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setEmbedBusy(false)
    }
  }

  const onExportSlotDataset = () => {
    const n = exportPageSlotDataset({
      experimentId: `EXP-SLOT-01_${uploadLabel || docId}`,
      docId,
      page: currentStrand,
      ocr: ocrByStrand[currentStrand],
      bookIndex,
      pageTitle: pages[currentStrand]?.title,
    })
    pushLog(
      n > 0
        ? `已导出本页槽标注包 ×${n}（填 geom_ok / t_ok）`
        : '本页无槽可导出：请先切割 OCR 或重建 A1',
    )
  }

  const onRebuildStructuredIndex = async () => {
    setEmbedBusy(true)
    setError(null)
    try {
      const index = await finalizeIndex({ docId, pages, ocrByStrand })
      pushLog(
        `重建 A1（切割槽 1:1）· ${index.chunks.length} 原子 · 已重新 Embedding`,
      )
      setVqCandidates([])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setEmbedBusy(false)
    }
  }

  const findClosuresBySlotKey = useReasoning((s) => s.findClosuresBySlotKey)

  const focusCandidate = (c: CircleCandidate, list: CircleCandidate[]) => {
    void (async () => {
      const text = c.R.faces.text?.content?.trim() ?? ''
      const pageDoc = pages.find((p) => p.strandIndex === c.R.page)
      let refinedBoxes = c.boxes
      let inkNote = '跳过'
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
        inkNote = `${refined.method} · ${refined.note}`
      }
      const chosen = { ...c, boxes: refinedBoxes }
      const refinedList = list.map((item) =>
        item.R.key === c.R.key ? chosen : item,
      )

      // B1 再入：只预览，确认后再进房（不改闭包存储）
      if (useReasoning.getState().phase === 'leave_pick_target') {
        setVqCandidates(refinedList)
        setLeavePickKey(chosen.R.key)
        previewLeaveCandidate(chosen)
        if (c.R.page !== currentStrand) swoopToPage(c.R.page)
        pushLog(
          `B1 候选预览 · ${shortHandle(c.R.key)} · 墨迹 ${refinedBoxes.length} · ${inkNote}`,
        )
        setError(null)
        return
      }

      activateResolved({ chosen, candidates: refinedList })
      if (c.R.page !== currentStrand) {
        swoopToPage(c.R.page)
      }
      const hist = [
        ...new Set(
          (c.members.length > 0 ? c.members.map((m) => m.slotId) : [c.R.key])
            .flatMap((id) => findClosuresBySlotKey(id).map((cl) => cl.key)),
        ),
      ]
      pushLog(
        `定位锁 · ${shortHandle(c.R.key)} · 墨迹 ${refinedBoxes.length} · ${inkNote}` +
          (hist.length ? ` · 历史闭包 ${hist.length}` : ''),
      )
    })()
  }

  const selectedEdge = selectedEmphasisId
    ? emphasisEdges.find((e) => e.id === selectedEmphasisId)
    : undefined

  useEffect(() => {
    if (useReasoning.getState().phase === 'leave_pick_target') return
    if (!selectedEmphasisId) {
      clearActive()
      return
    }
    const edge = emphasisEdges.find((e) => e.id === selectedEmphasisId)
    if (!edge) return
    let cancelled = false
    void (async () => {
      const resolved = await resolveCircleToR(edge, bookIndex)
      if (cancelled) return
      if (!resolved.ok) {
        setLockFailure(resolved.message)
        if (resolved.reason === 'uncovered_needs_confirm') {
          setPendingEmphMint(edge)
        } else {
          setPendingEmphMint(null)
        }
        return
      }
      // mixed：指针可激活；空白仍待确认铸门后封完整 regionKey
      if (
        resolved.coverage === 'mixed_hit_and_uncovered' &&
        resolved.pendingConfirm
      ) {
        setPendingEmphMint(edge)
        pushLog(
          `混合 · 指针×${resolved.regionBinding.reuse.length} · 空白待铸 · region未齐`,
        )
      } else {
        setPendingEmphMint(null)
        if (resolved.regionBinding.regionKey) {
          pushLog(
            `强调区域已封 · members×${resolved.regionBinding.regionMemberKeys.length}`,
          )
        }
      }
      setVqCandidates([])
      const pageDoc = pages.find((p) => p.strandIndex === resolved.chosen.R.page)
      const text = resolved.chosen.R.faces.text?.content?.trim() ?? ''
      let boxes = resolved.chosen.boxes
      const refined = await refineCandidateBoxesAsync({
        text,
        page: resolved.chosen.R.page,
        fallback: resolved.chosen.boxes,
        pageChunks: pageDoc?.textChunks,
        ocrBlocks: ocrByStrand[resolved.chosen.R.page]?.blocks,
        imageUrl: pageDoc?.imageUrl,
      })
      if (cancelled) return
      boxes = refined.boxes
      pushLog(
        `圈定墨迹 · ${refined.method} · ${refined.note} · ×${boxes.length}`,
      )
      const chosen = { ...resolved.chosen, boxes }
      activateResolved({
        chosen,
        candidates: resolved.candidates.map((c) =>
          c.R.key === chosen.R.key ? chosen : c,
        ),
      })
    })()
    return () => {
      cancelled = true
    }
  }, [
    selectedEmphasisId,
    emphasisEdges,
    bookIndex,
    pages,
    ocrByStrand,
    activateResolved,
    setLockFailure,
    clearActive,
    pushLog,
  ])

  const [leaveResolved, setLeaveResolved] = useState<
    Awaited<ReturnType<typeof resolveCircleToR>> | null
  >(null)

  useEffect(() => {
    if (phase !== 'leave_pick_target' || !selectedEdge) {
      setLeaveResolved(null)
      return
    }
    let cancelled = false
    void (async () => {
      const resolved = await resolveCircleToR(selectedEdge, bookIndex)
      if (!cancelled) setLeaveResolved(resolved)
    })()
    return () => {
      cancelled = true
    }
  }, [phase, selectedEdge, bookIndex])

  const canAskVq =
    indexReady ||
    (corpus !== 'upload' &&
      bookIndex.chunks.length > 0 &&
      indexPhase !== 'ocr' &&
      indexPhase !== 'embedding' &&
      indexPhase !== 'importing')

  const leaveExcludeKey = leaveFromKey ?? activeKey

  /** B1 候选池：V_q 列表优先，否则圈定解析；始终去掉当前房对象 */
  const leavePool = useMemo(() => {
    if (phase !== 'leave_pick_target') return [] as CircleCandidate[]
    const fromVq = vqCandidates.filter((c) => c.R.key !== leaveExcludeKey)
    if (fromVq.length > 0) return fromVq
    if (leaveResolved && leaveResolved.ok) {
      return leaveResolved.candidates.filter((c) => c.R.key !== leaveExcludeKey)
    }
    return []
  }, [phase, vqCandidates, leaveResolved, leaveExcludeKey])

  const leaveChosen =
    leavePool.find((c) => c.R.key === leavePickKey) ??
    (leaveResolved && leaveResolved.ok
      ? leaveResolved.candidates.find((c) => c.R.key === leavePickKey) ??
        (leaveResolved.chosen.R.key !== leaveExcludeKey
          ? leaveResolved.chosen
          : null)
      : null) ??
    leavePool[0] ??
    null

  const fetchLeaveCandidates = async () => {
    if (!canAskVq) {
      setError('索引未就绪：无法拉取再入候选，请用 H 笔圈新区域')
      return
    }
    const q =
      pendingQuestion.trim() ||
      activeExcerpt.trim().slice(0, 160) ||
      ''
    if (!q) {
      setError('请先在提问框留下问题（或当前房有读值），再拉取再入候选')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { candidates: cands, poolSize, usedEmbedApi, expandNote } =
        await resolveVqToCandidates(bookIndex, q, 10)
      const filtered = cands.filter((c) => c.R.key !== leaveExcludeKey)
      setVqCandidates(filtered)
      setLeavePickKey(filtered[0]?.R.key ?? null)
      if (filtered[0]) previewLeaveCandidate(filtered[0])
      const expandBit = expandNote ? ` · ${expandNote}` : ''
      pushLog(
        `B1 再入候选 · 池=${poolSize} · 可用 ${filtered.length}（已排除当前房）· ${
          usedEmbedApi ? `审计 ${embed.model}` : '假向量'
        }${expandBit}`,
      )
      if (filtered.length === 0) {
        setError(
          '没有不同于当前房的检索候选：请换问题，或用 H 笔圈另一处强调。',
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // 进入退房再入时自动拉候选（不清理闭包）
  useEffect(() => {
    if (phase !== 'leave_pick_target') return
    void fetchLeaveCandidates()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on enter leave mode
  }, [phase])

  const activeClosure = activeKey ? closures[activeKey] : null
  const locked = Boolean(activeR && activeExcerpt.trim())

  const onMatch = () => {
    const q = pendingQuestion.trim()
    if (!q) {
      setError('请先输入问题')
      return
    }
    if (!locked || !activeR) {
      setError('请先圈定并命中 A 管线原文（分析对象为空则禁止推理）')
      return
    }
    void runLocalMatch(q)
  }

  const onVqAnchor = () => {
    void (async () => {
      const q = pendingQuestion.trim()
      if (!q) {
        setError('请先输入问题，再做 V_q 对象锚定')
        return
      }
      if (!canAskVq) {
        setError('索引未就绪：请先完成上传流水线（OCR → Embedding）')
        return
      }
      const leaving =
        useReasoning.getState().phase === 'leave_pick_target'
      setBusy(true)
      try {
        const {
          candidates: cands,
          weakFigOnly,
          usedEmbedApi,
          autoLockOk,
          poolSize,
          expandNote,
        } = await resolveVqToCandidates(bookIndex, q, leaving ? 10 : 8)
        if (cands.length === 0) {
          setVqCandidates([])
          setLockFailure('无可检索 A1 原子（池为空）')
          return
        }
        if (leaving) {
          const exclude = leaveFromKey ?? activeKey
          const filtered = cands.filter((c) => c.R.key !== exclude)
          setVqCandidates(filtered)
          setLeavePickKey(filtered[0]?.R.key ?? null)
          if (filtered[0]) previewLeaveCandidate(filtered[0])
          pushLog(
            `B1 V_q 再入 · 可用 ${filtered.length}/${cands.length} · ${
              usedEmbedApi ? `审计 ${embed.model}` : '假向量'
            }`,
          )
          setError(
            filtered.length === 0
              ? '检索结果都是当前房：请换问法或改用 H 笔圈新对象。'
              : null,
          )
          return
        }
        setVqCandidates(cands)
        const expandBit = expandNote ? ` · ${expandNote}` : ''
        if (autoLockOk) {
          focusCandidate(cands[0], cands)
          pushLog(
            `V_q 混合检索 · 池=${poolSize} · 断崖锁定 ${shortHandle(cands[0].R.key)} · ${
              usedEmbedApi ? `审计 ${embed.model}` : '假向量'
            }${expandBit}`,
          )
          setError(null)
        } else {
          // Do not auto-enter: user must click a candidate
          pushLog(
            `V_q 混合检索 · 池=${poolSize} · Top-${cands.length} 需确认（无断崖）· 首选 ${shortHandle(cands[0].R.key)} · ${
              usedEmbedApi ? `审计 ${embed.model}` : '假向量'
            }${expandBit}`,
          )
          setError(
            weakFigOnly
              ? '检索区分度不足且多为图脸：请点击下方候选确认，或改用圈定。'
              : '检索无断崖优势：请点击下方候选确认后再进房（已禁用自动 Top-1）。',
          )
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    })()
  }

  const onInferStay = async () => {
    const q = pendingQuestion.trim()
    if (!q || !activeR || !activeClosure || !activeExcerpt.trim()) return
    setBusy(true)
    setError(null)
    setPhase('busy')
    try {
      const forbid = activeClosure.directions.filter((d) =>
        forbidIds.includes(d.directionId),
      )
      const bundle = buildInferBundle({
        R: activeR,
        sourceExcerpt: activeExcerpt,
        question: q,
        forbid,
        edge: pendingEdge ?? undefined,
        premise:
          pendingEdge &&
          pendingEdge.linkType !== 'none' &&
          pendingEdge.premiseConclusion
            ? {
                conclusion: pendingEdge.premiseConclusion,
                pathSummary: pendingEdge.premisePath ?? '',
                fromKey: pendingEdge.fromKey,
              }
            : undefined,
      })
      pushLog(
        `打包推理 · R=[${activeR.start},${activeR.end}) · ${activeExcerpt.length}字 · forbid=${forbid.length}`,
      )
      const result = await callLlmWithBundle(bundle)
      if (!result.ok) {
        setError(result.error ?? '调用失败')
        setPhase('in_closure')
        return
      }
      await rememberInferResult({
        bundle: {
          ...bundle,
          meta: {
            ...bundle.meta,
            calledModel: !result.usedMock,
          },
        },
        question: q,
        path: result.path,
        conclusion: result.conclusion,
      })
      pushLog(result.usedMock ? '使用 Mock 模型' : '真实 LLM 调用成功')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('in_closure')
    } finally {
      setBusy(false)
    }
  }

  // 中央下方「排除方向」→ 自动留房推理（带负面清单）；不清理闭包缓存
  useEffect(() => {
    if (!pendingInferStay) return
    if (!consumePendingInferStay()) return
    void onInferStay()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only fire on pending flag
  }, [pendingInferStay])

  const onConfirmLeaveTarget = () => {
    if (phase !== 'leave_pick_target') return
    if (!leaveChosen) {
      setError(
        leaveResolved && !leaveResolved.ok
          ? leaveResolved.message
          : '新圈定未落到 A 原文，不能再入',
      )
      return
    }
    confirmLeaveToResolved(leaveChosen, linkType)
    if (selectedEdge) selectEmphasis(selectedEdge.id)
    setLeavePickKey(null)
  }

  return (
    <aside className="reasoning-pilot" aria-label="推理驾驭面板">
      <header className="reasoning-pilot-head">
        <div className="reasoning-pilot-title">推理驾驭 · Pilot</div>
        <div className="reasoning-pilot-sub">
          A1 上传即建表 · 圈定/V_q 寻址 ·{' '}
          {modelStatus.ocrReady
            ? `OCR ${modelStatus.ocrModel}`
            : 'OCR=未接'}{' '}
          ·{' '}
          {modelStatus.embedReady
            ? `审计 ${modelStatus.embedModel}`
            : '审计=假向量'}{' '}
          ·{' '}
          {modelStatus.reasonReady
            ? `推理 ${modelStatus.reasonModel}`
            : '推理=Mock'}
        </div>
      </header>

      {pendingEmphMint ? (
        <section className="reasoning-block">
          <h3>强调笔 · 空白铸门 → 区域 combo</h3>
          <p className="reasoning-muted">
            占块只指针回已有 bookKey（带门内
            rel）；仅空白可铸新门。铸完后 regionKey =
            combo(指针∪空白门)。
          </p>
          <button
            type="button"
            className="reasoning-btn"
            disabled={emphMintBusy}
            onClick={() => {
              void (async () => {
                const edge = pendingEmphMint
                if (!edge) return
                setEmphMintBusy(true)
                try {
                  const minted = await confirmEmphasizeMintBookKey({
                    edge,
                    bookIndex,
                    confirm: true,
                  })
                  if (!minted.ok) {
                    setLockFailure(minted.note)
                    pushLog(`强调铸门失败 · ${minted.note}`)
                    return
                  }
                  pushLog(minted.note)
                  setPendingEmphMint(null)
                  const again = await resolveCircleToR(edge, minted.index)
                  if (!again.ok) {
                    setLockFailure(again.message)
                    return
                  }
                  activateResolved({
                    chosen: again.chosen,
                    candidates: again.candidates,
                  })
                } finally {
                  setEmphMintBusy(false)
                }
              })()
            }}
          >
            {emphMintBusy ? '铸门中…' : '确认：铸空白门并封区域 combo'}
          </button>
        </section>
      ) : null}

      <section className="reasoning-block">
        <h3>模型部署</h3>
        <p className="reasoning-muted">
          OCR 可改；Chat / Embedding 暂时写死在服务端：DeepSeek-V4-Flash +
          Qwen3-VL-Embedding-8B（硅基流动），前端不可更换。
        </p>
        <p className="reasoning-mono">OCR / 版面（建 A1 字脸）</p>
        <input
          className="reasoning-input"
          placeholder="Base URL（默认 /api/zhipu）"
          value={modelCfg.ocr.baseUrl}
          onChange={(e) =>
            setModelCfg({
              ...modelCfg,
              ocr: { ...modelCfg.ocr, baseUrl: e.target.value },
            })
          }
        />
        <input
          className="reasoning-input"
          placeholder="API Key（空则用服务端 ZHIPU_API_KEY 代理）"
          type="password"
          autoComplete="off"
          value={modelCfg.ocr.apiKey}
          onChange={(e) =>
            setModelCfg({
              ...modelCfg,
              ocr: { ...modelCfg.ocr, apiKey: e.target.value },
            })
          }
        />
        <input
          className="reasoning-input"
          placeholder="Model（glm-ocr）"
          value={modelCfg.ocr.model}
          onChange={(e) =>
            setModelCfg({
              ...modelCfg,
              ocr: { ...modelCfg.ocr, model: e.target.value },
            })
          }
        />
        <label className="reasoning-muted" style={{ display: 'block', marginTop: 8 }}>
          <input
            type="checkbox"
            checked={modelCfg.pdfHasTextLayer}
            onChange={(e) =>
              setModelCfg({
                ...modelCfg,
                pdfHasTextLayer: e.target.checked,
              })
            }
          />{' '}
          PDF 有可用文字层（勾选后上传跳过 OCR，直接用 PDF 文字）
        </label>
        <label className="reasoning-muted" style={{ display: 'block', marginTop: 8 }}>
          <input
            type="checkbox"
            checked={modelCfg.autoOcrOnUpload}
            disabled={modelCfg.pdfHasTextLayer}
            onChange={(e) =>
              setModelCfg({
                ...modelCfg,
                autoOcrOnUpload: e.target.checked,
              })
            }
          />{' '}
          上传后对扫描页自动 OCR（最多 40 页；有文字层时无效）
        </label>
        <p className="reasoning-mono">审计（Embedding · 已锁定）</p>
        <input
          className="reasoning-input"
          disabled
          readOnly
          value={modelCfg.embed.baseUrl}
        />
        <input
          className="reasoning-input"
          disabled
          readOnly
          type="password"
          value="（服务端写死，浏览器不持 Key）"
        />
        <input
          className="reasoning-input"
          disabled
          readOnly
          value={modelCfg.embed.model}
        />
        <p className="reasoning-mono">推理（Chat · 已锁定）</p>
        <input
          className="reasoning-input"
          disabled
          readOnly
          value={modelCfg.reason.baseUrl}
        />
        <input
          className="reasoning-input"
          disabled
          readOnly
          type="password"
          value="（服务端写死，浏览器不持 Key）"
        />
        <input
          className="reasoning-input"
          disabled
          readOnly
          value={modelCfg.reason.model}
        />
        <div className="reasoning-actions">
          <button type="button" className="upload-btn" onClick={onSaveModels}>
            保存部署（仅 OCR）
          </button>
          <button
            type="button"
            className="upload-btn"
            onClick={() => void onReembed()}
            disabled={embedBusy || bookIndex.chunks.length === 0}
          >
            {embedBusy ? '重算中…' : '用审计模型重算 V_book'}
          </button>
          <button
            type="button"
            className="upload-btn"
            onClick={() => void onRebuildStructuredIndex()}
            disabled={embedBusy || pages.length === 0}
          >
            重建 A1 索引
          </button>
          <button
            type="button"
            className="upload-btn"
            onClick={onExportSlotDataset}
            disabled={pages.length === 0}
          >
            导出本页槽标注包
          </button>
        </div>
        <p className="reasoning-muted">
          状态：OCR {modelStatus.ocrReady ? '可用' : '未接'} / 审计{' '}
          {modelStatus.embedReady ? '已接' : '未接'} / 推理{' '}
          {modelStatus.reasonReady ? '已接' : 'Mock'}
          {modelStatus.pdfHasTextLayer
            ? ' · 文字层：有（跳过 OCR）'
            : modelStatus.autoOcrOnUpload
              ? ' · 上传自动 OCR 开'
              : ''}
          · OCR 为切割即登记（1 块=1 槽）；导出 JSON 填 geom_ok / t_ok 采数据集
        </p>
      </section>

      <section className="reasoning-block">
        <h3>A1 索引</h3>
        <p className="reasoning-muted">
          门控：{indexPhase}
          {indexReady ? ' ✓就绪' : ' · 未就绪'} — {indexMessage}
        </p>
        <p className="reasoning-muted">
          原子 {indexStats.total} · 两面一体 {indexStats.dual} · 仅图{' '}
          {indexStats.figOnly} · 仅字 {indexStats.textOnly}
        </p>
        {indexStats.total > 0 &&
          indexStats.figOnly === indexStats.total && (
            <p className="reasoning-error">
              全书无文字原子：PDF 文字层为空或 OCR 未出字。V_q
              内容检索弱；请检查 OCR 或圈定目标页。
            </p>
          )}
      </section>

      <section className="reasoning-block">
        <h3>当前分析对象</h3>
        {activeR && locked ? (
          <>
            <p className="reasoning-mono">{formatRLabel(activeR)}</p>
            <p className="reasoning-muted">{shortHandle(activeR.key)}</p>
            <p className="reasoning-muted">
              方向数：{activeClosure?.directions.length ?? 0} · phase={phase} · A块{' '}
              {activeR.chunkIds.length}
            </p>
          </>
        ) : (
          <p className="reasoning-muted">
            用 H 笔圈选，或先输入问题点「V_q 锚定」。有页图的文字锁强制带图脸。
          </p>
        )}
      </section>

      <section className="reasoning-block">
        <h3>A1 机器读值（审计）</h3>
        {locked && activeR ? (
          <>
            <p className="reasoning-muted">
              kind={activeR.kind}
              {activeR.faces.text ? ' · 文字脸' : ''}
              {activeR.faces.fig
                ? ` · 图脸(${activeR.faces.fig.figId})`
                : ''}{' '}
              · 人侧请看页上绿虚线框（真视觉）
            </p>
            <pre className="reasoning-excerpt">{activeExcerpt}</pre>
          </>
        ) : (
          <p className="reasoning-muted">
            {lockError ?? '尚未锁定。模型不会收到圈外文字或整页 OCR。'}
          </p>
        )}
      </section>

      {lockCandidates.length > 1 &&
        vqCandidates.length === 0 &&
        phase !== 'leave_pick_target' && (
        <section className="reasoning-block">
          <h3>灰度书区 · 确认精确 R*</h3>
          <p className="reasoning-muted">
            圈定命中不相邻的多段原文。进房键必须是精确区间，请点选一段。
          </p>
          <ul className="reasoning-list">
            {lockCandidates.map((c) => (
              <li key={c.R.key}>
                <button
                  type="button"
                  className={
                    c.R.key === activeKey
                      ? 'upload-btn reasoning-cand-on'
                      : 'upload-btn'
                  }
                  onClick={() => focusCandidate(c, lockCandidates)}
                >
                  [{c.R.kind}] {shortHandle(c.R.key)} · score=
                  {c.score.toFixed(2)}
                  {c.members.length > 1 && (
                    <span className="reasoning-muted">
                      {' '}
                      · 组合×{c.members.length}
                    </span>
                  )}
                </button>
                <p className="reasoning-muted">
                  {c.excerpt.slice(0, 80)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="reasoning-block">
        <h3>提问</h3>
        {!canAskVq && (
          <p className="reasoning-error">
            等待索引就绪后才能 V_q（上传 → OCR → Embedding）。圈定仍可随时用。
          </p>
        )}
        <textarea
          className="reasoning-input"
          rows={3}
          value={pendingQuestion}
          onChange={(e) => setPendingQuestion(e.target.value)}
          placeholder={
            canAskVq
              ? '输入问题 → V_q 锚定 → 点候选跳页高亮…'
              : '索引未就绪，请先完成上传流水线…'
          }
          disabled={!canAskVq || busy}
        />
        <div className="reasoning-actions">
          <button
            type="button"
            className="upload-btn"
            onClick={onVqAnchor}
            disabled={!canAskVq || busy}
          >
            {phase === 'leave_pick_target' ? 'V_q 再入候选' : 'V_q 锚定对象'}
          </button>
          <button
            type="button"
            className="upload-btn"
            onClick={onMatch}
            disabled={!locked || busy}
          >
            房内比对方向
          </button>
          <button
            type="button"
            className="upload-btn"
            onClick={() => void onInferStay()}
            disabled={!locked || busy || phase === 'leave_pick_target'}
          >
            {busy ? '推理中…' : '留房推理（可带负面清单）'}
          </button>
        </div>
      </section>

      {vqCandidates.length > 0 && phase !== 'leave_pick_target' && (
        <section className="reasoning-block">
          <h3>V_q 预选 · 点选确认槽（返回哈希 + 读值 + AABB）</h3>
          <p className="reasoning-muted">
            预选搜槽内 T，返回 slot 门牌；高亮用排放 AABB；旁注读值
            start%–end%。点选后可查历史对话闭包。
          </p>
          <ul className="reasoning-list">
            {vqCandidates.map((c) => (
              <li key={`vq-${c.R.key}`}>
                <button
                  type="button"
                  className={
                    c.R.key === activeKey
                      ? 'upload-btn reasoning-cand-on'
                      : 'upload-btn'
                  }
                  onClick={() => focusCandidate(c, vqCandidates)}
                >
                  [{c.R.kind}] score={c.score.toFixed(3)} ·{' '}
                  {shortHandle(c.R.key)}
                </button>
                <p className="reasoning-muted">{c.excerpt.slice(0, 120)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {phase === 'leave_pick_target' && (
        <section className="reasoning-block leave">
          <h3>B1 再入 · 选新对象</h3>
          <p className="reasoning-muted">
            下拉只决定「旧结论跟不跟」；请先在下方点选再入候选（已自动排除当前房），或
            H 笔圈另一处。选好后再确认再入。
          </p>
          <div className="reasoning-actions">
            <button
              type="button"
              className="upload-btn"
              onClick={() => void fetchLeaveCandidates()}
              disabled={busy}
            >
              {busy ? '拉取中…' : '重新拉取再入候选'}
            </button>
          </div>
          {leaveResolved && !leaveResolved.ok && (
            <p className="reasoning-error">{leaveResolved.message}</p>
          )}
          {leavePool.length > 0 ? (
            <ul className="reasoning-list">
              {leavePool.map((c) => (
                <li key={c.R.key}>
                  <button
                    type="button"
                    className={
                      (leaveChosen?.R.key ?? leavePickKey) === c.R.key
                        ? 'upload-btn reasoning-cand-on'
                        : 'upload-btn'
                    }
                    onClick={() => focusCandidate(c, leavePool)}
                  >
                    [{shortHandle(c.R.key)}] score={c.score.toFixed(3)} ·{' '}
                    {c.excerpt.slice(0, 36)}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="reasoning-muted">
              尚无再入候选。点「重新拉取再入候选」，或用 H 笔圈新强调。
            </p>
          )}
          {leaveChosen && (
            <pre className="reasoning-excerpt">{leaveChosen.excerpt}</pre>
          )}
          <label className="reasoning-muted" htmlFor="leave-link-type">
            与旧房的关系（继承方式）
          </label>
          <select
            id="leave-link-type"
            className="reasoning-select"
            value={linkType}
            onChange={(e) => {
              const v = e.target.value
              const hit = LEAVE_LINK_OPTIONS.find((o) => o.id === v)
              if (hit) setLinkType(hit.id)
            }}
          >
            {LEAVE_LINK_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <div className="reasoning-actions">
            <button
              type="button"
              className="upload-btn"
              onClick={onConfirmLeaveTarget}
              disabled={!leaveChosen || busy}
            >
              确认再入所选对象
            </button>
            <button type="button" className="upload-btn" onClick={cancelLeave}>
              取消
            </button>
          </div>
        </section>
      )}

      {lastBundle && (
        <section className="reasoning-block">
          <h3>最近 Bundle 摘要</h3>
          <pre className="reasoning-pre">
            {JSON.stringify(
              {
                key: lastBundle.closureKey,
                interval: [lastBundle.R.start, lastBundle.R.end],
                excerptChars: lastBundle.sourceExcerpt.length,
                forbid: lastBundle.forbidDirections.length,
                edge: lastBundle.edge?.linkType ?? null,
                calledModel: lastBundle.meta.calledModel,
              },
              null,
              2,
            )}
          </pre>
        </section>
      )}

      {error && <p className="reasoning-error">{error}</p>}

      <section className="reasoning-block">
        <h3>日志</h3>
        <ul className="reasoning-log">
          {lastLog.map((line, i) => {
            const sep = line.indexOf('|')
            const text = sep > 0 ? line.slice(sep + 1) : line
            return <li key={`log-${i}`}>{text}</li>
          })}
        </ul>
      </section>
    </aside>
  )
}
