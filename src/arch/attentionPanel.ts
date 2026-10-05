/**
 * 注意力面板 = 任意 key 的可视化门面。
 *
 * 壳层拓扑 = 落账邻接图（见 KEY_KIND_EDGES），两种看法：
 * ① 无 reuse：就是材料/推理单簇
 *   book — brief — prospect
 *     |                |
 *   infer ——— path ———┘
 * ② reuse 角：现问挂上同一簇的 path，neighbour 接史问；
 *   史问材料仍是上面那扇 book（不另画第二座 book）。
 * 几何间距 = shellStep（拉链可调）；未调取的中间种类收缩掉。
 */

import {
  PANEL_UNIT_DOOR,
  type DoorFace,
  type NormBBox,
} from './doorFace'

export type AttentionKeyKind =
  | 'book'
  | 'brief'
  | 'prospect'
  | 'infer'
  | 'query'
  | 'path'
  | 'norm'
  | 'neighbour'
  | 'reuse'
  | 'other'

/**
 * 种类邻接（无向）——与写信台挂靠一致。
 *
 * ① 单簇（无 reuse 时就是整图）：
 *   book — brief — prospect
 *     |                |
 *   infer ——— path ———┘
 *                |
 *              norm（监督铸 · 归一化推理）
 *
 * ② reuse 角：
 *   path — norm — reuse — query(now) — neighbour — query(historic)
 *   query — book
 */
export const KEY_KIND_EDGES: Array<[AttentionKeyKind, AttentionKeyKind]> = [
  ['book', 'brief'],
  ['brief', 'prospect'],
  ['book', 'infer'],
  ['infer', 'path'],
  ['prospect', 'path'],
  ['path', 'norm'],
  ['norm', 'reuse'],
  ['reuse', 'query'],
  ['query', 'neighbour'],
  /** 问线挂材料：现问/史问都落到①的 book，不是第二座 book */
  ['query', 'book'],
]

/** @deprecated 线性层序已废；保留空导出以免旧 import 崩。请用 KEY_KIND_EDGES。 */
export const KEY_KIND_ORDER: AttentionKeyKind[] = [
  'book',
  'brief',
  'prospect',
  'infer',
  'path',
  'norm',
  'reuse',
  'query',
  'neighbour',
  'other',
]

/** @deprecated 绝对比例；布局用 packAdjacentShellRatios */
export const KEY_SHELL_RATIO: Record<AttentionKeyKind, number> = {
  book: 1,
  brief: 1.22,
  prospect: 1.48,
  infer: 1.8,
  path: 1.8,
  norm: 1.92,
  neighbour: 2.05,
  reuse: 2.05,
  query: 2.2,
  other: 1.35,
}

/** 相邻壳默认步长（相对内球）；UI 拉链可改 */
export const ADJACENT_SHELL_STEP = 0.18

/**
 * 材料壳种类（占同心半径）。neighbour / reuse 是问线桥，不占新壳。
 */
export const MATERIALS_SHELL_KINDS: AttentionKeyKind[] = [
  'book',
  'brief',
  'prospect',
  'infer',
  'path',
  'norm',
  'query',
]

export const BRIDGE_KIND_SHELL_HOST: Partial<
  Record<AttentionKeyKind, AttentionKeyKind>
> = {
  neighbour: 'query',
  reuse: 'norm',
  other: 'brief',
}

/** 壳打包只用材料种类；桥种类映射到宿主壳半径 */
export function kindsForShellPacking(
  activeKinds: AttentionKeyKind[],
): AttentionKeyKind[] {
  const out: AttentionKeyKind[] = []
  for (const k of activeKinds) {
    const host = BRIDGE_KIND_SHELL_HOST[k]
    if (host) {
      if (!out.includes(host)) out.push(host)
      continue
    }
    if (MATERIALS_SHELL_KINDS.includes(k) && !out.includes(k)) out.push(k)
  }
  return out.length > 0 ? out : ['book']
}

export type AttentionPanel = {
  key: string
  keyKind: AttentionKeyKind
  faceText: string
  doorAabb: NormBBox
  hostBookKey?: string
  queryKey?: string
  createdAt: number
}

export function makeAttentionPanel(input: {
  key: string
  keyKind: AttentionKeyKind
  faceText: string
  doorAabb?: NormBBox
  hostBookKey?: string
  queryKey?: string
  createdAt?: number
}): AttentionPanel {
  return {
    key: input.key,
    keyKind: input.keyKind,
    faceText: input.faceText,
    doorAabb: input.doorAabb ?? [...PANEL_UNIT_DOOR],
    hostBookKey: input.hostBookKey,
    queryKey: input.queryKey,
    createdAt: input.createdAt ?? Date.now(),
  }
}

export function panelAsDoorFace(panel: AttentionPanel): DoorFace {
  return {
    doorKey: panel.key,
    aabb: panel.doorAabb,
    coordSpace: 'panel_norm_0_1',
    parentKey: panel.hostBookKey,
  }
}

export function panelChildDoorFace(input: {
  parentKey: string
  childKey: string
  aabb: NormBBox
  layoutK?: number
}): DoorFace {
  return {
    doorKey: input.childKey,
    aabb: input.aabb,
    coordSpace: 'panel_norm_0_1',
    parentKey: input.parentKey,
    layoutK: input.layoutK,
  }
}

function buildFullAdj(): Map<AttentionKeyKind, Set<AttentionKeyKind>> {
  const g = new Map<AttentionKeyKind, Set<AttentionKeyKind>>()
  const add = (a: AttentionKeyKind, b: AttentionKeyKind) => {
    if (!g.has(a)) g.set(a, new Set())
    if (!g.has(b)) g.set(b, new Set())
    g.get(a)!.add(b)
    g.get(b)!.add(a)
  }
  for (const [a, b] of KEY_KIND_EDGES) add(a, b)
  // other：弱挂 book，避免孤立
  add('other', 'book')
  return g
}

const FULL_ADJ = buildFullAdj()

/**
 * 收缩未在场的种类：删掉 inactive 节点，把它的邻居两两相连。
 * 于是 book…query 中间缺 brief 时，book 与更外层仍可经收缩路径相邻。
 */
export function induceActiveKindGraph(
  activeKinds: AttentionKeyKind[],
): Map<AttentionKeyKind, Set<AttentionKeyKind>> {
  const active = new Set(activeKinds)
  const g = new Map<AttentionKeyKind, Set<AttentionKeyKind>>()
  for (const k of active) g.set(k, new Set())

  // 复制全图到可变邻接
  const work = new Map<AttentionKeyKind, Set<AttentionKeyKind>>()
  for (const [k, ns] of FULL_ADJ) {
    work.set(k, new Set(ns))
  }

  const allNodes = [...work.keys()]
  for (const v of allNodes) {
    if (active.has(v)) continue
    const nbrs = [...(work.get(v) ?? [])]
    for (let i = 0; i < nbrs.length; i++) {
      for (let j = i + 1; j < nbrs.length; j++) {
        const a = nbrs[i]!
        const b = nbrs[j]!
        if (!work.has(a)) work.set(a, new Set())
        if (!work.has(b)) work.set(b, new Set())
        work.get(a)!.add(b)
        work.get(b)!.add(a)
      }
    }
    work.delete(v)
    for (const n of nbrs) work.get(n)?.delete(v)
  }

  for (const k of active) {
    const ns = work.get(k) ?? new Set()
    for (const n of ns) {
      if (active.has(n)) g.get(k)!.add(n)
    }
  }

  // 若收缩后仍不连通：把各分量挂到「含 book 的分量」或任意根上（弱连）
  const comps = connectedComponents(g)
  if (comps.length > 1) {
    const rootComp =
      comps.find((c) => c.includes('book')) ?? comps[0]!
    const root = rootComp[0]!
    for (const c of comps) {
      if (c === rootComp) continue
      const a = c[0]!
      g.get(root)!.add(a)
      g.get(a)!.add(root)
    }
  }

  return g
}

function connectedComponents(
  g: Map<AttentionKeyKind, Set<AttentionKeyKind>>,
): AttentionKeyKind[][] {
  const seen = new Set<AttentionKeyKind>()
  const out: AttentionKeyKind[][] = []
  for (const start of g.keys()) {
    if (seen.has(start)) continue
    const stack = [start]
    const comp: AttentionKeyKind[] = []
    seen.add(start)
    while (stack.length) {
      const v = stack.pop()!
      comp.push(v)
      for (const n of g.get(v) ?? []) {
        if (seen.has(n)) continue
        seen.add(n)
        stack.push(n)
      }
    }
    out.push(comp)
  }
  return out
}

/** BFS 深度：从 book（若在场）或任意种子 */
export function kindGraphDepths(
  activeKinds: AttentionKeyKind[],
): Map<AttentionKeyKind, number> {
  const uniq = [...new Set(activeKinds)]
  const depths = new Map<AttentionKeyKind, number>()
  if (uniq.length === 0) return depths
  if (uniq.length === 1) {
    depths.set(uniq[0]!, 0)
    return depths
  }

  const g = induceActiveKindGraph(uniq)
  const root = uniq.includes('book') ? 'book' : uniq[0]!
  const q: AttentionKeyKind[] = [root]
  depths.set(root, 0)
  while (q.length) {
    const v = q.shift()!
    const d = depths.get(v)!
    for (const n of g.get(v) ?? []) {
      if (depths.has(n)) continue
      depths.set(n, d + 1)
      q.push(n)
    }
  }
  // 未触达（理论不应）→ 顺延最大深+1
  let maxD = 0
  for (const d of depths.values()) maxD = Math.max(maxD, d)
  for (const k of uniq) {
    if (!depths.has(k)) depths.set(k, ++maxD)
  }
  return depths
}

/**
 * 在场种类 → 壳半径比。
 * 同深度（如 brief 与 infer 都邻 book）同半径；步长 = shellStep。
 */
export function packAdjacentShellRatios(
  activeKinds: AttentionKeyKind[],
  step = ADJACENT_SHELL_STEP,
): Map<AttentionKeyKind, number> {
  const s = Math.max(0.01, step)
  const depths = kindGraphDepths(activeKinds)
  const map = new Map<AttentionKeyKind, number>()
  for (const [kind, d] of depths) {
    map.set(kind, 1 + d * s)
  }
  return map
}

export function adjacentRatioForKind(
  kind: AttentionKeyKind,
  activeKinds?: AttentionKeyKind[],
  step = ADJACENT_SHELL_STEP,
): number {
  const s = Math.max(0.01, step)
  const host = BRIDGE_KIND_SHELL_HOST[kind] ?? kind
  if (!activeKinds || activeKinds.length === 0) {
    return host === 'book' ? 1 : 1 + s
  }
  const packed = packAdjacentShellRatios(
    kindsForShellPacking(activeKinds),
    s,
  )
  return packed.get(host) ?? (host === 'book' ? 1 : 1 + s)
}

/** @deprecated 线性下标已无意义；若仍调用则退回图深度 */
export function kindOrderIndex(kind: AttentionKeyKind): number {
  return kindGraphDepths([kind, 'book']).get(kind) ?? 0
}

export function shellRadiusForKind(
  kind: AttentionKeyKind,
  innerRadius: number,
  globalScale = 1,
  activeKinds?: AttentionKeyKind[],
  step = ADJACENT_SHELL_STEP,
): number {
  const ratio = adjacentRatioForKind(kind, activeKinds, step)
  return Math.max(1e-6, innerRadius * ratio * globalScale)
}

export function panelWorldAnchorFromHost(
  hostWorld: [number, number, number],
  kind: AttentionKeyKind,
  innerRadius: number,
  globalScale = 1,
  activeKinds?: AttentionKeyKind[],
  step = ADJACENT_SHELL_STEP,
  azimuthRad = 0,
): [number, number, number] {
  const len =
    Math.hypot(hostWorld[0], hostWorld[1], hostWorld[2]) || innerRadius
  const targetR = shellRadiusForKind(
    kind,
    innerRadius,
    globalScale,
    activeKinds,
    step,
  )
  const sc = targetR / len
  let x = hostWorld[0] * sc
  let y = hostWorld[1] * sc
  let z = hostWorld[2] * sc
  if (Math.abs(azimuthRad) > 1e-6) {
    const c = Math.cos(azimuthRad)
    const s = Math.sin(azimuthRad)
    const nx = x * c - z * s
    const nz = x * s + z * c
    x = nx
    z = nz
  }
  return [x, y, z]
}

/** queryKey → 稳定方位角（约 ±0.7rad 扇区） */
export function azimuthRadForQueryKey(queryKey?: string): number {
  const q = queryKey?.trim()
  if (!q) return 0
  let h = 2166136261
  for (let i = 0; i < q.length; i++) {
    h ^= q.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const u = (h >>> 0) / 0xffffffff
  return (u - 0.5) * 1.4
}

export function newPanelChildDoorKey(parentKey: string, k: number): string {
  return `${parentKey}|panel|k${k}`
}
