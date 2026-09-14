/**
 * 从已调取面板挑两 key → 锚点 △ → construction 旅程。
 */

import { useDocuverse } from '../canvas/store'
import { useIndexGate } from './indexGate'
import { resolveKeyWorldAnchor } from './keyWorldAnchor'
import { usePanelSummonStore } from './panelSummonStore'

export function enterCompareForSummonedKeys(
  keyA?: string,
  keyB?: string,
): { ok: boolean; note: string } {
  const panels = usePanelSummonStore.getState().panels
  const shellStep = usePanelSummonStore.getState().shellStep
  const globalScale = usePanelSummonStore.getState().globalScale
  const bookIndex = useIndexGate.getState().bookIndex
  if (!bookIndex) return { ok: false, note: '无 BookIndex' }

  const aKey = keyA ?? panels[0]?.memberKeys[0]
  const bKey = keyB ?? panels[1]?.memberKeys[0]
  if (!aKey || !bKey) {
    return { ok: false, note: '至少调取两块面板才能对比' }
  }
  if (aKey === bKey) {
    return { ok: false, note: '请选两个不同的 key' }
  }

  const pageCount = Math.max(useDocuverse.getState().pages.length, 1)
  const activeKinds = panels.map((p) => p.keyKind)
  const ra = resolveKeyWorldAnchor({
    key: aKey,
    bookIndex,
    pageCount,
    globalScale,
    activeKinds,
    shellStep,
  })
  const rb = resolveKeyWorldAnchor({
    key: bKey,
    bookIndex,
    pageCount,
    globalScale,
    activeKinds,
    shellStep,
  })
  if (!ra.world || !rb.world) {
    return {
      ok: false,
      note: `缺锚：A(${ra.note}) · B(${rb.note})`,
    }
  }

  useDocuverse.getState().enterKeyCompareLens({
    keyA: aKey,
    keyB: bKey,
  })
  return {
    ok: true,
    note: `对比 ${ra.keyKind}↔${rb.keyKind} · 已进 construction`,
  }
}

/** shellStep 拉链拖动时刷新对比 △ */
export function refreshKeyCompareIfActive(): void {
  const pair = useDocuverse.getState().keyComparePair
  if (!pair) return
  const panels = usePanelSummonStore.getState().panels
  const shellStep = usePanelSummonStore.getState().shellStep
  const globalScale = usePanelSummonStore.getState().globalScale
  const bookIndex = useIndexGate.getState().bookIndex
  if (!bookIndex) return
  const pageCount = Math.max(useDocuverse.getState().pages.length, 1)
  const activeKinds = panels.map((p) => p.keyKind)
  const ra = resolveKeyWorldAnchor({
    key: pair.keyA,
    bookIndex,
    pageCount,
    globalScale,
    activeKinds,
    shellStep,
  })
  const rb = resolveKeyWorldAnchor({
    key: pair.keyB,
    bookIndex,
    pageCount,
    globalScale,
    activeKinds,
    shellStep,
  })
  if (!ra.world || !rb.world) return
  useDocuverse.getState().refreshKeyCompareTriangle({
    pointA: ra.world,
    pointB: rb.world,
  })
}
