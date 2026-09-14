import { useEffect } from 'react'
import { useDocuverse } from '../canvas/store'
import { isTextEditingTarget } from './textEditing'

/**
 * Build / retrospective / tetrahedron lenses — separate from the roaming film.
 */
export function ConstructionLensControls() {
  const cameraLens = useDocuverse((s) => s.cameraLens)
  const constructionLinkId = useDocuverse((s) => s.constructionLinkId)
  const retrospectiveLinkId = useDocuverse((s) => s.retrospectiveLinkId)
  const tetrahedronCorner = useDocuverse((s) => s.tetrahedronCorner)
  const tetraAnchorLinkId = useDocuverse((s) => s.tetraAnchorLinkId)
  const tetraCandidateDId = useDocuverse((s) => s.tetraCandidateDId)
  const links = useDocuverse((s) => s.emphasisLinks)
  const edges = useDocuverse((s) => s.emphasisEdges)
  const exitConstructionLens = useDocuverse((s) => s.exitConstructionLens)
  const exitRetrospectiveLens = useDocuverse((s) => s.exitRetrospectiveLens)
  const exitTetrahedronLens = useDocuverse((s) => s.exitTetrahedronLens)
  const enterRetrospectiveLens = useDocuverse((s) => s.enterRetrospectiveLens)
  const enterConstructionLens = useDocuverse((s) => s.enterConstructionLens)
  const enterAnchoredTetrahedron = useDocuverse((s) => s.enterAnchoredTetrahedron)
  const cycleTetrahedronCorner = useDocuverse((s) => s.cycleTetrahedronCorner)
  const cycleTetraCandidateD = useDocuverse((s) => s.cycleTetraCandidateD)
  const enterTetrahedronLens = useDocuverse((s) => s.enterTetrahedronLens)
  const flipConstructionDepth = useDocuverse((s) => s.flipConstructionDepth)
  const nudgeConstructionMidLift = useDocuverse((s) => s.nudgeConstructionMidLift)
  const nudgeConstructionSpread = useDocuverse((s) => s.nudgeConstructionSpread)
  const constructionDepth = useDocuverse((s) => s.constructionDepth)
  const constructionStage = useDocuverse((s) => s.constructionStage)
  const constructionMidLift = useDocuverse((s) => s.constructionMidLift)
  const constructionSpread = useDocuverse((s) => s.constructionSpread)
  const commentLayerExpanded = useDocuverse((s) => s.commentLayerExpanded)
  const toggleStarMapWithG = useDocuverse((s) => s.toggleStarMapWithG)
  const setCommentLayerExpanded = useDocuverse((s) => s.setCommentLayerExpanded)
  // note editing lives in 3D CommentAtC — not the top HUD


  const activeId =
    constructionLinkId ?? retrospectiveLinkId ?? tetraAnchorLinkId
  const link = links.find((l) => l.id === activeId)
  const from = edges.find((e) => e.id === link?.fromEmphasisId)
  const to = edges.find((e) => e.id === link?.toEmphasisId)
  const keyComparePair = useDocuverse((s) => s.keyComparePair)
  const dEdge = edges.find((e) => e.id === tetraCandidateDId)
  const otherCount = link
    ? edges.filter(
        (e) => e.id !== link.fromEmphasisId && e.id !== link.toEmphasisId,
      ).length
    : 0

  useEffect(() => {
    if (cameraLens === 'roaming') return
    const onKey = (e: KeyboardEvent) => {
      // 评论框 / 输入中：放行 H、G 等字符，不触发热键
      if (isTextEditingTarget(e.target)) {
        if (e.key === 'Escape' && commentLayerExpanded) {
          e.preventDefault()
          setCommentLayerExpanded(false)
          ;(e.target as HTMLElement).blur()
        }
        return
      }
      // 单键 G 已改为 Space+G（见 WorkbenchPalette）；此处不再单独拦截 G
      if (e.key === 'Tab' && cameraLens === 'tetrahedron') {
        e.preventDefault()
        cycleTetrahedronCorner()
        return
      }
      if (e.key === 'Escape') {
        if (
          commentLayerExpanded &&
          (cameraLens === 'construction' || cameraLens === 'retrospective')
        ) {
          e.preventDefault()
          setCommentLayerExpanded(false)
          return
        }
        if (cameraLens === 'retrospective') {
          e.preventDefault()
          exitRetrospectiveLens()
        } else if (cameraLens === 'construction') {
          e.preventDefault()
          exitConstructionLens()
        } else if (cameraLens === 'tetrahedron') {
          e.preventDefault()
          exitTetrahedronLens()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [
    cameraLens,
    commentLayerExpanded,
    exitConstructionLens,
    exitRetrospectiveLens,
    exitTetrahedronLens,
    cycleTetrahedronCorner,
    setCommentLayerExpanded,
  ])

  if (cameraLens === 'tetrahedron' && tetraAnchorLinkId && link && from && to) {
    return (
      <div className="link-focus-chip mode-focused lens-tetrahedron" role="status">
        <span className="link-focus-mode">锚面四面体 · ABC + D</span>
        <span className="meta">
          源页不挪 · 贴面阅读 · D=
          {dEdge ? `s${dEdge.strandIndex}` : '?'} · Tab 换候选
        </span>
        <button type="button" className="upload-btn" onClick={cycleTetraCandidateD}>
          换 D Tab
        </button>
        <button
          type="button"
          className="corpus-chip"
          onClick={() => enterConstructionLens(link.id)}
        >
          回构建
        </button>
        <button type="button" className="corpus-chip" onClick={exitTetrahedronLens}>
          回到漫游
        </button>
      </div>
    )
  }

  if (cameraLens === 'tetrahedron') {
    const corner = (tetrahedronCorner ?? 0) + 1
    return (
      <div className="link-focus-chip mode-focused lens-tetrahedron" role="status">
        <span className="link-focus-mode">强调云四面体 · 角 {corner}/4</span>
        <span className="meta">对象反算机位 · Tab 换角</span>
        <button type="button" className="upload-btn" onClick={cycleTetrahedronCorner}>
          下一角 Tab
        </button>
        {[0, 1, 2, 3].map((i) => (
          <button
            key={i}
            type="button"
            className={`corpus-chip${tetrahedronCorner === i ? ' active' : ''}`}
            onClick={() => enterTetrahedronLens(i as 0 | 1 | 2 | 3)}
          >
            {i + 1}
          </button>
        ))}
        <button type="button" className="corpus-chip" onClick={exitTetrahedronLens}>
          回到漫游
        </button>
      </div>
    )
  }

  if (cameraLens === 'roaming') return null

  const isKeyCompare =
    cameraLens === 'construction' && Boolean(keyComparePair) && !link

  if (!isKeyCompare && (!link || !from || !to)) return null

  const pagesLabel = isKeyCompare
    ? `${keyComparePair!.keyA.slice(0, 10)}… ↔ ${keyComparePair!.keyB.slice(0, 10)}…`
    : `s${from!.strandIndex} ↔ s${to!.strandIndex}`

  const stageLabel =
    constructionStage === 'rail'
      ? `同心球 · 中点 ${constructionMidLift.toFixed(2)} · 右键环视`
      : constructionStage === 'crossing'
        ? '穿洞中…'
        : `俯视 · 拉链间距 ${constructionSpread.toFixed(2)}`

  if (cameraLens === 'construction') {
    if (isKeyCompare) {
      return (
        <div className="link-focus-chip mode-focused lens-construction" role="status">
          <span className="link-focus-mode">key 面板对比</span>
          <span className="meta">{pagesLabel} · 间距用壳拉链 · Esc 退出</span>
          <button
            type="button"
            className="corpus-chip"
            onClick={exitConstructionLens}
          >
            退出对比
          </button>
        </div>
      )
    }
    return (
      <div className="link-focus-chip mode-focused lens-construction" role="status">
          <span className="link-focus-mode">构建 · {stageLabel}</span>
          <span className="meta">
            {pagesLabel} · ①中点↔C ②穿洞 ③俯视拉链 · 回穿洞=同心球可环视 ·
            再推向 C 回拉链 · Space+G 隐身 ·{' '}
            {constructionDepth === 'commentNear'
              ? '评论外球近'
              : '强调内球近'}
          </span>
          <button
            type="button"
            className={`corpus-chip${commentLayerExpanded ? ' active' : ''}`}
            onClick={toggleStarMapWithG}
            title="Space+G：评论层与星图+强调笔同开通关"
          >
            {commentLayerExpanded ? 'Space+G · 隐身' : 'Space+G · 现身'}
          </button>
          {constructionStage === 'rail' && (
            <button
              type="button"
              className="corpus-chip"
              onClick={() => nudgeConstructionMidLift(0.1)}
              title="中点升向 C；到顶穿洞"
            >
              ↑中点
            </button>
          )}
          {constructionStage === 'planar' && (
            <>
              <button
                type="button"
                className="corpus-chip"
                onClick={() => nudgeConstructionSpread(-0.15)}
              >
                靠近
              </button>
              <button
                type="button"
                className="corpus-chip"
                onClick={() => nudgeConstructionSpread(0.15)}
              >
                远离
              </button>
            </>
          )}
          <button type="button" className="upload-btn" onClick={flipConstructionDepth}>
            近远翻转
          </button>
          {link && (
            <>
              <button
                type="button"
                className="corpus-chip"
                onClick={() => enterRetrospectiveLens(link.id)}
              >
                回溯
              </button>
              <button
                type="button"
                className="corpus-chip"
                disabled={otherCount === 0}
                onClick={() => enterAnchoredTetrahedron(link.id)}
              >
                扩展四面体
              </button>
            </>
          )}
          <button type="button" className="corpus-chip" onClick={exitConstructionLens}>
            回到漫游
          </button>
        </div>
    )
  }

  if (!link || !from || !to) return null

  return (
      <div className="link-focus-chip mode-parked lens-retrospective" role="status">
        <span className="link-focus-mode">回溯镜头 · 生成轴 M→C</span>
        <span className="meta">
          {pagesLabel} · 贴面仍在 · 源不挪 · 评论在 C · Space+G 隐身/现身
        </span>
        <button
          type="button"
          className={`corpus-chip${commentLayerExpanded ? ' active' : ''}`}
          onClick={toggleStarMapWithG}
          title="Space+G：评论层与星图+强调笔同开通关"
        >
          {commentLayerExpanded ? 'Space+G · 隐身' : 'Space+G · 现身'}
        </button>
        <button
          type="button"
          className="corpus-chip"
          onClick={() => enterConstructionLens(link.id)}
        >
          构建镜头
        </button>
        <button
          type="button"
          className="upload-btn"
          disabled={otherCount === 0}
          onClick={() => enterAnchoredTetrahedron(link.id)}
        >
          扩展四面体
        </button>
        <button type="button" className="corpus-chip" onClick={exitRetrospectiveLens}>
          回到漫游
        </button>
      </div>
  )
}
