import { useEffect } from 'react'
import { useDocuverse } from '../canvas/store'
import { isTextEditingTarget } from './textEditing'

export function KeyboardNav() {
  const stepConnection = useDocuverse((s) => s.stepConnection)
  const flipToCompanion = useDocuverse((s) => s.flipToCompanion)
  const swapPages = useDocuverse((s) => s.swapPages)
  const setCameraDistance = useDocuverse((s) => s.setCameraDistance)
  const cameraDistance = useDocuverse((s) => s.cameraDistance)
  const orbit = useDocuverse((s) => s.orbit)
  const stepPage = useDocuverse((s) => s.stepPage)
  const swoopToPage = useDocuverse((s) => s.swoopToPage)
  const pages = useDocuverse((s) => s.pages)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 输入文本时：不拦截 H / G 及其他快捷键
      if (isTextEditingTarget(e.target)) return

      const k = e.key.toLowerCase()

      // 强调笔已并入 Space+G（与星图共存亡），单键 H 不再开关笔

      if (k === 'c') {
        e.preventDefault()
        stepConnection(1)
      } else if (k === 'e') {
        e.preventDefault()
        stepConnection(-1)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        // 建联：当前强调 → 端点 A，再 Space+G 开星图左键点 B
        const s = useDocuverse.getState()
        if (
          s.cameraLens === 'roaming' &&
          s.selectedEmphasisId &&
          !s.emphasizeMode
        ) {
          if (s.emphasisLinkFromId === s.selectedEmphasisId) {
            s.setEmphasisLinkFrom(null)
          } else {
            s.setEmphasisLinkFrom(s.selectedEmphasisId)
          }
          return
        }
        flipToCompanion()
      } else if (k === 'f') {
        e.preventDefault()
        flipToCompanion()
      } else if (k === 's' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        swapPages()
      } else if (e.key === '[') {
        e.preventDefault()
        stepPage(-1)
      } else if (e.key === ']') {
        e.preventDefault()
        stepPage(1)
      } else if (e.key >= '0' && e.key <= '9') {
        const idx = Number(e.key)
        if (idx < pages.length) {
          e.preventDefault()
          swoopToPage(idx)
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCameraDistance(cameraDistance * 0.82)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCameraDistance(cameraDistance * 1.22)
      } else if (e.key === 'Home') {
        e.preventDefault()
        setCameraDistance(18)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        orbit(0.12, 0)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        orbit(-0.12, 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    stepConnection,
    flipToCompanion,
    swapPages,
    setCameraDistance,
    cameraDistance,
    orbit,
    stepPage,
    swoopToPage,
    pages.length,
  ])

  return null
}
