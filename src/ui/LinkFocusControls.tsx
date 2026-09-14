import { useEffect } from 'react'
import { useDocuverse } from '../canvas/store'
import { isTextEditingTarget } from './textEditing'

type ChipMode = 'dragging' | 'parked' | 'focused' | 'street'

/**
 * Four presentation modes for purple links (plan §3):
 * street / focused / dragging / parked.
 */
export function LinkFocusControls() {
  const linkFocusId = useDocuverse((s) => s.linkFocusId)
  const draggingLinkId = useDocuverse((s) => s.draggingLinkId)
  const linkApexHistory = useDocuverse((s) => s.linkApexHistory)
  const links = useDocuverse((s) => s.emphasisLinks)
  const closeLinkFocus = useDocuverse((s) => s.closeLinkFocus)
  const clearLinkApex = useDocuverse((s) => s.clearLinkApex)
  const rollbackLinkApex = useDocuverse((s) => s.rollbackLinkApex)
  const swapLinkFocus = useDocuverse((s) => s.swapLinkFocus)

  const focused = links.find((l) => l.id === linkFocusId)
  const parkedCount = links.filter((l) => l.apex).length
  const canRollback = linkApexHistory.length > 0

  const mode: ChipMode | null = draggingLinkId
    ? 'dragging'
    : linkFocusId && focused?.apex
      ? 'parked'
      : linkFocusId
        ? 'focused'
        : parkedCount > 0 || canRollback
          ? 'street'
          : null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextEditingTarget(e.target)) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        if (canRollback) {
          e.preventDefault()
          rollbackLinkApex()
        }
        return
      }
      if (e.key === 'Escape') {
        if (useDocuverse.getState().emphasisLinkFromId) {
          // Workbench / 建联 A 优先
          return
        }
        if (canRollback) {
          e.preventDefault()
          rollbackLinkApex()
          return
        }
        if (linkFocusId && focused?.apex) {
          e.preventDefault()
          clearLinkApex(linkFocusId)
          return
        }
        if (linkFocusId) {
          e.preventDefault()
          closeLinkFocus()
        }
      } else if (
        (e.key === 's' || e.key === 'S' || e.key === 'f' || e.key === 'F') &&
        linkFocusId
      ) {
        e.preventDefault()
        swapLinkFocus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [
    linkFocusId,
    draggingLinkId,
    focused?.apex,
    canRollback,
    closeLinkFocus,
    clearLinkApex,
    rollbackLinkApex,
    swapLinkFocus,
  ])

  if (!mode) return null

  const title =
    mode === 'dragging'
      ? '拖拽 · 弹簧跟手'
      : mode === 'parked'
        ? '停泊 · 已拉离街面'
        : mode === 'focused'
          ? '聚焦 · 阅读关联'
          : `街面 · 已停泊簇 ${parkedCount}`

  const meta =
    mode === 'dragging'
      ? '松开锁定停泊 · Esc / ⌘Z 可回滚'
      : mode === 'parked'
        ? '短点未再锁；拖可改位 · Esc 回滚或回街面'
        : mode === 'focused'
          ? '尚未停泊 · 拖紫线过阈值才锁定 · Esc 退出聚焦'
          : '短点紫线聚焦 · 拖过阈值编排三角簇'

  return (
    <div className={`link-focus-chip mode-${mode}`} role="status">
      <span className="link-focus-mode">{title}</span>
      <span className="meta">{meta}</span>
      {canRollback && (
        <button
          type="button"
          className="upload-btn"
          onClick={() => rollbackLinkApex()}
        >
          返回上一个位置
        </button>
      )}
      {linkFocusId && focused?.apex && (
        <button
          type="button"
          className="corpus-chip"
          onClick={() => clearLinkApex(linkFocusId)}
        >
          回街面原序
        </button>
      )}
      {linkFocusId && !draggingLinkId && (
        <button type="button" className="corpus-chip" onClick={swapLinkFocus}>
          交换主伴
        </button>
      )}
      {linkFocusId && !focused?.apex && !draggingLinkId && (
        <button type="button" className="corpus-chip" onClick={closeLinkFocus}>
          退出聚焦
        </button>
      )}
    </div>
  )
}
