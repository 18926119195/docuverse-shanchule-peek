import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

const STORAGE_KEY = 'docuverse.settlement.sphereRatio'
const DEFAULT_RATIO = 0.28
const MIN_RATIO = 0.04
const MAX_RATIO = 0.96

function loadRatio(): number {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_RATIO
    const n = Number(raw)
    if (!Number.isFinite(n)) return DEFAULT_RATIO
    return Math.min(MAX_RATIO, Math.max(MIN_RATIO, n))
  } catch {
    return DEFAULT_RATIO
  }
}

function saveRatio(n: number) {
  try {
    sessionStorage.setItem(STORAGE_KEY, String(n))
  } catch {
    /* ignore */
  }
}

/**
 * 结算：上球 / 下幕布，中间可上下拖分栏。
 * 上拖 → 幕布趋近全局；下拖 → 球体趋近全局。双击分栏复位。
 */
export function SettlementVSplit({
  sphere,
  desk,
  footer,
}: {
  sphere: ReactNode
  desk: ReactNode
  footer?: ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [sphereRatio, setSphereRatio] = useState(loadRatio)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef(false)
  const ratioRef = useRef(sphereRatio)
  ratioRef.current = sphereRatio

  const applyFromClientY = useCallback((clientY: number) => {
    const root = rootRef.current
    if (!root) return
    const rect = root.getBoundingClientRect()
    const footerEl = root.querySelector('.patent-bar') as HTMLElement | null
    const footerH = footerEl?.offsetHeight ?? 28
    const handleH = 8
    const usable = Math.max(120, rect.height - footerH - handleH)
    const y = clientY - rect.top
    const next = Math.min(MAX_RATIO, Math.max(MIN_RATIO, y / usable))
    ratioRef.current = next
    setSphereRatio(next)
  }, [])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current) return
      e.preventDefault()
      applyFromClientY(e.clientY)
    }
    const onUp = () => {
      dragRef.current = false
      setDragging(false)
      saveRatio(ratioRef.current)
      window.dispatchEvent(new Event('resize'))
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging, applyFromClientY])

  const deskRatio = Math.max(0.01, 1 - sphereRatio)

  return (
    <div
      ref={rootRef}
      className={
        dragging
          ? 'app-root app-root--settlement-sphere-desk settlement-vsplit--dragging'
          : 'app-root app-root--settlement-sphere-desk'
      }
      style={{
        gridTemplateRows: `minmax(48px, ${sphereRatio}fr) 8px minmax(100px, ${deskRatio}fr) auto`,
      }}
    >
      <section className="settlement-sphere" aria-label="物化页球体">
        {sphere}
      </section>
      <div
        className="settlement-vsplit-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="上下拖动：调球与幕布高度"
        aria-valuemin={Math.round(MIN_RATIO * 100)}
        aria-valuemax={Math.round(MAX_RATIO * 100)}
        aria-valuenow={Math.round(sphereRatio * 100)}
        title="上下拖动 · 双击复位 · 上=幕布全局 / 下=球全局"
        onPointerDown={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
          dragRef.current = true
          setDragging(true)
          applyFromClientY(e.clientY)
        }}
        onDoubleClick={() => {
          ratioRef.current = DEFAULT_RATIO
          setSphereRatio(DEFAULT_RATIO)
          saveRatio(DEFAULT_RATIO)
          window.dispatchEvent(new Event('resize'))
        }}
      >
        <span className="settlement-vsplit-grip" aria-hidden />
      </div>
      <section className="settlement-desk-column" aria-label="写信台幕布">
        {desk}
      </section>
      {footer ? (
        <div className="settlement-vsplit-footer-slot">{footer}</div>
      ) : null}
    </div>
  )
}
