import { useState } from 'react'
import { useDocuverse } from '../canvas/store'
import { isPublicDemo } from '../demoMode'
import {
  buildEmphasisPacket,
  downloadEmphasisPacketJson,
} from '../data/emphasisCatalog'
import {
  runCoarseFullPdfSearch,
  runLocalReadingSearch,
  runStructureCatalogSearch,
  type AgentSearchResult,
} from '../data/emphasisAgent'

export function EmphasisAgentPanel() {
  const edges = useDocuverse((s) => s.emphasisEdges)
  const links = useDocuverse((s) => s.emphasisLinks)
  const pages = useDocuverse((s) => s.pages)
  const navigateToEmphasis = useDocuverse((s) => s.navigateToEmphasis)
  const openOverview = useDocuverse((s) => s.openOverview)
  const appendPipelineNote = useDocuverse((s) => s.appendPipelineNote)
  const runAiProposeAndLinkDemo = useDocuverse((s) => s.runAiProposeAndLinkDemo)
  const aiDemoRunning = useDocuverse((s) => s.aiDemoRunning)
  const aiDemoStatus = useDocuverse((s) => s.aiDemoStatus)

  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AgentSearchResult | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportNote, setExportNote] = useState<string | null>(null)

  const setLastAgentHitIds = useDocuverse((s) => s.setLastAgentHitIds)

  const openHits = (ids: string[]) => {
    if (ids.length === 0) return
    setLastAgentHitIds(ids)
    if (ids.length >= 2) {
      openOverview(ids)
      return
    }
    navigateToEmphasis(ids[0])
  }

  const onLocalSearch = () => {
    setError(null)
    const r = runLocalReadingSearch(edges, query)
    setResult(r)
    if (r.ids.length > 0) {
      openHits(r.ids)
      appendPipelineNote(`Agent① 评论搜：命中 ${r.ids.length} · ${query.slice(0, 40)}`)
    }
  }

  const onStructureSearch = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await runStructureCatalogSearch(query, edges, links, pages)
      setResult(r)
      if (r.ids.length > 0) {
        openHits(r.ids)
        appendPipelineNote(
          `Agent② 结构目录：命中 ${r.ids.length} · ${query.slice(0, 40)}`,
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onCascade = async () => {
    setBusy(true)
    setError(null)
    try {
      const local = runLocalReadingSearch(edges, query)
      if (local.ids.length > 0) {
        setResult({ ...local, stage: 'done' })
        openHits(local.ids)
        appendPipelineNote(
          `Agent 早停①：评论命中 ${local.ids.length} · ${query.slice(0, 40)}`,
        )
        return
      }
      const struct = await runStructureCatalogSearch(
        query,
        edges,
        links,
        pages,
      )
      if (struct.ids.length > 0) {
        setResult({ ...struct, stage: 'done' })
        openHits(struct.ids)
        appendPipelineNote(
          `Agent 早停②：结构命中 ${struct.ids.length} · ${query.slice(0, 40)}`,
        )
        return
      }
      setResult({
        ...struct,
        needsFullPdfConfirm: true,
        reason:
          struct.reason ||
          '①② 均未命中。若继续搜全书，请显式确认（不会自动执行）。',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onConfirmFullPdf = async () => {
    const ok = window.confirm(
      '将进行粗粒度全书检索（页文本摘要送模）。确认继续？',
    )
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      const r = await runCoarseFullPdfSearch(query, edges, pages)
      setResult(r)
      if (r.ids.length > 0) openHits(r.ids)
      appendPipelineNote(`Agent③ 全书粗搜（已确认）· ${query.slice(0, 40)}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onExportPacket = async () => {
    setExportBusy(true)
    setExportNote(null)
    try {
      const packet = await buildEmphasisPacket(edges, links, pages, {
        maxOutlinedImages: Math.min(12, edges.length),
      })
      downloadEmphasisPacketJson(packet)
      setExportNote(
        `已导出目录 JSON（含 ${packet.entries.length} 边、${packet.outlinedImages.length} 张描边图元数据）`,
      )
      appendPipelineNote('导出强调送模数据包（catalog）')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExportBusy(false)
    }
  }

  const onAiProposeDemo = async () => {
    setError(null)
    const r = await runAiProposeAndLinkDemo()
    if (!r) {
      const msg = useDocuverse.getState().aiDemoStatus
      if (msg) setError(msg)
    }
  }

  return (
    <section className="hud-panel emphasis-agent">
      <h2>Agent · 搜强调 / 提议圈注</h2>
      <p className="hint">
        ①评论 → ②结构+图 → ③全书（须确认）。下面「演示」会让 Agent
        自己在两页上画圈、写入 reading，并建联进入构建镜头。
      </p>

      <div className="agent-demo-card">
        <p className="meta">AI 交互演示（本地几何提议，不调模型）</p>
        <button
          type="button"
          className="upload-btn"
          disabled={aiDemoRunning || pages.length < 2}
          onClick={() => void onAiProposeDemo()}
        >
          {aiDemoRunning
            ? 'Agent 正在画圈 / 建联…'
            : '演示：Agent 画圈并建联'}
        </button>
        {aiDemoStatus && <p className="hint">{aiDemoStatus}</p>}
        {pages.length < 2 && (
          <p className="ocr-error">需要至少两页文档才能演示跨页建联</p>
        )}
      </div>

      <label className="bond-comment-label">
        问句
        <textarea
          className="bond-comment-input"
          rows={2}
          value={query}
          placeholder="找我强调过交错切片的那一块…"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      <div className="ocr-edit-toolbar" style={{ flexWrap: 'wrap' }}>
        <button
          type="button"
          className="corpus-chip"
          disabled={busy || !query.trim() || aiDemoRunning}
          onClick={onLocalSearch}
        >
          ① 搜评论
        </button>
        <button
          type="button"
          className="corpus-chip"
          disabled={busy || !query.trim() || aiDemoRunning}
          onClick={() => void onStructureSearch()}
        >
          ② 结构+图
        </button>
        <button
          type="button"
          className="upload-btn"
          disabled={busy || !query.trim() || aiDemoRunning}
          onClick={() => void onCascade()}
        >
          {busy ? '检索中…' : '级联（早停）'}
        </button>
      </div>

      <div className="ocr-edit-toolbar">
        {!isPublicDemo && (
          <button
            type="button"
            className="corpus-chip"
            disabled={exportBusy || edges.length === 0}
            onClick={() => void onExportPacket()}
          >
            {exportBusy ? '打包中…' : '导出 catalog 数据包'}
          </button>
        )}
      </div>
      {exportNote && <p className="meta">{exportNote}</p>}

      {error && <p className="ocr-error">{error}</p>}

      {result && (
        <div className="agent-result">
          <p className="meta">
            阶段 {result.stage} · {result.reason}
          </p>
          {result.ids.length === 0 ? (
            <p className="hint">无命中 id</p>
          ) : (
            <div className="agent-result-actions">
              <button
                type="button"
                className="upload-btn"
                onClick={() => {
                  setLastAgentHitIds(result.ids)
                  openOverview(result.ids)
                }}
              >
                进入关联台（{result.ids.length} 块）· 先选 A 再选 B
              </button>
              {result.ids.length === 1 && (
                <button
                  type="button"
                  className="corpus-chip"
                  onClick={() => navigateToEmphasis(result.ids[0])}
                >
                  仅飞向这一块
                </button>
              )}
              <p className="hint">
                在总览里点两块原渲染抽出图即可连跨页射线。
              </p>
            </div>
          )}
          {result.needsFullPdfConfirm && (
            <button
              type="button"
              className="upload-btn"
              disabled={busy}
              onClick={() => void onConfirmFullPdf()}
              style={{ marginTop: 8 }}
            >
              确认后搜全书（③）
            </button>
          )}
        </div>
      )}

      <p className="hint">强调边共 {edges.length} · 射线 {links.length}</p>
      {edges.length >= 2 && (
        <button
          type="button"
          className="corpus-chip"
          onClick={() => openOverview(edges.map((e) => e.id))}
        >
          全部强调 → 关联台
        </button>
      )}
    </section>
  )
}
