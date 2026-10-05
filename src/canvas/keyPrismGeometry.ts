/**
 * Key 棱柱几何（页平面代理）——只有两层「门」节点：bookKey / queryKey。
 * briefKey / inferKey 都是有向边中桥（注意力窗），不是独立节点层。
 *
 * 闭环两条路径：
 *   找材料：book ──peek(Δ)──► brief锚  ··· decide(Δ) ──► book（回环）
 *   主推理：book ──ι──► … ──► query ──► brief/peek 材料（问题↔材料回环）
 */

import type { AttentionShellKind } from './surfaceGeometry'

/** 相对页平面的外移（决策/brief 锚平面） */
export const DECISION_PLANE_LIFT = 0.42
/** 相对决策面再外（query 壳点） */
export const QUERY_PLANE_LIFT = 0.72

/** 敞开面板相对中桥的横向错位（仅 panel） */
export const FACE_LATERAL = 0.55
/** peek / decide 平行回环的侧向分离，避免双向边重叠 */
export const LOOP_LATERAL = 0.12
/** 打开面板相对中桥再抬一点 */
export const FACE_OPEN_LIFT = 0.18

/**
 * peek  = 找材料出站：book → brief锚
 * decide = 组包回站：brief锚 → book（与 peek 形成闭环）
 * infer  = 主推理边：book → decision（ι 中桥）
 * brief  = decide 别名（兼容旧调用）
 */
export type PrismFace = 'peek' | 'decide' | 'infer' | 'brief'

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]
}

/**
 * 注意力窗锚点：输入 key → 输出 key 有向线段的几何中点。
 * 严禁靠近箭尖 / 箭尾 / 端点 key。
 */
export function edgeWindowMid(
  from: [number, number, number],
  to: [number, number, number],
): [number, number, number] {
  return lerp3(from, to, 0.5)
}

export function decisionAnchorFromBook(
  bookCenter: [number, number, number],
): [number, number, number] {
  return [
    bookCenter[0],
    bookCenter[1],
    bookCenter[2] + DECISION_PLANE_LIFT,
  ]
}

export function queryAnchorFromBook(
  bookCenter: [number, number, number],
): [number, number, number] {
  return [
    bookCenter[0],
    bookCenter[1],
    bookCenter[2] + QUERY_PLANE_LIFT,
  ]
}

function offsetX(
  p: [number, number, number],
  dx: number,
): [number, number, number] {
  return [p[0] + dx, p[1], p[2]]
}

/**
 * 侧面中桥：chip 严格在有向边 from→to 中点。
 */
export function faceBridgePoint(
  bookCenter: [number, number, number],
  face: PrismFace,
  open: boolean,
): {
  from: [number, number, number]
  to: [number, number, number]
  mid: [number, number, number]
  panel: [number, number, number]
  /** 边语义：peek | decide | infer */
  job: 'peek' | 'decide' | 'infer'
} {
  const decision = decisionAnchorFromBook(bookCenter)
  const kind = face === 'brief' ? 'decide' : face

  if (kind === 'peek') {
    // 出站找材料：book ──► brief锚；Δ = peek 注意力窗
    const from = offsetX(bookCenter, LOOP_LATERAL)
    const to = offsetX(decision, LOOP_LATERAL)
    const mid = edgeWindowMid(from, to)
    const panel: [number, number, number] = open
      ? [mid[0] + FACE_LATERAL, mid[1], mid[2] + FACE_OPEN_LIFT]
      : mid
    return { from, to, mid, panel, job: 'peek' }
  }

  if (kind === 'decide') {
    // 回站组包：brief锚 ──► book；与 peek 平行反向，形成闭环
    const from = offsetX(decision, -LOOP_LATERAL)
    const to = offsetX(bookCenter, -LOOP_LATERAL)
    const mid = edgeWindowMid(from, to)
    const panel: [number, number, number] = open
      ? [mid[0] + FACE_LATERAL, mid[1], mid[2] + FACE_OPEN_LIFT]
      : mid
    return { from, to, mid, panel, job: 'decide' }
  }

  // infer：book ──► decision；ι 中桥
  const from = bookCenter
  const to = decision
  const mid = edgeWindowMid(from, to)
  const panel: [number, number, number] = open
    ? [mid[0] - FACE_LATERAL, mid[1], mid[2] + FACE_OPEN_LIFT]
    : mid
  return { from, to, mid, panel, job: 'infer' }
}

export type KeyLayerKind = 'book' | 'decision' | 'query'

export const KEY_LAYER_TO_SHELL: Record<
  KeyLayerKind,
  AttentionShellKind | 'inner'
> = {
  book: 'inner',
  decision: 'comment',
  query: 'mainInfer',
}
