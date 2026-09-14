/**
 * queryKey 无限幕布：台账上全部 settled queryKey 都要出节点。
 * 边：
 * - 深化 parent→child（实线）
 * - neighbour：现问 ──► 历史问（虚线正向箭头）
 * - 可复用（已批或挂起）：同线加逆向箭头
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useAttentionIo } from '../reasoning/attentionIoStore'
import { expandHistoricQueryKey } from '../arch/deskEntryGate'

function short(k: string, n = 10): string {
  const t = k.trim()
  if (t.length <= n) return t
  return `${t.slice(0, 4)}…${t.slice(-4)}`
}

type NodePos = { x: number; y: number }

const NODE_W = 88
const NODE_H = 52
const NODE_CX = NODE_W / 2
const NODE_CY = NODE_H / 2

function midEdgeArrow(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  opts: { reverse?: boolean; size?: number; fill: string },
) {
  const size = opts.size ?? 9
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const fx = opts.reverse ? -ux : ux
  const fy = opts.reverse ? -uy : uy
  const along = opts.reverse ? 0.42 : 0.58
  const mx = x1 + dx * along
  const my = y1 + dy * along
  const tipX = mx + fx * size
  const tipY = my + fy * size
  const bx = mx - fx * size * 0.35
  const by = my - fy * size * 0.35
  const px = -fy
  const py = fx
  const w = size * 0.55
  return {
    d: `M ${tipX} ${tipY} L ${bx + px * w} ${by + py * w} L ${bx - px * w} ${by - py * w} Z`,
    fill: opts.fill,
  }
}

function pairId(a: string, b: string) {
  return a < b ? `${a}::${b}` : `${b}::${a}`
}

/** keys 按旧→新；neighbour 拉开 historic / now */
function layoutQueryKeys(
  keysOldestFirst: string[],
  parentOf: Record<string, string>,
  neighbourPairs: Array<{ now: string; historic: string }>,
): Record<string, NodePos> {
  const pos: Record<string, NodePos> = {}
  const idx = new Map(keysOldestFirst.map((k, i) => [k, i]))
  const linked = new Set<string>()
  for (const p of neighbourPairs) {
    linked.add(p.now)
    linked.add(p.historic)
  }

  keysOldestFirst.forEach((qk, i) => {
    const parent = parentOf[qk]
    if (parent && pos[parent]) {
      const sib = keysOldestFirst.filter((k) => parentOf[k] === parent)
      const si = Math.max(0, sib.indexOf(qk))
      pos[qk] = {
        x: pos[parent].x + 40 + si * 24,
        y: pos[parent].y + 100,
      }
      return
    }
    const bump = linked.has(qk) ? (i % 2 === 0 ? 0 : 56) : (i % 3) * 28
    pos[qk] = { x: 56 + i * 150, y: 72 + bump }
  })

  for (const p of neighbourPairs) {
    const a = pos[p.historic]
    const b = pos[p.now]
    if (!a || !b) continue
    if (Math.abs(a.x - b.x) < 100) {
      const ia = idx.get(p.historic) ?? 0
      const ib = idx.get(p.now) ?? 0
      if (ib >= ia) {
        b.x = a.x + 150
        b.y = a.y + (b.y >= a.y ? 48 : -48)
      } else {
        a.x = b.x + 150
      }
    }
  }
  return pos
}

function fitPanZoom(
  el: HTMLElement,
  keys: string[],
  laid: Record<string, NodePos>,
): { pan: NodePos; zoom: number } {
  if (keys.length === 0) return { pan: { x: 12, y: 28 }, zoom: 1 }
  const xs = keys.map((k) => laid[k]!.x)
  const ys = keys.map((k) => laid[k]!.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs) + NODE_W
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys) + NODE_H
  const bw = Math.max(120, el.clientWidth)
  const bh = Math.max(100, el.clientHeight)
  const padX = 28
  const padY = 44
  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  const zoom = Math.min(
    1.15,
    Math.max(0.5, Math.min((bw - padX * 2) / spanX, (bh - padY * 2) / spanY)),
  )
  return {
    zoom,
    pan: {
      x: padX - minX * zoom + (bw - padX * 2 - spanX * zoom) / 2,
      y: padY - minY * zoom + Math.max(0, (bh - padY * 2 - spanY * zoom) / 4),
    },
  }
}

export function QueryKeyInfiniteCanvas({
  activeQueryKey,
  onSelectQueryKey,
}: {
  activeQueryKey: string | null
  onSelectQueryKey: (queryKey: string) => void
}) {
  const settled = useAttentionIo((s) => s.settledQueries)
  const parentOf = useAttentionIo((s) => s.queryParentOf)
  const neighbours = useAttentionIo((s) => s.neighbours)
  const reuseLinks = useAttentionIo((s) => s.queryReuseLinks)
  const pendingReuse = useAttentionIo((s) => s.pendingReuseProposal)

  const rows = useMemo(
    () =>
      Object.entries(settled).map(([queryKey, question]) => ({
        queryKey,
        question: question || '',
      })),
    [settled],
  )
  const keysOldestFirst = useMemo(() => rows.map((r) => r.queryKey), [rows])
  const rowsNewestFirst = useMemo(() => [...rows].reverse(), [rows])
  const keySig = keysOldestFirst.join('\0')
  const neighbourSig = neighbours
    .map((n) => `${n.nowQueryKey}>${n.historicQueryKey}`)
    .join('\0')

  const qText = useMemo(() => {
    const m: Record<string, string> = {}
    for (const r of rows) m[r.queryKey] = r.question
    return m
  }, [rows])

  const neighbourPairs = useMemo(() => {
    const out: Array<{ now: string; historic: string }> = []
    const seen = new Set<string>()
    for (const n of neighbours) {
      const now = n.nowQueryKey?.trim()
      const historic =
        expandHistoricQueryKey(n.historicQueryKey || '', now) ||
        n.historicQueryKey?.trim()
      if (!now || !historic) continue
      const id = pairId(now, historic)
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ now, historic })
    }
    return out
  }, [neighbours])

  const reusePairs = useMemo(() => {
    const set = new Set<string>()
    for (const r of reuseLinks) {
      const now = r.fromQueryKey?.trim()
      const old = r.toQueryKey?.trim()
      if (now && old) set.add(pairId(now, old))
    }
    if (pendingReuse) {
      const now = pendingReuse.queryKey
      for (const c of pendingReuse.candidates) {
        const old = c.oldQueryKey?.trim()
        if (now && old) set.add(pairId(now, old))
      }
    }
    return set
  }, [reuseLinks, pendingReuse])

  const pendingReuseCount = pendingReuse?.candidates.length ?? 0

  const baseLayout = useMemo(
    () => layoutQueryKeys(keysOldestFirst, parentOf, neighbourPairs),
    // keySig / neighbourSig 强制在台账边变更时重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keySig, neighbourSig, parentOf],
  )

  const edges = useMemo(() => {
    const keySet = new Set(keysOldestFirst)
    const parent: Array<{ from: string; to: string }> = []
    for (const k of keysOldestFirst) {
      const p = parentOf[k]
      if (p && keySet.has(p)) parent.push({ from: p, to: k })
    }
    const byPair = new Map<
      string,
      { from: string; to: string; reusable: boolean }
    >()
    for (const n of neighbourPairs) {
      if (!keySet.has(n.now) || !keySet.has(n.historic)) continue
      const id = pairId(n.now, n.historic)
      byPair.set(id, {
        from: n.now,
        to: n.historic,
        reusable: reusePairs.has(id),
      })
    }
    for (const r of reuseLinks) {
      const now = r.fromQueryKey?.trim()
      const old = r.toQueryKey?.trim()
      if (!now || !old || !keySet.has(now) || !keySet.has(old)) continue
      const id = pairId(now, old)
      if (byPair.has(id)) byPair.get(id)!.reusable = true
      else byPair.set(id, { from: now, to: old, reusable: true })
    }
    if (pendingReuse) {
      const now = pendingReuse.queryKey
      for (const c of pendingReuse.candidates) {
        const old = c.oldQueryKey?.trim()
        if (!now || !old || !keySet.has(now) || !keySet.has(old)) continue
        const id = pairId(now, old)
        if (byPair.has(id)) byPair.get(id)!.reusable = true
        else byPair.set(id, { from: now, to: old, reusable: true })
      }
    }
    return { parent, neighbour: [...byPair.values()] }
  }, [
    keysOldestFirst,
    parentOf,
    neighbourPairs,
    reuseLinks,
    pendingReuse,
    reusePairs,
  ])

  const rootRef = useRef<HTMLDivElement>(null)
  /** 用户拖过的节点覆盖；台账重排时清掉已不存在的 key */
  const [dragOverride, setDragOverride] = useState<Record<string, NodePos>>({})
  const [pan, setPan] = useState({ x: 12, y: 28 })
  const [zoom, setZoom] = useState(1)
  const userMovedView = useRef(false)
  const drag = useRef<
    | { kind: 'pan'; ox: number; oy: number; px: number; py: number }
    | { kind: 'node'; key: string; ox: number; oy: number; nx: number; ny: number }
    | null
  >(null)
  const moved = useRef(false)

  const positions = useMemo(() => {
    const next = { ...baseLayout }
    for (const [k, p] of Object.entries(dragOverride)) {
      if (next[k]) next[k] = p
    }
    return next
  }, [baseLayout, dragOverride])

  useEffect(() => {
    setDragOverride((prev) => {
      const keep: Record<string, NodePos> = {}
      for (const k of keysOldestFirst) {
        if (prev[k]) keep[k] = prev[k]!
      }
      return keep
    })
  }, [keySig, keysOldestFirst])

  useEffect(() => {
    if (userMovedView.current) return
    const el = rootRef.current
    if (!el || keysOldestFirst.length === 0) return
    const fit = fitPanZoom(el, keysOldestFirst, baseLayout)
    setPan(fit.pan)
    setZoom(fit.zoom)
  }, [keySig, neighbourSig, baseLayout, keysOldestFirst])

  const onPointerDownBg = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = {
      kind: 'pan',
      ox: e.clientX,
      oy: e.clientY,
      px: pan.x,
      py: pan.y,
    }
    moved.current = false
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.ox
    const dy = e.clientY - d.oy
    if (Math.hypot(dx, dy) > 3) {
      moved.current = true
      if (d.kind === 'pan') userMovedView.current = true
    }
    if (d.kind === 'pan') {
      setPan({ x: d.px + dx, y: d.py + dy })
    } else {
      setDragOverride((prev) => ({
        ...prev,
        [d.key]: {
          x: d.nx + dx / zoom,
          y: d.ny + dy / zoom,
        },
      }))
    }
  }

  const onPointerUp = () => {
    drag.current = null
  }

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    userMovedView.current = true
    setZoom((z) =>
      Math.min(2.2, Math.max(0.45, z * (e.deltaY > 0 ? 0.92 : 1.08))),
    )
  }, [])

  const fitAll = useCallback(() => {
    userMovedView.current = false
    setDragOverride({})
    const el = rootRef.current
    if (!el || keysOldestFirst.length === 0) return
    const laid = layoutQueryKeys(keysOldestFirst, parentOf, neighbourPairs)
    const fit = fitPanZoom(el, keysOldestFirst, laid)
    setPan(fit.pan)
    setZoom(fit.zoom)
  }, [keysOldestFirst, parentOf, neighbourPairs])

  const labelOf = (iNewestFirst: number) =>
    `q${rowsNewestFirst.length - iNewestFirst}`

  return (
    <div
      ref={rootRef}
      className="qk-infinite"
      onPointerDown={onPointerDownBg}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      role="application"
      aria-label="queryKey 无限幕布"
    >
      <div className="qk-infinite-hint">
        <span>
          qk×{rows.length}
          {edges.neighbour.length > 0 ? ` · 邻域×${edges.neighbour.length}` : ''}
          {reuseLinks.length > 0 ? ` · 已复用×${reuseLinks.length}` : ''}
          {pendingReuseCount > 0 ? ` · 待批复用×${pendingReuseCount}` : ''}
        </span>
        <button
          type="button"
          className="qk-infinite-fit"
          title="重新框入全部 queryKey"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            fitAll()
          }}
        >
          框入全部
        </button>
      </div>
      <div className="qk-infinite-subhint">
        拖动画布 · 滚轮缩放 · 点节点开审计 · 虚线=现→史 · 双箭头=可复用
      </div>
      <div
        className="qk-infinite-world"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        <svg className="qk-infinite-edges" aria-hidden>
          <defs>
            <marker
              id="qk-arrow-parent"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(232,196,120,0.55)" />
            </marker>
          </defs>
          {edges.parent.map((e) => {
            const a = positions[e.from]
            const b = positions[e.to]
            if (!a || !b) return null
            return (
              <line
                key={`p:${e.from}->${e.to}`}
                className="qk-edge-parent"
                x1={a.x + NODE_CX}
                y1={a.y + NODE_CY}
                x2={b.x + NODE_CX}
                y2={b.y + NODE_CY}
                markerEnd="url(#qk-arrow-parent)"
              />
            )
          })}
          {edges.neighbour.map((e) => {
            const a = positions[e.from]
            const b = positions[e.to]
            if (!a || !b) return null
            const x1 = a.x + NODE_CX
            const y1 = a.y + NODE_CY
            const x2 = b.x + NODE_CX
            const y2 = b.y + NODE_CY
            const fwd = midEdgeArrow(x1, y1, x2, y2, {
              fill: e.reusable
                ? 'rgba(120, 220, 160, 0.95)'
                : 'rgba(120, 196, 255, 0.95)',
              size: 10,
            })
            const back = e.reusable
              ? midEdgeArrow(x1, y1, x2, y2, {
                  reverse: true,
                  fill: 'rgba(120, 220, 160, 0.95)',
                  size: 10,
                })
              : null
            return (
              <g key={`n:${e.from}->${e.to}`}>
                <line
                  className={
                    e.reusable
                      ? 'qk-edge-neighbour qk-edge-neighbour--reuse'
                      : 'qk-edge-neighbour'
                  }
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                />
                <path className="qk-edge-mid-arrow" d={fwd.d} fill={fwd.fill} />
                {back ? (
                  <path
                    className="qk-edge-mid-arrow qk-edge-mid-arrow--reuse"
                    d={back.d}
                    fill={back.fill}
                  />
                ) : null}
              </g>
            )
          })}
        </svg>
        {rowsNewestFirst.map((r, i) => {
          const p = positions[r.queryKey] ?? { x: 56, y: 72 }
          const active = activeQueryKey === r.queryKey
          const reusable = edges.neighbour.some(
            (e) =>
              e.reusable &&
              (e.from === r.queryKey || e.to === r.queryKey),
          )
          return (
            <button
              key={r.queryKey}
              type="button"
              className={
                active
                  ? 'qk-node active'
                  : reusable
                    ? 'qk-node qk-node--reuse'
                    : 'qk-node'
              }
              style={{ left: p.x, top: p.y }}
              title={`${r.queryKey}\n${r.question}`}
              onPointerDown={(e) => {
                e.stopPropagation()
                ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
                drag.current = {
                  kind: 'node',
                  key: r.queryKey,
                  ox: e.clientX,
                  oy: e.clientY,
                  nx: p.x,
                  ny: p.y,
                }
                moved.current = false
              }}
              onPointerUp={(e) => {
                e.stopPropagation()
                const wasDrag = moved.current
                drag.current = null
                if (!wasDrag) onSelectQueryKey(r.queryKey)
              }}
            >
              <span className="qk-node-label">{labelOf(i)}</span>
              <code className="qk-node-key">{short(r.queryKey, 12)}</code>
              <span className="qk-node-q">
                {(qText[r.queryKey] || '').slice(0, 18)}
                {(qText[r.queryKey] || '').length > 18 ? '…' : ''}
              </span>
            </button>
          )
        })}
        {rows.length === 0 ? (
          <p className="qk-infinite-empty">提问后此处出现可点 queryKey 节点</p>
        ) : null}
      </div>
    </div>
  )
}
