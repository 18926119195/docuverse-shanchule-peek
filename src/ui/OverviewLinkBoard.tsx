import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useDocuverse } from '../canvas/store'
import { renderEmphasisTile } from '../data/emphasisCatalog'

type TileSrc = { id: string; src: string | null; error?: string }

type BoardFilter = 'seed' | 'all' | 'page' | 'agent' | 'unlinked' | 'reading'

/**
 * 关联台：原件裁切 + 轮廓图卡。先选 A 再选 B 建联；过滤切换候选池。
 */
export function OverviewLinkBoard() {
  const open = useDocuverse((s) => s.overviewOpen)
  const overviewIds = useDocuverse((s) => s.overviewIds)
  const setOverviewIds = useDocuverse((s) => s.setOverviewIds)
  const closeOverview = useDocuverse((s) => s.closeOverview)
  const edges = useDocuverse((s) => s.emphasisEdges)
  const links = useDocuverse((s) => s.emphasisLinks)
  const pages = useDocuverse((s) => s.pages)
  const currentStrand = useDocuverse((s) => s.currentStrand)
  const lastAgentHitIds = useDocuverse((s) => s.lastAgentHitIds)
  const emphasisLinkFromId = useDocuverse((s) => s.emphasisLinkFromId)
  const setEmphasisLinkFrom = useDocuverse((s) => s.setEmphasisLinkFrom)
  const createEmphasisLink = useDocuverse((s) => s.createEmphasisLink)
  const deleteEmphasisLink = useDocuverse((s) => s.deleteEmphasisLink)
  const navigateToEmphasis = useDocuverse((s) => s.navigateToEmphasis)
  const openLinkFocus = useDocuverse((s) => s.openLinkFocus)
  const setWorkbenchOpen = useDocuverse((s) => s.setWorkbenchOpen)

  const boardRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef(new Map<string, HTMLButtonElement>())
  const [tiles, setTiles] = useState<TileSrc[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<BoardFilter>('seed')
  const [lineEnds, setLineEnds] = useState<
    { id: string; x1: number; y1: number; x2: number; y2: number }[]
  >([])
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 })

  const linkedIds = useMemo(() => {
    const set = new Set<string>()
    for (const l of links) {
      set.add(l.fromEmphasisId)
      set.add(l.toEmphasisId)
    }
    return set
  }, [links])

  const applyFilter = (next: BoardFilter) => {
    setFilter(next)
    let ids: string[] = []
    if (next === 'all') ids = edges.map((e) => e.id)
    else if (next === 'page')
      ids = edges.filter((e) => e.strandIndex === currentStrand).map((e) => e.id)
    else if (next === 'agent') ids = lastAgentHitIds
    else if (next === 'unlinked')
      ids = edges.filter((e) => !linkedIds.has(e.id)).map((e) => e.id)
    else if (next === 'reading')
      ids = edges.filter((e) => e.reading.trim()).map((e) => e.id)
    else ids = overviewIds
    if (ids.length > 0) setOverviewIds(ids)
  }

  useEffect(() => {
    if (open) setFilter('seed')
  }, [open])

  const boardEdges = useMemo(
    () =>
      overviewIds
        .map((id) => edges.find((e) => e.id === id))
        .filter((e): e is NonNullable<typeof e> => Boolean(e)),
    [overviewIds, edges],
  )

  const boardLinks = useMemo(() => {
    const set = new Set(overviewIds)
    return links.filter(
      (l) => set.has(l.fromEmphasisId) && set.has(l.toEmphasisId),
    )
  }, [links, overviewIds])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      const pageBy = new Map(pages.map((p) => [p.strandIndex, p]))
      const next: TileSrc[] = []
      for (const edge of boardEdges) {
        const page = pageBy.get(edge.strandIndex)
        if (!page?.imageUrl) {
          next.push({ id: edge.id, src: null, error: '无页图' })
          continue
        }
        try {
          const src = await renderEmphasisTile(
            page.imageUrl,
            edge.region.polygon,
            edge.region.aabb,
          )
          if (cancelled) return
          next.push({ id: edge.id, src })
        } catch {
          if (cancelled) return
          next.push({ id: edge.id, src: null, error: '抽出失败' })
        }
      }
      if (!cancelled) {
        setTiles(next)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, boardEdges, pages])

  const measureLines = () => {
    const root = boardRef.current
    if (!root) return
    const rb = root.getBoundingClientRect()
    setSvgSize({
      w: Math.max(root.scrollWidth, root.clientWidth),
      h: Math.max(root.scrollHeight, root.clientHeight),
    })
    const next: { id: string; x1: number; y1: number; x2: number; y2: number }[] =
      []
    for (const link of boardLinks) {
      const a = cardRefs.current.get(link.fromEmphasisId)
      const b = cardRefs.current.get(link.toEmphasisId)
      if (!a || !b) continue
      const ar = a.getBoundingClientRect()
      const br = b.getBoundingClientRect()
      next.push({
        id: link.id,
        x1: ar.left + ar.width / 2 - rb.left + root.scrollLeft,
        y1: ar.top + ar.height / 2 - rb.top + root.scrollTop,
        x2: br.left + br.width / 2 - rb.left + root.scrollLeft,
        y2: br.top + br.height / 2 - rb.top + root.scrollTop,
      })
    }
    setLineEnds(next)
  }

  useLayoutEffect(() => {
    if (!open) return
    measureLines()
    const root = boardRef.current
    if (!root) return
    const onScroll = () => measureLines()
    root.addEventListener('scroll', onScroll)
    window.addEventListener('resize', measureLines)
    const t = window.setTimeout(measureLines, 50)
    return () => {
      root.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', measureLines)
      window.clearTimeout(t)
    }
  }, [open, boardLinks, tiles, loading])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (emphasisLinkFromId) {
          setEmphasisLinkFrom(null)
          return
        }
        closeOverview()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, emphasisLinkFromId, setEmphasisLinkFrom, closeOverview])

  if (!open) return null

  const onTileClick = (id: string) => {
    if (!emphasisLinkFromId) {
      setEmphasisLinkFrom(id)
      return
    }
    if (emphasisLinkFromId === id) {
      setEmphasisLinkFrom(null)
      return
    }
    createEmphasisLink(id)
    window.setTimeout(measureLines, 30)
  }

  const filters: { id: BoardFilter; label: string; disabled?: boolean }[] = [
    { id: 'all', label: '全部' },
    { id: 'page', label: '本页' },
    {
      id: 'agent',
      label: `Agent${lastAgentHitIds.length ? ` (${lastAgentHitIds.length})` : ''}`,
      disabled: lastAgentHitIds.length === 0,
    },
    { id: 'unlinked', label: '未连线' },
    { id: 'reading', label: '有理解' },
  ]

  return (
    <div className="overview-root" role="dialog" aria-label="关联台">
      <header className="overview-head">
        <div>
          <div className="overview-title">关联台</div>
          <p className="meta">
            先选端点 A，再选 B → 写入紫线（街面，不自动停泊）
            {emphasisLinkFromId ? ' · 已选 A，再点对端' : ''}
          </p>
        </div>
        <div className="overview-actions">
          {emphasisLinkFromId && (
            <button
              type="button"
              className="corpus-chip"
              onClick={() => setEmphasisLinkFrom(null)}
            >
              取消端点 A
            </button>
          )}
          <button
            type="button"
            className="corpus-chip"
            onClick={() => {
              closeOverview()
              setWorkbenchOpen(true)
            }}
          >
            回工作台
          </button>
          <button
            type="button"
            className="corpus-chip"
            onClick={() => closeOverview()}
          >
            关闭 Esc
          </button>
        </div>
      </header>

      <div className="overview-filter-row" role="toolbar" aria-label="候选过滤">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`corpus-chip${filter === f.id ? ' active' : ''}`}
            disabled={f.disabled}
            onClick={() => applyFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
        <span className="meta">共 {boardEdges.length} 卡</span>
      </div>

      {loading && <p className="overview-status">正在从原页抽出描边图…</p>}

      <div className="overview-board" ref={boardRef}>
        <svg
          className="overview-beams"
          width={svgSize.w}
          height={svgSize.h}
          aria-hidden
        >
          {lineEnds.map((ln) => {
            const link = boardLinks.find((l) => l.id === ln.id)
            return (
              <g key={ln.id}>
                <line
                  x1={ln.x1}
                  y1={ln.y1}
                  x2={ln.x2}
                  y2={ln.y2}
                  className="overview-beam-line"
                />
                <line
                  x1={ln.x1}
                  y1={ln.y1}
                  x2={ln.x2}
                  y2={ln.y2}
                  className="overview-beam-hit"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!link) return
                    openLinkFocus(link.id)
                    closeOverview()
                  }}
                />
                <circle cx={ln.x1} cy={ln.y1} r={5} className="overview-beam-dot" />
                <circle cx={ln.x2} cy={ln.y2} r={5} className="overview-beam-dot" />
              </g>
            )
          })}
        </svg>

        <div className="overview-grid">
          {boardEdges.map((edge) => {
            const tile = tiles.find((t) => t.id === edge.id)
            const isFrom = emphasisLinkFromId === edge.id
            const canBeB = Boolean(emphasisLinkFromId) && !isFrom
            return (
              <button
                key={edge.id}
                type="button"
                className={`overview-card${isFrom ? ' is-from' : ''}${canBeB ? ' is-candidate-b' : ''}`}
                ref={(el) => {
                  if (el) cardRefs.current.set(edge.id, el)
                  else cardRefs.current.delete(edge.id)
                }}
                onClick={() => onTileClick(edge.id)}
                onDoubleClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  navigateToEmphasis(edge.id)
                  closeOverview()
                }}
                title="单击：选 A / 完成 B · 双击：飞回宇宙原页"
              >
                <div className="overview-card-media">
                  {tile?.src ? (
                    <img src={tile.src} alt="" draggable={false} />
                  ) : (
                    <div className="overview-card-fallback">
                      {tile?.error ?? '…'}
                    </div>
                  )}
                </div>
                <div className="overview-card-meta">
                  <span>
                    s{edge.strandIndex}
                    {edge.sourcePage != null ? ` · p${edge.sourcePage}` : ''}
                    {linkedIds.has(edge.id) ? ' · 已连' : ''}
                  </span>
                  <span className="overview-card-reading">
                    {edge.reading.trim()
                      ? edge.reading.slice(0, 36)
                      : '（无理解）'}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {boardLinks.length > 0 && (
        <footer className="overview-foot">
          <span className="meta">本台可见已连 {boardLinks.length} 条</span>
          <ul className="overview-link-list">
            {boardLinks.map((l) => {
              const from = edges.find((e) => e.id === l.fromEmphasisId)
              const to = edges.find((e) => e.id === l.toEmphasisId)
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    className="corpus-chip"
                    onClick={() => {
                      openLinkFocus(l.id)
                      closeOverview()
                    }}
                  >
                    s{from?.strandIndex ?? '?'}→s{to?.strandIndex ?? '?'}
                    {l.apex ? ' · 停泊' : ''}
                  </button>
                  <button
                    type="button"
                    className="corpus-chip danger bond-del"
                    onClick={() => {
                      deleteEmphasisLink(l.id)
                      window.setTimeout(measureLines, 30)
                    }}
                  >
                    删
                  </button>
                </li>
              )
            })}
          </ul>
        </footer>
      )}
    </div>
  )
}
