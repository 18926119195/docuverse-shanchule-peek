/**
 * 注意力门面可画区：在 panel_norm 上拖矩形圈选，
 * 分解逻辑与页上 bookKey 强调笔一致（命中 / 空白 / rel）。
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  makeAttentionPanel,
  type AttentionKeyKind,
} from '../arch/attentionPanel'
import type { DoorFace, NormBBox } from '../arch/doorFace'
import { usePanelEmphasizeStore } from '../reasoning/panelEmphasizeStore'

/** Stable empty snapshot — inline `?? []` in a Zustand selector reallocates every getSnapshot and trips React's infinite-loop guard. */
const EMPTY_CHILD_DOORS: DoorFace[] = []

function coverageLabel(
  c: 'hit_existing' | 'uncovered_needs_confirm' | 'mixed_hit_and_uncovered',
): string {
  if (c === 'hit_existing') return '命中已有门 · 只指针+rel，不铸'
  if (c === 'uncovered_needs_confirm') return '空白 · 须确认后铸面板子门'
  return '混合 · 占块复用 + 空白待确认'
}

function bboxStyle(b: NormBBox): CSSProperties {
  const [x0, y0, x1, y1] = b
  return {
    left: `${x0 * 100}%`,
    top: `${y0 * 100}%`,
    width: `${Math.max(0, x1 - x0) * 100}%`,
    height: `${Math.max(0, y1 - y0) * 100}%`,
  }
}

export function AttentionDoorFace({
  doorKey,
  keyKind,
  faceText,
  hostBookKey,
  queryKey,
  children,
  enabled = true,
}: {
  doorKey: string
  keyKind: AttentionKeyKind
  faceText: string
  hostBookKey?: string
  queryKey?: string
  children: ReactNode
  /** false = 只展示不圈画（折叠 chip 等） */
  enabled?: boolean
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const drawing = useRef(false)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const [draft, setDraft] = useState<NormBBox | null>(null)

  const sealStroke = usePanelEmphasizeStore((s) => s.sealStroke)
  const confirmBlank = usePanelEmphasizeStore((s) => s.confirmBlankChildDoor)
  const pendingBlank = usePanelEmphasizeStore((s) => s.pendingBlank)
  const strokes = usePanelEmphasizeStore((s) => s.strokes)
  const childDoors = usePanelEmphasizeStore(
    (s) => s.childDoorsByPanel[doorKey] ?? EMPTY_CHILD_DOORS,
  )

  const panel = useMemo(
    () =>
      makeAttentionPanel({
        key: doorKey,
        keyKind,
        faceText,
        hostBookKey,
        queryKey,
      }),
    [doorKey, keyKind, faceText, hostBookKey, queryKey],
  )

  const mine = strokes.filter((st) => st.panelKey === doorKey)
  const last = mine[mine.length - 1] ?? null
  const pendingHere =
    pendingBlank?.panelKey === doorKey ? pendingBlank : null

  const clientToNorm = useCallback((clientX: number, clientY: number) => {
    const el = rootRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return null
    const u = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    const v = Math.max(0, Math.min(1, (clientY - r.top) / r.height))
    return { u, v }
  }, [])

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!enabled) return
    // 仅左键；让按钮自己点
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    if (t.closest('button, a, input, textarea')) return
    const p = clientToNorm(e.clientX, e.clientY)
    if (!p) return
    e.preventDefault()
    e.stopPropagation()
    drawing.current = true
    origin.current = { x: p.u, y: p.v }
    setDraft([p.u, p.v, p.u, p.v])
    rootRef.current?.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drawing.current || !origin.current) return
    const p = clientToNorm(e.clientX, e.clientY)
    if (!p) return
    const o = origin.current
    setDraft([
      Math.min(o.x, p.u),
      Math.min(o.y, p.v),
      Math.max(o.x, p.u),
      Math.max(o.y, p.v),
    ])
  }

  const finish = (e: ReactPointerEvent) => {
    if (!drawing.current) return
    drawing.current = false
    const o = origin.current
    origin.current = null
    try {
      rootRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* */
    }
    const p = clientToNorm(e.clientX, e.clientY)
    setDraft(null)
    if (!o || !p) return
    const aabb: NormBBox = [
      Math.min(o.x, p.u),
      Math.min(o.y, p.v),
      Math.max(o.x, p.u),
      Math.max(o.y, p.v),
    ]
    const area = Math.max(0, aabb[2] - aabb[0]) * Math.max(0, aabb[3] - aabb[1])
    if (area < 0.0004) return
    sealStroke({ panel, aabb })
  }

  return (
    <div
      ref={rootRef}
      className={`attn-door-face${enabled ? ' attn-door-face-live' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      <div className="attn-door-face-body">{children}</div>

      <div className="attn-door-face-overlay" aria-hidden>
        {childDoors.map((d) => (
          <div
            key={d.doorKey}
            className="attn-door-child"
            style={bboxStyle(d.aabb)}
            title={`子门 ${d.doorKey}`}
          />
        ))}
        {mine.map((st) =>
          st.decomposition.onDoors.map((p, i) => (
            <div
              key={`${st.id}_hit_${i}`}
              className="attn-door-hit"
              style={bboxStyle(p.pieceAabb)}
              title={`命中 ${p.doorKey} · rel=${p.rel.map((n) => n.toFixed(2)).join(',')}`}
            />
          )),
        )}
        {mine.map((st) =>
          st.decomposition.blankAabbs.map((b, i) => (
            <div
              key={`${st.id}_blank_${i}`}
              className="attn-door-blank"
              style={bboxStyle(b)}
              title="空白 · 待确认铸子门"
            />
          )),
        )}
        {draft && (
          <div className="attn-door-draft" style={bboxStyle(draft)} />
        )}
      </div>

      {enabled && (
        <div className="attn-door-face-status" role="status">
          {last ? (
            <>
              <span>{coverageLabel(last.coverage)}</span>
              {last.decomposition.onDoors[0] && (
                <span className="attn-door-meta">
                  · rel[
                  {last.decomposition.onDoors[0].rel
                    .map((n) => n.toFixed(2))
                    .join(',')}
                  ]
                </span>
              )}
              {pendingHere && (
                <button
                  type="button"
                  className="attn-door-confirm"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    confirmBlank({ panel, confirm: true })
                  }}
                >
                  确认铸子门
                </button>
              )}
            </>
          ) : (
            <span>在窗上拖矩形 = 强调笔（与 bookKey 门同构）</span>
          )}
        </div>
      )}
    </div>
  )
}
