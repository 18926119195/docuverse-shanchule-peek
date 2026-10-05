/**
 * 结算架：复用原球体交互（roaming + swoopToPage）。
 * 仅限制「哪些页上球」，不另造机位/点击逻辑。
 */

import type { BookIndex } from '../reasoning/pipelineA'
import { focusA1KeyOnPdf } from '../reasoning/focusA1Key'
import { useDocuverse } from './store'
import {
  clearPokerYawOffset,
  pageRadialDirection,
  radialToYawPitch,
  readingOuterRadius,
} from './geometry'

export type SettlementKind = 'reuse' | 'path'

type LockedSettlementFrame = {
  kind: SettlementKind
  activeBookKey: string
}

let locked: LockedSettlementFrame | null = null

function pageOfBookKey(
  bookKey: string,
  bookIndex: BookIndex,
): number | null {
  const chunk = bookIndex.chunks.find((c) => c.key === bookKey)
  return chunk ? chunk.page : null
}

/** 回到原球体机位，再按 strand swoop（与常态同一套） */
function ensureRoamingSphere() {
  useDocuverse.setState({
    cameraLens: 'roaming',
    cameraEye: null,
    cameraLookAt: null,
    constructionLinkId: null,
    keyComparePair: null,
    keyCompareTri: null,
    linkFocusId: null,
    viewPan: [0, 0, 0],
    commentLayerExpanded: false,
  })
}

function swoopLikeNormal(strand: number) {
  ensureRoamingSphere()
  const st = useDocuverse.getState()
  if (st.currentStrand !== strand) {
    st.swoopToPage(strand)
    return
  }
  // 同页：原 swoopToPage 会 early-return，补一次朝向
  const total = Math.max(st.pages.length, 1)
  const { yaw, pitch } = radialToYawPitch(pageRadialDirection(strand, total))
  useDocuverse.setState({
    swooping: true,
    viewYaw: yaw,
    viewPitch: pitch,
    viewPan: [0, 0, 0],
    cameraDistance: readingOuterRadius(total),
  })
  window.setTimeout(() => {
    useDocuverse.setState({ swooping: false })
  }, 1100)
}

async function prepareAuditPage(
  bookKey: string,
  bookIndex: BookIndex,
  focus: boolean,
): Promise<number | null> {
  const strand = pageOfBookKey(bookKey, bookIndex)
  if (strand == null) return null
  try {
    const { usePanelSummonStore } = await import(
      '../reasoning/panelSummonStore'
    )
    usePanelSummonStore.getState().dismissAll()
  } catch {
    /* ignore */
  }
  await useDocuverse.getState().ensurePageForAudit(strand, { focus })
  useDocuverse.getState().registerAuditSphereStrand(strand)
  useDocuverse.getState().revealSphereForAudit()
  return strand
}

export async function enterSettlementSingleAnchor(input: {
  kind: SettlementKind
  bookKey: string
  bookIndex: BookIndex
}): Promise<boolean> {
  const strand = await prepareAuditPage(input.bookKey, input.bookIndex, true)
  if (strand == null) return false
  clearPokerYawOffset()
  locked = { kind: input.kind, activeBookKey: input.bookKey }
  swoopLikeNormal(strand)
  focusA1KeyOnPdf({
    key: input.bookKey,
    bookIndex: input.bookIndex,
    swoopToPage: (s) => swoopLikeNormal(s),
  })
  return true
}

/** 点球上页：与常态 swoop 相同 */
export function focusSettlementAuditStrand(strand: number): boolean {
  const st = useDocuverse.getState()
  if (!st.pages.some((p) => p.strandIndex === strand)) return false
  st.registerAuditSphereStrand(strand)
  st.revealSphereForAudit()
  clearPokerYawOffset()
  if (!locked) locked = { kind: 'path', activeBookKey: '' }
  swoopLikeNormal(strand)
  return true
}

export async function focusSettlementAuditBook(input: {
  bookKey: string
  bookIndex: BookIndex
}): Promise<boolean> {
  const strand = await prepareAuditPage(input.bookKey, input.bookIndex, true)
  if (strand == null) return false
  clearPokerYawOffset()
  locked = { kind: 'path', activeBookKey: input.bookKey }
  swoopLikeNormal(strand)
  focusA1KeyOnPdf({
    key: input.bookKey,
    bookIndex: input.bookIndex,
    swoopToPage: (s) => swoopLikeNormal(s),
  })
  return true
}

export async function settlementSelectBookKey(input: {
  bookKey: string
  bookIndex: BookIndex
}): Promise<boolean> {
  if (!locked) {
    return enterSettlementSingleAnchor({
      kind: 'path',
      bookKey: input.bookKey,
      bookIndex: input.bookIndex,
    })
  }
  return focusSettlementAuditBook(input)
}

export function getSettlementFrame(): LockedSettlementFrame | null {
  return locked
}

export function exitSettlementFrame(): void {
  locked = null
  clearPokerYawOffset()
  useDocuverse.getState().clearAuditSphereStrands()
  useDocuverse.getState().hideSphereAfterAudit()
  ensureRoamingSphere()
  useDocuverse.setState({
    settlementSphereEpoch: useDocuverse.getState().settlementSphereEpoch + 1,
  })
}
