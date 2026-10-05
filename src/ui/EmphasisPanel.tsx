import { useEffect, useState } from 'react'
import { useDocuverse } from '../canvas/store'
import { isPublicDemo } from '../demoMode'
import {
  buildEmphasisPacket,
  downloadEmphasisPacketJson,
} from '../data/emphasisCatalog'

export function EmphasisPanel() {
  const emphasizeMode = useDocuverse((s) => s.emphasizeMode)
  const setEmphasizeMode = useDocuverse((s) => s.setEmphasizeMode)
  const draft = useDocuverse((s) => s.emphasisDraftPoints)
  const clearEmphasisDraft = useDocuverse((s) => s.clearEmphasisDraft)
  const edges = useDocuverse((s) => s.emphasisEdges)
  const links = useDocuverse((s) => s.emphasisLinks)
  const selectedId = useDocuverse((s) => s.selectedEmphasisId)
  const updateEmphasisReading = useDocuverse((s) => s.updateEmphasisReading)
  const deleteEmphasis = useDocuverse((s) => s.deleteEmphasis)
  const emphasisLinkFromId = useDocuverse((s) => s.emphasisLinkFromId)
  const setEmphasisLinkFrom = useDocuverse((s) => s.setEmphasisLinkFrom)
  const deleteEmphasisLink = useDocuverse((s) => s.deleteEmphasisLink)
  const promptReadingForId = useDocuverse((s) => s.promptReadingForId)
  const clearPromptReading = useDocuverse((s) => s.clearPromptReading)
  const pipelineSteps = useDocuverse((s) => s.pipelineSteps)
  const pages = useDocuverse((s) => s.pages)
  const openOverview = useDocuverse((s) => s.openOverview)
  const enterTetrahedronLens = useDocuverse((s) => s.enterTetrahedronLens)
  const openLinkFocus = useDocuverse((s) => s.openLinkFocus)
  const [packetBusy, setPacketBusy] = useState(false)

  const selected = edges.find((e) => e.id === selectedId)
  const [readingDraft, setReadingDraft] = useState(selected?.reading ?? '')
  const linkFrom = edges.find((e) => e.id === emphasisLinkFromId)

  useEffect(() => {
    setReadingDraft(selected?.reading ?? '')
  }, [selected?.id, selected?.reading])

  return (
    <section className="hud-panel emphasis">
      <h2>强调 · 建联</h2>
      <p className="hint">
        建联改用右下角<strong>星图</strong>：页面隐去，只剩强调坐标。选中强调后按{' '}
        <kbd>Enter</kbd> 锁为 A，再左键点另一颗星完成紫线并进入中线构建。右键环视星图。
      </p>

      <div className="ocr-edit-toolbar">
        <button
          type="button"
          className={`upload-btn${emphasizeMode ? ' active' : ''}`}
          onClick={() => setEmphasizeMode(!emphasizeMode)}
        >
          {emphasizeMode
            ? '星图+笔 · 开（Space+G 关）'
            : '打开星图+笔 · Space+G'}
        </button>
        <button
          type="button"
          className="upload-btn"
          disabled={edges.length === 0}
          onClick={() => enterTetrahedronLens(0)}
          title="四面体四角机位：任一角看对面共面，找回散落的强调"
        >
          四面体全览
        </button>
      </div>

      {emphasizeMode && (
        <div className="emphasis-draw-status">
          <p className="meta">
            全局批注：Space+G 同开星图+笔（不可单独出）。瞄准选定可圈定页 → 左键落笔；笔画自交或回到起点附近即密封。输入文本时快捷键不触发。
            {draft.length > 0 ? ` · ${draft.length} 点` : ''}
          </p>
          <div className="ocr-edit-toolbar">
            <button
              type="button"
              className="corpus-chip"
              onClick={() => clearEmphasisDraft()}
            >
              清空笔迹
            </button>
          </div>
        </div>
      )}

      {promptReadingForId && selectedId === promptReadingForId && (
        <div className="emphasis-prompt-reading">
          <p className="meta">
            已密封强调域。可选：写一句理解，方便以后自然语言搜索（可跳过）。
          </p>
          <button
            type="button"
            className="corpus-chip"
            onClick={() => clearPromptReading()}
          >
            稍后写 / 跳过
          </button>
        </div>
      )}

      <h3 className="bond-subhead">建联状态</h3>
      <p className="hint">
        {emphasisLinkFromId
          ? `A 已锁在 s${linkFrom?.strandIndex ?? '?'} · Space+G 开星图点 B`
          : selectedId
            ? '已选强调 · 按 Enter 锁为 A'
            : '先在页上点选一个强调，或点星图导航'}
      </p>
      {emphasisLinkFromId && (
        <button
          type="button"
          className="corpus-chip"
          onClick={() => setEmphasisLinkFrom(null)}
        >
          取消端点 A
        </button>
      )}
      {selectedId && !emphasisLinkFromId && (
        <button
          type="button"
          className="upload-btn"
          style={{ marginTop: 6 }}
          onClick={() => setEmphasisLinkFrom(selectedId)}
        >
          当前选中 → 作端点 A（等同 Enter）
        </button>
      )}
      {selected && (
        <button
          type="button"
          className="corpus-chip danger"
          style={{ marginTop: 6, marginLeft: 6 }}
          onClick={() => {
            if (window.confirm('删除此强调边及其射线？')) {
              deleteEmphasis(selected.id)
            }
          }}
        >
          删除当前强调
        </button>
      )}

      <h3 className="bond-subhead">关联台（可选）</h3>
      <p className="hint">仍可用图卡台做二次筛选；日常建联请用星图。</p>
      <div className="overview-seed-row">
        <button
          type="button"
          className="corpus-chip"
          disabled={edges.length === 0}
          onClick={() => openOverview(edges.map((e) => e.id))}
        >
          打开关联台 · 全部
        </button>
      </div>

      {links.length > 0 && (
        <>
          <h3 className="bond-subhead">已连紫线 {links.length}</h3>
          <ul className="bond-roster">
            {links.map((l) => {
              const from = edges.find((e) => e.id === l.fromEmphasisId)
              const to = edges.find((e) => e.id === l.toEmphasisId)
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    className="corpus-chip"
                    onClick={() => openLinkFocus(l.id)}
                    title="进入构建镜头"
                  >
                    s{from?.strandIndex ?? '?'}→s{to?.strandIndex ?? '?'}
                    {l.note ? ` · ${l.note.slice(0, 12)}` : ''}
                  </button>
                  <button
                    type="button"
                    className="corpus-chip danger bond-del"
                    onClick={() => deleteEmphasisLink(l.id)}
                  >
                    删
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {selected && (
        <label className="bond-comment-label">
          理解（reading）— 可空；有则利于以后自然语言搜索
          <textarea
            className="bond-comment-input"
            rows={3}
            value={readingDraft}
            placeholder="在此背景下，我强调的是……我的理解是……"
            onChange={(e) => setReadingDraft(e.target.value)}
          />
          <button
            type="button"
            className="corpus-chip"
            style={{ marginTop: 6 }}
            onClick={() => updateEmphasisReading(selected.id, readingDraft)}
          >
            保存理解{isPublicDemo ? '' : ' → 写入工序'}
          </button>
        </label>
      )}

      {!isPublicDemo && (
        <>
          <h3 className="bond-subhead">送模数据包</h3>
          <button
            type="button"
            className="corpus-chip"
            disabled={packetBusy || edges.length === 0}
            onClick={() => {
              setPacketBusy(true)
              void buildEmphasisPacket(edges, links, pages)
                .then((packet) => {
                  downloadEmphasisPacketJson(packet)
                })
                .finally(() => setPacketBusy(false))
            }}
          >
            {packetBusy ? '生成中…' : '导出 catalog JSON'}
          </button>

          <h3 className="bond-subhead">
            工序时间线（近 {Math.min(12, pipelineSteps.length)} 步）
          </h3>
          <ol className="pipeline-log">
            {[...pipelineSteps]
              .slice(-12)
              .reverse()
              .map((s) => (
                <li key={s.id}>
                  <span className={`pipe-kind ${s.kind}`}>{s.kind}</span>
                  <span className="pipe-actor">{s.actor}</span>
                  <span className="pipe-sum">{s.summary}</span>
                </li>
              ))}
          </ol>
          {pipelineSteps.length === 0 && (
            <p className="hint">上传 PDF 或画圈后，转化工序会出现在这里。</p>
          )}
        </>
      )}
    </section>
  )
}
