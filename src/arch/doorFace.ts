/**
 * 门面几何（权威）：任意 key 的可视化窗口矩形 = 它的 door bbox。
 * bookKey 用 page_norm；brief/prospect/infer/query… 用 panel_norm。
 * 强调笔相对已有门的分解与基底无关——同一套 hit / blank / rel / combo。
 */

export type DoorCoordSpace = 'page_norm_0_1000' | 'panel_norm_0_1'

/** 轴对齐框；page 常为 0–1000，panel 常为 0–1 */
export type NormBBox = [number, number, number, number]
export type NormRel = [number, number, number, number]

/** 一扇门：页上 layout 槽，或注意力面板整卡 / 卡上子区 */
export type DoorFace = {
  doorKey: string
  aabb: NormBBox
  coordSpace: DoorCoordSpace
  /** 页上门：layout 步序 */
  layoutK?: number
  /** 面板子门：挂在哪扇父 key 上 */
  parentKey?: string
}

export type EmphasizeCoverage =
  | 'hit_existing'
  | 'uncovered_needs_confirm'
  | 'mixed_hit_and_uncovered'

/** 强调笔占某门 bbox 中的一块 = E ∩ D（只指针，不铸） */
export type EmphasizeOnDoorPiece = {
  doorKey: string
  layoutK?: number
  parentKey?: string
  doorAabb: NormBBox
  pieceAabb: NormBBox
  /** 门内相对位置 [u0,v0,u1,v1] ∈ [0,1]⁴ */
  rel: NormRel
  fracOfDoor: number
  fracOfEmphasize: number
}

export type EmphasizeDoorDecomposition = {
  emphasizeAabb: NormBBox
  onDoors: EmphasizeOnDoorPiece[]
  blankAabbs: NormBBox[]
  blankUnionAabb: NormBBox | null
  coverage: EmphasizeCoverage
}

export type EmphasizeReuseDoorMember = {
  kind: 'reuse'
  doorKey: string
  layoutK?: number
  parentKey?: string
  doorAabb: NormBBox
  pieceAabb: NormBBox
  rel: NormRel
}

export type EmphasizeBlankDoorMember = {
  kind: 'blank'
  aabb: NormBBox
  blankAabbs: NormBBox[]
  /** 确认后填子门 / 新 bookKey */
  doorKey?: string
  layoutK?: number
}

export type EmphasizeDoorRegionBinding = {
  emphasizeAabb: NormBBox
  coverage: EmphasizeCoverage
  reuse: EmphasizeReuseDoorMember[]
  blank: EmphasizeBlankDoorMember | null
  regionKey?: string
  regionMemberKeys: string[]
}

export const DOOR_FACE_RULE = {
  substrate: 'door_aabb_in_coord_space' as const,
  emphasizeHitsDoor: true,
  emphasizeBlankOnlyMint: true,
  emphasizeUncoveredNeedsConfirm: true,
  remintDoorOnEmphasizeStroke: false,
  /** 区域身份 = 指针∪空白新门 的 combo（或单门） */
  emphasizeRegionIsCombo: true,
} as const

/** 注意力面板默认整卡门框（panel_norm） */
export const PANEL_UNIT_DOOR: NormBBox = [0, 0, 1, 1]

export function aabbArea(b: NormBBox): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
}

export function aabbOverlapArea(a: NormBBox, b: NormBBox): number {
  const x0 = Math.max(a[0], b[0])
  const y0 = Math.max(a[1], b[1])
  const x1 = Math.min(a[2], b[2])
  const y1 = Math.min(a[3], b[3])
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
}

export function aabbIntersection(a: NormBBox, b: NormBBox): NormBBox | null {
  const x0 = Math.max(a[0], b[0])
  const y0 = Math.max(a[1], b[1])
  const x1 = Math.min(a[2], b[2])
  const y1 = Math.min(a[3], b[3])
  if (x1 <= x0 || y1 <= y0) return null
  return [x0, y0, x1, y1]
}

export function aabbUnionBounds(boxes: NormBBox[]): NormBBox | null {
  if (boxes.length === 0) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b[0])
    y0 = Math.min(y0, b[1])
    x1 = Math.max(x1, b[2])
    y1 = Math.max(y1, b[3])
  }
  if (!(x1 > x0 && y1 > y0)) return null
  return [x0, y0, x1, y1]
}

/** piece 相对门框的归一化矩形 */
export function aabbToRelInDoor(piece: NormBBox, doorAabb: NormBBox): NormRel {
  const [bx0, by0, bx1, by1] = doorAabb
  const bw = Math.max(1e-6, bx1 - bx0)
  const bh = Math.max(1e-6, by1 - by0)
  const clamp01 = (t: number) => Math.max(0, Math.min(1, t))
  return [
    clamp01((piece[0] - bx0) / bw),
    clamp01((piece[1] - by0) / bh),
    clamp01((piece[2] - bx0) / bw),
    clamp01((piece[3] - by0) / bh),
  ]
}

/** 门框 B + rel → 反算 pieceAabb（同坐标空间） */
export function relToDoorAabb(rel: NormRel, doorAabb: NormBBox): NormBBox {
  const [bx0, by0, bx1, by1] = doorAabb
  const bw = bx1 - bx0
  const bh = by1 - by0
  return [
    bx0 + rel[0] * bw,
    by0 + rel[1] * bh,
    bx0 + rel[2] * bw,
    by0 + rel[3] * bh,
  ]
}

export function subtractOneAabb(outer: NormBBox, hole: NormBBox): NormBBox[] {
  const inter = aabbIntersection(outer, hole)
  if (!inter) return [outer]
  if (
    inter[0] <= outer[0] &&
    inter[1] <= outer[1] &&
    inter[2] >= outer[2] &&
    inter[3] >= outer[3]
  ) {
    return []
  }
  const [ox0, oy0, ox1, oy1] = outer
  const [ix0, iy0, ix1, iy1] = inter
  const out: NormBBox[] = []
  if (iy0 > oy0) out.push([ox0, oy0, ox1, iy0])
  if (iy1 < oy1) out.push([ox0, iy1, ox1, oy1])
  if (ix0 > ox0) out.push([ox0, iy0, ix0, iy1])
  if (ix1 < ox1) out.push([ix1, iy0, ox1, iy1])
  return out.filter((b) => aabbArea(b) > 1e-6)
}

export function subtractAabbs(outer: NormBBox, holes: NormBBox[]): NormBBox[] {
  let parts: NormBBox[] = [outer]
  for (const hole of holes) {
    const next: NormBBox[] = []
    for (const p of parts) next.push(...subtractOneAabb(p, hole))
    parts = next
    if (parts.length === 0) break
  }
  return parts
}

/**
 * 强调笔相对已有门集合：
 *   E = ⋃ (E ∩ door_i)  ∪  blank
 */
export function decomposeEmphasizeAgainstDoors(
  emphasizeAabb: NormBBox,
  doors: DoorFace[],
): EmphasizeDoorDecomposition {
  const eArea = Math.max(1e-6, aabbArea(emphasizeAabb))
  const onDoors: EmphasizeOnDoorPiece[] = []
  const pieceHoles: NormBBox[] = []

  for (const door of doors) {
    const piece = aabbIntersection(emphasizeAabb, door.aabb)
    if (!piece || aabbArea(piece) <= 1e-6) continue
    const doorArea = Math.max(1e-6, aabbArea(door.aabb))
    onDoors.push({
      doorKey: door.doorKey,
      layoutK: door.layoutK,
      parentKey: door.parentKey,
      doorAabb: [...door.aabb] as NormBBox,
      pieceAabb: piece,
      rel: aabbToRelInDoor(piece, door.aabb),
      fracOfDoor: aabbArea(piece) / doorArea,
      fracOfEmphasize: aabbArea(piece) / eArea,
    })
    pieceHoles.push(piece)
  }

  const blankAabbs = subtractAabbs(emphasizeAabb, pieceHoles)
  const blankUnionAabb = aabbUnionBounds(blankAabbs)
  const hasPieces = onDoors.length > 0
  const hasBlank = blankAabbs.length > 0

  let coverage: EmphasizeCoverage
  if (hasPieces && hasBlank) coverage = 'mixed_hit_and_uncovered'
  else if (hasPieces) coverage = 'hit_existing'
  else coverage = 'uncovered_needs_confirm'

  return {
    emphasizeAabb,
    onDoors,
    blankAabbs,
    blankUnionAabb,
    coverage,
  }
}

export function decompositionToDoorRegionBinding(
  d: EmphasizeDoorDecomposition,
): EmphasizeDoorRegionBinding {
  const reuse: EmphasizeReuseDoorMember[] = d.onDoors.map((p) => ({
    kind: 'reuse' as const,
    doorKey: p.doorKey,
    layoutK: p.layoutK,
    parentKey: p.parentKey,
    doorAabb: p.doorAabb,
    pieceAabb: p.pieceAabb,
    rel: p.rel,
  }))
  const blank: EmphasizeBlankDoorMember | null =
    d.blankUnionAabb && d.blankAabbs.length > 0
      ? {
          kind: 'blank',
          aabb: d.blankUnionAabb,
          blankAabbs: d.blankAabbs,
        }
      : null

  return {
    emphasizeAabb: d.emphasizeAabb,
    coverage: d.coverage,
    reuse,
    blank,
    regionMemberKeys: reuse.map((r) => r.doorKey),
  }
}
