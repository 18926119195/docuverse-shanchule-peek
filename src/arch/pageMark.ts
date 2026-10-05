/**
 * 页上划重点共享基底（权威）：
 *
 * 纯空间：同一份未改版 PDF 的某一页（docId + page）+ page_norm bbox。
 * 时间化划重点 —— layout 与 emphasize **同级 peer**。
 *
 * 强调笔相对已有 bookKey 的分解 = 通用 DoorFace 分解（见 doorFace.ts）：
 *   emphasize.aabb
 *     = ⋃_i (emphasize ∩ bookKey_i.bbox)   ← 占该门 bbox 的哪一块（指针+rel）
 *     ∪ blank                               ← 仅空白可铸新门
 *
 * 强调笔区域身份 = combo( 指针门…, 空白新门? )，不是把整圈再铸成一门。
 * bookKey 的「门」= layout bbox；注意力面板的「门」= 可视化窗口矩形（同构）。
 */

import type { BookKeyCoord } from './bookKey'
import {
  aabbArea,
  aabbIntersection,
  aabbOverlapArea,
  aabbToRelInDoor,
  aabbUnionBounds,
  decomposeEmphasizeAgainstDoors,
  decompositionToDoorRegionBinding,
  relToDoorAabb,
  subtractAabbs,
  subtractOneAabb,
  type DoorFace,
  type EmphasizeCoverage,
  type EmphasizeDoorDecomposition,
  type NormBBox,
  type NormRel,
} from './doorFace'

export type PageNormBBox = NormBBox
export type PageNormPoint = [number, number]
/** 相对某 bookKey bbox 的门内归一化矩形 [u0,v0,u1,v1] ∈ [0,1]⁴ */
export type PageNormRel = NormRel

export type { EmphasizeCoverage }

export type PageMarkKind = 'layout' | 'emphasize'

/** 一笔划重点（layout 或强调笔）——同级时间事件 */
export type PageMark = {
  markId: string
  kind: PageMarkKind
  docId: string
  page: number
  aabb: PageNormBBox
  polygon?: PageNormPoint[]
  createdAt: number
  layoutK?: number
  /** layout 槽门牌；或强调笔挂上的空白新门 / 单指针门 */
  bookKey?: string
  /**
   * 强调笔区域把手：单门或 combo(指针∪空白新门)。
   * 有 regionKey 时以它为「这一圈」的身份；bookKey 可能只是 blank 成员。
   */
  regionKey?: string
  regionMemberKeys?: string[]
}

/** 强调笔占某个已有 bookKey 的 bbox 中的哪一块 = E ∩ B（只指针，不铸） */
export type EmphasizeOnBookKeyPiece = {
  bookKey: string
  layoutK?: number
  /** 该 bookKey 的完整 bbox */
  bookKeyAabb: PageNormBBox
  /** 强调笔在该门上的占块（page_norm） */
  pieceAabb: PageNormBBox
  /** 门内相对位置：机器可读，反算回 page */
  rel: PageNormRel
  /** piece 占 bookKey 面积比（不能单独定位） */
  fracOfBookKey: number
  /** piece 占强调笔面积比 */
  fracOfEmphasize: number
}

/** 区域成员：指回已有门（带门内块） */
export type EmphasizeReuseMember = {
  kind: 'reuse'
  bookKey: string
  layoutK?: number
  bookKeyAabb: PageNormBBox
  pieceAabb: PageNormBBox
  rel: PageNormRel
}

/** 区域成员：空白新门（确认后填 bookKey） */
export type EmphasizeBlankMember = {
  kind: 'blank'
  aabb: PageNormBBox
  blankAabbs: PageNormBBox[]
  bookKey?: string
  layoutK?: number
}

export type EmphasizeRegionMember = EmphasizeReuseMember | EmphasizeBlankMember

/**
 * 强调笔区域绑定：
 * 指针成员 +（可选）空白铸门 → 合成 regionKey（combo 或单门）
 */
export type EmphasizeRegionBinding = {
  emphasizeAabb: PageNormBBox
  coverage: EmphasizeCoverage
  reuse: EmphasizeReuseMember[]
  blank: EmphasizeBlankMember | null
  /** 已齐（无待确认空白，或空白已铸）时的区域把手 */
  regionKey?: string
  regionMemberKeys: string[]
}

/** 强调笔 bbox 的完整分解 */
export type EmphasizeAabbDecomposition = {
  emphasizeAabb: PageNormBBox
  onBookKeys: EmphasizeOnBookKeyPiece[]
  blankAabbs: PageNormBBox[]
  blankUnionAabb: PageNormBBox | null
  coverage: EmphasizeCoverage
}

export const PAGE_MARK_RULE = {
  substrate: 'docId+page+page_norm_bbox' as const,
  peers: ['layout', 'emphasize'] as const,
  mintFormula: 'layout_coord_seal' as const,
  layoutAutoMint: true,
  emphasizeHitsLayout: true,
  /** 仅空白可铸；占块只指针 */
  emphasizeBlankOnlyMint: true,
  emphasizeUncoveredNeedsConfirm: true,
  emphasizeMixedDecompose: true,
  /** 区域身份 = 指针∪空白新门 的 combo（或单门） */
  emphasizeRegionIsCombo: true,
  remintBookKeyOnEmphasizeStroke: false,
  /** 门面几何与注意力面板同构（doorFace） */
  doorFaceIsomorphic: true,
} as const

export {
  aabbArea,
  aabbIntersection,
  aabbOverlapArea,
  aabbUnionBounds,
  subtractAabbs,
  subtractOneAabb,
}

/** @deprecated 用 aabbToRelInDoor；保留 book 语义别名 */
export function aabbToRelInBookKey(
  piece: PageNormBBox,
  bookKeyAabb: PageNormBBox,
): PageNormRel {
  return aabbToRelInDoor(piece, bookKeyAabb)
}

/** @deprecated 用 relToDoorAabb */
export function relToPageAabb(
  rel: PageNormRel,
  bookKeyAabb: PageNormBBox,
): PageNormBBox {
  return relToDoorAabb(rel, bookKeyAabb)
}

export type LayoutSlotGeom = {
  bookKey: string
  aabb: PageNormBBox
  layoutK?: number
}

function slotsToDoors(slots: LayoutSlotGeom[]): DoorFace[] {
  return slots.map((s) => ({
    doorKey: s.bookKey,
    aabb: s.aabb,
    coordSpace: 'page_norm_0_1000' as const,
    layoutK: s.layoutK,
  }))
}

function doorDecompToBook(
  d: EmphasizeDoorDecomposition,
): EmphasizeAabbDecomposition {
  return {
    emphasizeAabb: d.emphasizeAabb,
    onBookKeys: d.onDoors.map((p) => ({
      bookKey: p.doorKey,
      layoutK: p.layoutK,
      bookKeyAabb: p.doorAabb,
      pieceAabb: p.pieceAabb,
      rel: p.rel,
      fracOfBookKey: p.fracOfDoor,
      fracOfEmphasize: p.fracOfEmphasize,
    })),
    blankAabbs: d.blankAabbs,
    blankUnionAabb: d.blankUnionAabb,
    coverage: d.coverage,
  }
}

/** 页上 layout 槽 = DoorFace；分解委托 doorFace（效果不变） */
export function decomposeEmphasizeAabbAgainstLayout(
  emphasizeAabb: PageNormBBox,
  slots: LayoutSlotGeom[],
): EmphasizeAabbDecomposition {
  return doorDecompToBook(
    decomposeEmphasizeAgainstDoors(emphasizeAabb, slotsToDoors(slots)),
  )
}

/** 分解 → 区域绑定草稿（空白未铸则无 regionKey） */
export function decompositionToRegionBinding(
  d: EmphasizeAabbDecomposition,
): EmphasizeRegionBinding {
  const asDoor: EmphasizeDoorDecomposition = {
    emphasizeAabb: d.emphasizeAabb,
    onDoors: d.onBookKeys.map((p) => ({
      doorKey: p.bookKey,
      layoutK: p.layoutK,
      doorAabb: p.bookKeyAabb,
      pieceAabb: p.pieceAabb,
      rel: p.rel,
      fracOfDoor: p.fracOfBookKey,
      fracOfEmphasize: p.fracOfEmphasize,
    })),
    blankAabbs: d.blankAabbs,
    blankUnionAabb: d.blankUnionAabb,
    coverage: d.coverage,
  }
  const b = decompositionToDoorRegionBinding(asDoor)
  return {
    emphasizeAabb: b.emphasizeAabb,
    coverage: b.coverage,
    reuse: b.reuse.map((r) => ({
      kind: 'reuse' as const,
      bookKey: r.doorKey,
      layoutK: r.layoutK,
      bookKeyAabb: r.doorAabb,
      pieceAabb: r.pieceAabb,
      rel: r.rel,
    })),
    blank: b.blank
      ? {
          kind: 'blank' as const,
          aabb: b.blank.aabb,
          blankAabbs: b.blank.blankAabbs,
          bookKey: b.blank.doorKey,
          layoutK: b.blank.layoutK,
        }
      : null,
    regionKey: b.regionKey,
    regionMemberKeys: b.regionMemberKeys,
  }
}

export function layoutMarkId(coord: BookKeyCoord): string {
  return `mark_layout_p${coord.page}_k${coord.layoutK}`
}

export function makeLayoutPageMark(input: {
  docId: string
  page: number
  layoutK: number
  aabb: PageNormBBox
  bookKey: string
  createdAt?: number
}): PageMark {
  const coord = {
    docId: input.docId,
    page: input.page,
    layoutK: input.layoutK,
  }
  return {
    markId: layoutMarkId(coord),
    kind: 'layout',
    docId: input.docId,
    page: input.page,
    aabb: input.aabb,
    layoutK: input.layoutK,
    bookKey: input.bookKey,
    createdAt: input.createdAt ?? Date.now(),
  }
}

export function makeEmphasizePageMark(input: {
  markId: string
  docId: string
  page: number
  aabb: PageNormBBox
  polygon?: PageNormPoint[]
  createdAt?: number
  bookKey?: string
  layoutK?: number
  regionKey?: string
  regionMemberKeys?: string[]
}): PageMark {
  return {
    markId: input.markId,
    kind: 'emphasize',
    docId: input.docId,
    page: input.page,
    aabb: input.aabb,
    polygon: input.polygon,
    createdAt: input.createdAt ?? Date.now(),
    bookKey: input.bookKey,
    layoutK: input.layoutK,
    regionKey: input.regionKey,
    regionMemberKeys: input.regionMemberKeys,
  }
}

/** bookKey layout 槽 → DoorFace（供面板/页统一调用） */
export function layoutSlotAsDoorFace(slot: LayoutSlotGeom): DoorFace {
  return {
    doorKey: slot.bookKey,
    aabb: slot.aabb,
    coordSpace: 'page_norm_0_1000',
    layoutK: slot.layoutK,
  }
}
