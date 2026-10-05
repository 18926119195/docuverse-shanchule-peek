import { useRef, useState } from 'react'
import { isPublicDemo } from '../demoMode'
import { importPdfFile } from '../data/pdfImport'
import {
  ingestScannedPdfParallel,
  ZHIPU_GLM_OCR_CONCURRENCY,
} from '../data/pdfPagePipeline'
import {
  assertBookIndexSane,
  applyCorpusKeyLineage,
  buildCorpusPack,
  corpusPackToRuntime,
  downloadCorpusPack,
  parseCorpusPack,
} from '../data/corpusPack'
import { clearPageImageVault } from '../data/pageImageVault'
import {
  loadDualModelConfig,
  saveDualModelConfig,
} from '../reasoning/modelRuntimeConfig'
import { useIndexGate } from '../reasoning/indexGate'
import {
  a1DsChatPromptStub,
  exportA1ForDeepSeek,
  exportA1ForDeepSeekJsonl,
} from '../reasoning/a1DsExport'
import { useDocuverse } from '../canvas/store'
import { useAttentionIo } from '../reasoning/attentionIoStore'

export function PdfUploadPanel() {
  const inputRef = useRef<HTMLInputElement>(null)
  const packInputRef = useRef<HTMLInputElement>(null)
  const applyUploadedUniverse = useDocuverse((s) => s.applyUploadedUniverse)
  const clearWorkspaceAnnotations = useDocuverse(
    (s) => s.clearWorkspaceAnnotations,
  )
  const setUploadProgress = useDocuverse((s) => s.setUploadProgress)
  const uploadProgress = useDocuverse((s) => s.uploadProgress)
  const corpus = useDocuverse((s) => s.corpus)
  const uploadLabel = useDocuverse((s) => s.uploadLabel)
  const setImporting = useIndexGate((s) => s.setImporting)
  const finalizeIndex = useIndexGate((s) => s.finalizeIndex)
  const hydrateFromCorpusPack = useIndexGate((s) => s.hydrateFromCorpusPack)
  const setIndexError = useIndexGate((s) => s.setError)
  const resetIndex = useIndexGate((s) => s.reset)
  const indexPhase = useIndexGate((s) => s.phase)
  const indexMessage = useIndexGate((s) => s.message)
  const indexReady = useIndexGate((s) => s.ready)
  const tocStatus = useIndexGate((s) => s.tocStatus)
  const openTocWizard = useIndexGate((s) => s.openTocWizard)
  const semanticIndex = useIndexGate((s) => s.semanticIndex)

  const mergeIngestPage = useDocuverse((s) => s.mergeIngestPage)
  const syncPages = useIndexGate((s) => s.syncPages)

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [bgIngest, setBgIngest] = useState(false)
  const [exportNote, setExportNote] = useState<string | null>(null)
  const [pdfHasTextLayer, setPdfHasTextLayer] = useState(
    () => loadDualModelConfig().pdfHasTextLayer,
  )
  const bookIndex = useIndexGate((s) => s.bookIndex)

  const persistTextLayerFlag = (hasText: boolean) => {
    setPdfHasTextLayer(hasText)
    const cfg = loadDualModelConfig()
    saveDualModelConfig({ ...cfg, pdfHasTextLayer: hasText })
  }

  const onPickPdf = async (file: File | undefined) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setError('请选择 PDF 文件')
      return
    }
    setError(null)
    setBusy(true)
    resetIndex()
    clearPageImageVault()
    useAttentionIo.getState().clearAll()
    setImporting('正在打开 PDF…')
    try {
      const cfg = loadDualModelConfig()
      const shouldOcr = cfg.autoOcrOnUpload !== false && !pdfHasTextLayer

      if (shouldOcr) {
        // 扫描件：头尾硬闸 → 立刻建库开目录；中间页后台滑动 OCR + 增量 sync
        useIndexGate.setState({
          phase: 'ocr',
          message: '目录优先 · 头/尾 OCR…',
          ready: false,
        })
        const labelGuess = file.name.replace(/\.pdf$/i, '') || 'Uploaded PDF'
        const docId = `upload:${labelGuess}`
        let edgesUnlocked = false
        const pendingSync = new Set<number>()
        let syncTimer: number | null = null
        let syncChain: Promise<void> = Promise.resolve()

        const flushMiddleSync = () => {
          if (pendingSync.size === 0) return
          const indices = [...pendingSync]
          pendingSync.clear()
          syncChain = syncChain
            .then(async () => {
              const st = useDocuverse.getState()
              const bi = useIndexGate.getState().bookIndex
              const docIdSync =
                bi?.docId?.trim() ||
                `upload:${st.uploadLabel || labelGuess}`
              await syncPages({
                docId: docIdSync,
                pages: st.pages,
                ocrByStrand: st.ocrByStrand,
                pageIndices: indices,
              })
            })
            .catch((e) => {
              console.warn('[ingest] middle syncPages', e)
            })
        }

        const scheduleMiddleSync = (strand: number) => {
          pendingSync.add(strand)
          if (syncTimer != null) return
          syncTimer = window.setTimeout(() => {
            syncTimer = null
            flushMiddleSync()
          }, 1200)
        }

        const ingested = await ingestScannedPdfParallel({
          file,
          docId,
          concurrency: ZHIPU_GLM_OCR_CONCURRENCY,
          edgeConcurrency: ZHIPU_GLM_OCR_CONCURRENCY,
          onProgress: (p) => {
            setUploadProgress({
              current: p.done,
              total: Math.max(p.total, 1),
              message: p.message,
            })
            // 目录向导已开后不再把 phase 打回 ocr，避免打断 toc_map
            if (!edgesUnlocked) {
              useIndexGate.setState({
                phase: 'ocr',
                message: p.message,
              })
            }
          },
          onEdgesReady: async (snap) => {
            applyUploadedUniverse({
              pages: snap.pages,
              connections: [],
              label: snap.label,
              ocrByStrand: snap.ocrByStrand,
            })
            setUploadProgress({
              current: Object.keys(snap.ocrByStrand).length,
              total: snap.total,
              message: `目录页已齐 · 打开向导；中间 ${snap.total - snap.edgeStrands.length} 页后台…`,
            })
            // 只建已 OCR 的头尾页索引，禁止 stub 中间页铸假 bookKey
            const edgePages = snap.pages.filter(
              (p) => snap.ocrByStrand[p.strandIndex],
            )
            await finalizeIndex({
              docId: `upload:${snap.label}`,
              pages: edgePages,
              ocrByStrand: snap.ocrByStrand,
            })
            edgesUnlocked = true
            setBgIngest(true)
            setBusy(false)
          },
          onPage: (page, ocr) => {
            if (!edgesUnlocked) return
            mergeIngestPage(page, ocr)
            scheduleMiddleSync(page.strandIndex)
          },
        })

        if (syncTimer != null) {
          window.clearTimeout(syncTimer)
          syncTimer = null
        }
        flushMiddleSync()
        await syncChain

        if (!edgesUnlocked) {
          applyUploadedUniverse({
            pages: ingested.pages,
            connections: ingested.connections,
            label: ingested.label,
            ocrByStrand: ingested.ocrByStrand,
          })
          const ocrPages = ingested.pages.filter(
            (p) => ingested.ocrByStrand[p.strandIndex],
          )
          await finalizeIndex({
            docId: `upload:${ingested.label}`,
            pages: ocrPages,
            ocrByStrand: ingested.ocrByStrand,
          })
        } else {
          // 终局再扫一遍未 sync 的中间页（保险）；docId 与 bookIndex 对齐
          const st = useDocuverse.getState()
          const bi = useIndexGate.getState().bookIndex
          const docIdFinal =
            bi?.docId?.trim() || `upload:${ingested.label}`
          const have = new Set(bi?.chunks.map((c) => c.page) ?? [])
          const missing = Object.keys(st.ocrByStrand)
            .map(Number)
            .filter((s) => st.ocrByStrand[s] && !have.has(s))
          if (missing.length > 0) {
            await syncPages({
              docId: docIdFinal,
              pages: st.pages,
              ocrByStrand: st.ocrByStrand,
              pageIndices: missing,
            })
          }
        }

        if (ingested.failed > 0) {
          setError(
            `部分中间页未能识别（${ingested.failed}）· 目录/已有页可继续；可稍后补识别`,
          )
        }
        setBgIngest(false)
      } else {
        // 文字层：顺序渲全书，跳过 OCR
        const result = await importPdfFile(file, (p) => {
          setUploadProgress({
            current: p.current,
            total: p.total,
            message: p.message,
          })
        })
        applyUploadedUniverse(result)
        setUploadProgress({
          current: 0,
          total: 1,
          message: '正在整理文献…',
        })
        const docId = `upload:${result.label}`
        const { pages, ocrByStrand } = useDocuverse.getState()
        await finalizeIndex({ docId, pages, ocrByStrand })
      }
      setUploadProgress(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : '导入失败'
      setError(msg)
      setIndexError(msg)
      setUploadProgress(null)
      setBgIngest(false)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const onPickPack = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    setBusy(true)
    resetIndex()
    useAttentionIo.getState().clearAll()
    setImporting('正在载入语料包…')
    try {
      const text = await file.text()
      let raw: unknown
      try {
        raw = JSON.parse(text) as unknown
      } catch {
        throw new Error('语料包不是合法 JSON')
      }
      const parsed = parseCorpusPack(raw)
      if (!parsed.ok) throw new Error(parsed.error)
      if (!assertBookIndexSane(parsed.pack.bookIndex)) {
        throw new Error('语料包 bookIndex 损坏')
      }
      const runtime = corpusPackToRuntime(parsed.pack, { lean: true })
      if (
        runtime.keyLineage &&
        runtime.keyLineage.docId &&
        runtime.keyLineage.docId !== runtime.docId &&
        runtime.keyLineage.docId !== runtime.bookIndex.docId
      ) {
        console.warn(
          '语料包 lineage.docId 与 bookIndex.docId 不一致，仍水合',
          runtime.keyLineage.docId,
          runtime.bookIndex.docId,
        )
      }
      applyUploadedUniverse({
        pages: runtime.pages,
        connections: [],
        label: runtime.label,
        ocrByStrand: runtime.ocrByStrand,
        letterWorkbench: true,
      })
      hydrateFromCorpusPack({
        bookIndex: runtime.bookIndex,
        semanticIndex: runtime.semanticIndex,
      })
      const lin = applyCorpusKeyLineage(runtime.keyLineage)
      const nQ = runtime.keyLineage
        ? Object.keys(runtime.keyLineage.settledQueries ?? {}).length
        : 0
      setExportNote(
        `瘦载入 · ${runtime.bookIndex.chunks.length} 段 · 页图金库 ${runtime.stashedImages} · ${lin.note} · qk×${nQ}`,
      )
      setUploadProgress(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : '语料包载入失败'
      setError(msg)
      setIndexError(msg)
      setUploadProgress(null)
    } finally {
      setBusy(false)
      if (packInputRef.current) packInputRef.current.value = ''
    }
  }

  const onExportCorpusPack = async () => {
    if (!bookIndex) return
    setExportNote('正在打包语料（含页图金库）…')
    try {
      const { pages, ocrByStrand, uploadLabel: label } = useDocuverse.getState()
      const { pack, imageStats } = await buildCorpusPack({
        label: label || bookIndex.docId.replace(/^upload:/, '') || 'corpus',
        docId: bookIndex.docId,
        bookIndex,
        ocrByStrand,
        semanticIndex,
        pages,
        includeImages: true,
        includeKeyLineage: true,
      })
      downloadCorpusPack(pack)
      const nQ = Object.keys(pack.keyLineage?.settledQueries ?? {}).length
      const nPath = pack.keyLineage?.paths?.length ?? 0
      const denom = Math.max(imageStats.ocrPages, imageStats.pagesTotal, 1)
      const cover =
        imageStats.imagesPacked / denom
      const coverWarn =
        cover < 0.9
          ? ' · 金库覆盖不足，审计预取仍会失败'
          : ''
      setExportNote(
        `已导出语料包 v2 · 页×${imageStats.pagesTotal} · 段×${bookIndex.chunks.length}` +
          ` · 页图×${imageStats.imagesPacked}/${denom}（金库${imageStats.vaultSize}）` +
          ` · 长期记忆 qk×${nQ} path×${nPath}` +
          coverWarn,
      )
      if (cover < 0.9) {
        setError(
          `页图覆盖 ${imageStats.imagesPacked}/${denom} < 90%：金库不足，瘦载入后审计预取会失败。请在 OCR 全书后再导出。`,
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出语料包失败')
      setExportNote(null)
    }
  }

  return (
    <section className="hud-panel upload">
      <h2>上传 PDF</h2>
      {isPublicDemo ? (
        <p className="meta">上传后可在右侧输入问题并对照出处</p>
      ) : (
        <p className="meta">
          扫描件：头/尾各 8 页齐后立刻开目录向导与 toc_map；中间页后台识别（在途≤
          {ZHIPU_GLM_OCR_CONCURRENCY}）
        </p>
      )}
      <label className="meta" style={{ display: 'block', marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={pdfHasTextLayer}
          disabled={busy}
          onChange={(e) => persistTextLayerFlag(e.target.checked)}
        />{' '}
        PDF 有可用文字层（勾选则跳过 OCR，直接用 PDF 文字）
      </label>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => void onPickPdf(e.target.files?.[0])}
      />
      <input
        ref={packInputRef}
        type="file"
        accept="application/json,.json,.docuverse.json"
        hidden
        onChange={(e) => void onPickPack(e.target.files?.[0])}
      />
      <button
        type="button"
        className="upload-btn"
        disabled={busy || bgIngest}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? '目录页处理中…' : bgIngest ? '中间页后台中…' : '选择 PDF 文件'}
      </button>
      <button
        type="button"
        className="corpus-chip"
        disabled={busy || bgIngest}
        title="载入此前导出的 .docuverse.json（瘦载入：索引先开工，页图按审计再出）"
        onClick={() => packInputRef.current?.click()}
      >
        载入语料包
      </button>
      <button
        type="button"
        className="corpus-chip"
        disabled={busy}
        title="清除标注；页面保留"
        onClick={() => {
          if (
            !window.confirm(
              '清除全部强调 / 连线标注？页面会保留，可继续导入。',
            )
          ) {
            return
          }
          clearWorkspaceAnnotations()
          resetIndex()
        }}
      >
        清空标注
      </button>
      {(busy || indexPhase === 'ocr' || indexPhase === 'embedding') && (
        <p className="meta">{indexMessage}</p>
      )}
      {indexReady && (
        <p className="meta" style={{ color: '#5cffb1' }}>
          ✓ {indexMessage}
        </p>
      )}
      {indexReady && bookIndex && (
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button
            type="button"
            className="corpus-chip"
            title="导出语料包 v2：材料 + key 母系长期记忆（问线/门账），下次载入可判复用"
            onClick={() => void onExportCorpusPack()}
          >
            导出语料包
          </button>
          <button
            type="button"
            className="corpus-chip"
            title="导出全局一份 Markdown：完整 KEY+原文（不截断、不拆包），可直接丢给 DeepSeek"
            onClick={() => {
              try {
                const r = exportA1ForDeepSeek(bookIndex)
                setExportNote(
                  `已导出全局 .md · ${r.rowCount} 行 KEY+全文（单文件，未拆包）`,
                )
              } catch (e) {
                setError(e instanceof Error ? e.message : '导出失败')
              }
            }}
          >
            导出 A1→DS（.md）
          </button>
          <button
            type="button"
            className="corpus-chip"
            title="导出全局一份 JSONL：每行 {key,T} 全文（不截断、不拆包）"
            onClick={() => {
              try {
                const r = exportA1ForDeepSeekJsonl(bookIndex)
                setExportNote(
                  `已导出全局 .jsonl · ${r.rowCount} 行 KEY+全文（单文件，未拆包）`,
                )
              } catch (e) {
                setError(e instanceof Error ? e.message : '导出失败')
              }
            }}
          >
            导出 A1→DS（.jsonl）
          </button>
          <button
            type="button"
            className="corpus-chip"
            title="复制一段可贴进 DeepSeek 对话框的规则+问题壳"
            onClick={() => {
              void navigator.clipboard
                .writeText(a1DsChatPromptStub(''))
                .then(() => setExportNote('已复制 DS 提问壳（规则+空问题）'))
                .catch(() => setError('剪贴板写入失败'))
            }}
          >
            复制 DS 提问壳
          </button>
        </div>
      )}
      {exportNote && (
        <p className="meta" style={{ color: '#9ecbff' }}>
          {exportNote}
        </p>
      )}
      {indexReady && tocStatus === 'pending' && (
        <p className="meta" style={{ color: '#ffcc66' }}>
          目录向导待完成（点选目录页 → toc_map）{' '}
          <button type="button" className="corpus-chip" onClick={() => openTocWizard()}>
            打开向导
          </button>
        </p>
      )}
      {tocStatus === 'skipped' && (
        <p className="meta" style={{ color: '#ff8a8a' }}>
          ⚠ 已跳过目录 · 无 TOC 闭集（提问走全书 BM25）{' '}
          <button type="button" className="corpus-chip" onClick={() => openTocWizard()}>
            重新打开向导
          </button>
        </p>
      )}
      {tocStatus === 'confirmed' && (
        <p className="meta" style={{ color: '#5cffb1' }}>
          ✓ 目录已确认 · 归属随页回填（memberKeys×
          {semanticIndex?.sections.reduce(
            (n, s) => n + (s.memberKeys?.length ?? 0),
            0,
          ) ?? 0}
          ）
        </p>
      )}
      {uploadProgress && (
        <div className="upload-progress">
          <div className="bar">
            <span
              style={{
                width:
                  uploadProgress.total > 0
                    ? `${Math.min(100, (100 * uploadProgress.current) / uploadProgress.total)}%`
                    : '30%',
              }}
            />
          </div>
          <p className="meta">{uploadProgress.message}</p>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {corpus === 'upload' && uploadLabel && (
        <p className="meta">当前：{uploadLabel}</p>
      )}
    </section>
  )
}
