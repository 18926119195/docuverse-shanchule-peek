import { useEffect } from 'react'
import { useDocuverse } from '../canvas/store'
import { EmphasisPanel } from './EmphasisPanel'
import { BondBeamPanel } from './BondBeamPanel'
import { EmphasisAgentPanel } from './EmphasisAgentPanel'
import { isTextEditingTarget } from './textEditing'

/**
 * Esc floating workbench: 强调笔 · 用户射线/评论 · Agent
 * Space 仅作 Space+G 修饰键：星图+强调笔同开通关（不可单独出）。
 * Fixed layer above WebGL canvas (z-index 200+).
 */
export function WorkbenchPalette() {
  const open = useDocuverse((s) => s.workbenchOpen)
  const tab = useDocuverse((s) => s.workbenchTab)
  const setWorkbenchOpen = useDocuverse((s) => s.setWorkbenchOpen)
  const setWorkbenchTab = useDocuverse((s) => s.setWorkbenchTab)
  const toggleWorkbench = useDocuverse((s) => s.toggleWorkbench)
  const overviewOpen = useDocuverse((s) => s.overviewOpen)
  const openOverview = useDocuverse((s) => s.openOverview)
  const emphasisEdges = useDocuverse((s) => s.emphasisEdges)
  const currentStrand = useDocuverse((s) => s.currentStrand)
  const lastAgentHitIds = useDocuverse((s) => s.lastAgentHitIds)
  const selectedEmphasisId = useDocuverse((s) => s.selectedEmphasisId)
  const emphasizeMode = useDocuverse((s) => s.emphasizeMode)
  const setEmphasizeMode = useDocuverse((s) => s.setEmphasizeMode)
  const clearEmphasisDraft = useDocuverse((s) => s.clearEmphasisDraft)
  const draftLen = useDocuverse((s) => s.emphasisDraftPoints.length)
  const emphasisLinkFromId = useDocuverse((s) => s.emphasisLinkFromId)
  const setEmphasisLinkFrom = useDocuverse((s) => s.setEmphasisLinkFrom)
  const enterTetrahedronLens = useDocuverse((s) => s.enterTetrahedronLens)
  const runAiProposeAndLinkDemo = useDocuverse((s) => s.runAiProposeAndLinkDemo)
  const aiDemoRunning = useDocuverse((s) => s.aiDemoRunning)
  const pages = useDocuverse((s) => s.pages)
  const linkFrom = emphasisEdges.find((e) => e.id === emphasisLinkFromId)

  // 开笔即全局十字圈瞄准（不依赖悬停页卡）
  useEffect(() => {
    document.body.classList.toggle('emphasize-pen-on', emphasizeMode)
    if (!emphasizeMode) {
      document.body.style.cursor = ''
    }
    return () => {
      document.body.classList.remove('emphasize-pen-on')
    }
  }, [emphasizeMode])

  useEffect(() => {
    let spaceHeld = false

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextEditingTarget(e.target)) return

      const isSpace = e.code === 'Space' || e.key === ' '
      if (isSpace) {
        // Space 仅作修饰键（Space+G），松开不再开工作台
        if (e.repeat) {
          e.preventDefault()
          e.stopPropagation()
          return
        }
        e.preventDefault()
        e.stopPropagation()
        spaceHeld = true
        return
      }

      // Space+G：星图·建联 + 强调笔同开通关（不可单独出）
      if (
        spaceHeld &&
        (e.key === 'g' || e.key === 'G') &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        e.stopPropagation()
        useDocuverse.getState().toggleStarMapWithG()
        return
      }

      if (e.key === 'Escape') {
        if (useDocuverse.getState().emphasisLinkFromId) {
          e.preventDefault()
          useDocuverse.getState().setEmphasisLinkFrom(null)
          return
        }
        if (useDocuverse.getState().linkFocusId) {
          return
        }
        if (useDocuverse.getState().overviewOpen) {
          return
        }
        if (emphasizeMode || useDocuverse.getState().starMapOpen) {
          e.preventDefault()
          useDocuverse.getState().setStarMapAndPen(false)
          return
        }
        // 无更高优先级关闭项时：Esc 开关工作台
        e.preventDefault()
        toggleWorkbench()
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ') {
        spaceHeld = false
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [
    toggleWorkbench,
    emphasizeMode,
    clearEmphasisDraft,
    setEmphasizeMode,
  ])

  if (overviewOpen) return null

  const pageIds = emphasisEdges
    .filter((e) => e.strandIndex === currentStrand)
    .map((e) => e.id)

  return (
    <div className="workbench-root" aria-live="polite">
      {emphasisLinkFromId && !open && (
        <div className="workbench-chip link-waiting-chip" role="status">
          <span>建联 · 等待端点 B</span>
          <span className="meta">
            A 在 s{linkFrom?.strandIndex ?? '?'} · Space+G 开星图后左键点另一颗星
          </span>
          <button
            type="button"
            className="corpus-chip"
            onClick={() => setEmphasisLinkFrom(null)}
          >
            取消 A Esc
          </button>
          <button
            type="button"
            className="corpus-chip"
            onClick={() => setWorkbenchOpen(true)}
          >
            工作台
          </button>
        </div>
      )}

      {emphasizeMode && !open && (
        <div className="workbench-chip" role="status">
          <span>强调笔 · 开</span>
          <span className="meta">
            {emphasisLinkFromId
              ? '笔仍开 · 瞄准页再画对端（同一份页数据）'
              : 'Space+G 开笔+星图 · 瞄准选定页落笔 · 拉链并行'}
            {draftLen > 0 ? ` · ${draftLen} 点` : ''}
          </span>
          <button
            type="button"
            className="corpus-chip"
            onClick={() => {
              useDocuverse.getState().setStarMapAndPen(false)
            }}
          >
            关闭笔+星图 Space+G / Esc
          </button>
          <button
            type="button"
            className="corpus-chip"
            onClick={() => setWorkbenchOpen(true)}
          >
            工作台 Esc
          </button>
          {emphasisEdges.length >= 1 && (
            <button
              type="button"
              className="upload-btn"
              onClick={() => enterTetrahedronLens(0)}
              title="用四面体四角机位共面全览所有强调中心"
            >
              四面体全览
            </button>
          )}
        </div>
      )}

      {!open && !emphasizeMode && !emphasisLinkFromId && (
        <div className="workbench-chip-row">
          {emphasisEdges.length >= 1 && (
            <button
              type="button"
              className="workbench-hint"
              onClick={() => enterTetrahedronLens(0)}
              title="四面体共面全览所有强调"
            >
              四面体全览 · {emphasisEdges.length}
            </button>
          )}
          <button
            type="button"
            className="workbench-hint"
            onClick={() => useDocuverse.getState().toggleStarMapWithG()}
            title="Space+G 开关星图·建联 + 强调笔（同开通关）"
          >
            Space+G · 星图+笔
          </button>
          <button
            type="button"
            className="workbench-hint"
            onClick={() => setWorkbenchOpen(true)}
            title="Esc 开关工作台"
          >
            Esc · 工作台
          </button>
        </div>
      )}

      {open && (
        <div
          className="workbench-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setWorkbenchOpen(false)
          }}
        >
          <div
            className="workbench-palette"
            role="dialog"
            aria-modal="true"
            aria-label="文档宇宙工作台"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className="workbench-head">
              <div>
                <div className="workbench-title">工作台</div>
                <p className="meta">
                  Esc 开关 · 建联：Enter 锁 A → Space+G 星图+笔点 B
                </p>
              </div>
              <button
                type="button"
                className="corpus-chip workbench-close"
                onClick={() => setWorkbenchOpen(false)}
              >
                关闭
              </button>
            </header>

            <div className="workbench-quick">
              <button
                type="button"
                className={`upload-btn${emphasizeMode ? ' active' : ''}`}
                onClick={() => setEmphasizeMode(!emphasizeMode)}
              >
                {emphasizeMode
                  ? '星图+笔已开（Space+G 关）'
                  : '开启星图+笔 · Space+G'}
              </button>
              <button
                type="button"
                className="upload-btn"
                style={{ marginTop: 8 }}
                disabled={aiDemoRunning || pages.length < 2}
                onClick={() => {
                  setWorkbenchTab('agent')
                  void runAiProposeAndLinkDemo()
                }}
              >
                {aiDemoRunning
                  ? 'Agent 画圈中…'
                  : '演示 · Agent 画圈并建联'}
              </button>
              {selectedEmphasisId && (
                <button
                  type="button"
                  className="corpus-chip"
                  style={{ marginTop: 8 }}
                  onClick={() => setEmphasisLinkFrom(selectedEmphasisId)}
                >
                  选中 → 端点 A
                </button>
              )}
              <div className="overview-seed-row" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="corpus-chip"
                  disabled={emphasisEdges.length === 0}
                  onClick={() =>
                    openOverview(emphasisEdges.map((e) => e.id))
                  }
                >
                  关联台 · 全部
                </button>
                <button
                  type="button"
                  className="corpus-chip"
                  disabled={pageIds.length === 0}
                  onClick={() => openOverview(pageIds)}
                >
                  本页
                </button>
                <button
                  type="button"
                  className="corpus-chip"
                  disabled={lastAgentHitIds.length === 0}
                  onClick={() => openOverview(lastAgentHitIds)}
                >
                  Agent
                </button>
              </div>
            </div>

            <nav className="workbench-tabs" aria-label="工作台分区">
              {(
                [
                  ['emphasis', '强调 · 建联'],
                  ['beams', '用户射线'],
                  ['agent', 'Agent'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={tab === id ? 'active' : ''}
                  onClick={() => setWorkbenchTab(id)}
                >
                  {label}
                </button>
              ))}
            </nav>

            <div className="workbench-body">
              {tab === 'emphasis' && <EmphasisPanel />}
              {tab === 'beams' && <BondBeamPanel />}
              {tab === 'agent' && <EmphasisAgentPanel />}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
