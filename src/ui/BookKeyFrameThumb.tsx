/**
 * 结算用 bookKey 门面：物化语料页图，并保留 layout AABB 框框。
 * 视口略放大到门周围，框仍画在 page_norm 精确位置上。
 */

import { useEffect, useMemo, useState } from 'react'
import { useIndexGate } from '../reasoning/indexGate'
import { useDocuverse } from '../canvas/store'
import { peekPageImageDataUri } from '../data/pageImageVault'

function short(k: string, n = 14): string {
  const t = k.trim()
  if (t.length <= n) return t
  return `${t.slice(0, 5)}…${t.slice(-5)}`
}

/** page_norm 0–1000 → 相对视口的 % 框 */
function bboxInViewport(
  bbox: [number, number, number, number],
  view: [number, number, number, number],
): { left: string; top: string; width: string; height: string } {
  const [x0, y0, x1, y1] = bbox
  const [vx0, vy0, vx1, vy1] = view
  const vw = Math.max(1, vx1 - vx0)
  const vh = Math.max(1, vy1 - vy0)
  return {
    left: `${((x0 - vx0) / vw) * 100}%`,
    top: `${((y0 - vy0) / vh) * 100}%`,
    width: `${(Math.max(0, x1 - x0) / vw) * 100}%`,
    height: `${(Math.max(0, y1 - y0) / vh) * 100}%`,
  }
}

function padViewport(
  bbox: [number, number, number, number],
  pad = 48,
): [number, number, number, number] {
  const [x0, y0, x1, y1] = bbox
  return [
    Math.max(0, x0 - pad),
    Math.max(0, y0 - pad),
    Math.min(1000, x1 + pad),
    Math.min(1000, y1 + pad),
  ]
}

export function BookKeyFrameThumb({ bookKey }: { bookKey: string }) {
  const bookIndex = useIndexGate((s) => s.bookIndex)
  const ensurePageForAudit = useDocuverse((s) => s.ensurePageForAudit)
  const pagesEpoch = useDocuverse(
    (s) => s.pages.map((p) => `${p.strandIndex}:${p.imageUrl ? 1 : 0}`).join('|'),
  )

  const chunk = useMemo(
    () => bookIndex?.chunks.find((c) => c.key === bookKey) ?? null,
    [bookIndex, bookKey],
  )
  const strand = chunk?.page
  const bbox = chunk?.bbox as [number, number, number, number] | undefined

  const [pageSrc, setPageSrc] = useState<string | null>(null)
  const [note, setNote] = useState<string>('物化中…')

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (strand == null || !bbox) {
        setNote('无 layout 门')
        setPageSrc(null)
        return
      }
      setNote('物化页图…')
      const r = await ensurePageForAudit(strand, { focus: false })
      if (cancelled) return
      const live =
        useDocuverse.getState().pages.find((p) => p.strandIndex === strand)
          ?.imageUrl ?? null
      const vault = peekPageImageDataUri(strand)
      const src = live || vault || null
      if (!src) {
        setPageSrc(null)
        setNote(r.ok ? '页图空' : r.note)
        return
      }
      setPageSrc(src)
      setNote('')
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [bookKey, strand, bbox?.[0], bbox?.[1], bbox?.[2], bbox?.[3], ensurePageForAudit, pagesEpoch])

  const view = useMemo((): [number, number, number, number] => {
    if (!bbox) return [0, 0, 1000, 1000]
    return padViewport(bbox, 56)
  }, [bbox?.[0], bbox?.[1], bbox?.[2], bbox?.[3]])

  const imgStyle = useMemo(() => {
    const [vx0, vy0, vx1, vy1] = view
    const vw = Math.max(1, vx1 - vx0)
    const vh = Math.max(1, vy1 - vy0)
    return {
      position: 'absolute' as const,
      left: `${(-vx0 / vw) * 100}%`,
      top: `${(-vy0 / vh) * 100}%`,
      width: `${(1000 / vw) * 100}%`,
      height: `${(1000 / vh) * 100}%`,
      maxWidth: 'none',
      objectFit: 'fill' as const,
    }
  }, [view])

  const frameStyle = useMemo(
    () => (bbox ? bboxInViewport(bbox, view) : null),
    [bbox?.[0], bbox?.[1], bbox?.[2], bbox?.[3], view],
  )

  return (
    <figure className="settlement-book-frame" title={bookKey}>
      <div className="settlement-book-frame-stage" aria-label={`bookKey ${bookKey}`}>
        {pageSrc && frameStyle ? (
          <>
            <img
              className="settlement-book-frame-page"
              src={pageSrc}
              alt=""
              draggable={false}
              style={imgStyle}
            />
            <div className="settlement-book-frame-bbox" style={frameStyle} />
          </>
        ) : (
          <span className="settlement-book-frame-pending">{note || '…'}</span>
        )}
      </div>
      <figcaption className="settlement-book-frame-cap">
        <code>{short(bookKey)}</code>
        {strand != null ? <span> · p{strand + 1}</span> : null}
      </figcaption>
    </figure>
  )
}
