/**
 * key → 世界锚点
 *
 * 宿主 book 点 = bookKey 页 bbox → 内球世界坐标。
 * 壳上点 = 沿径向推到「当前已调取类型」打包后的相邻壳（中间未调取层不占位）。
 */

import {
  adjacentRatioForKind,
  azimuthRadForQueryKey,
  packAdjacentShellRatios,
  panelWorldAnchorFromHost,
  type AttentionKeyKind,
} from '../arch/attentionPanel'
import { pagePointToLocal } from '../data/emphasis'
import { innerSphereRadius, pageLocalToWorld, PAGE_H, PAGE_W } from '../canvas/geometry'
import { mapBriefToBook } from './masterTableMap'
import { useAttentionIo } from './attentionIoStore'
import type { BookIndex } from './pipelineA'

export type KeyAnchorResolve = {
  key: string
  keyKind: AttentionKeyKind
  /** 材料挂靠门；book 时等于自身 */
  hostBookKey: string | null
  faceText: string
  /** 页上宿主世界点（内球附近） */
  hostWorld: [number, number, number] | null
  /** 该类壳上的面板锚点（可作 construction A/B） */
  world: [number, number, number] | null
  ok: boolean
  note: string
}

function pickBbox(
  chunk: BookIndex['chunks'][number],
): [number, number, number, number] {
  const area = (b: [number, number, number, number]) =>
    Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
  const full = 0.82 * 1_000_000
  if (area(chunk.bbox) < full) return chunk.bbox
  const ink = (chunk.inkBoxes ?? []).find((b) => area(b) < full)
  return ink ?? chunk.bbox
}

/** bookKey → 页 bbox 中心的世界坐标 */
export function bookKeyHostWorld(
  bookKey: string,
  bookIndex: BookIndex,
  pageCount: number,
): [number, number, number] | null {
  const chunk = bookIndex.chunks.find((c) => c.key === bookKey)
  if (!chunk) return null
  const bbox = pickBbox(chunk)
  const cx = (bbox[0] + bbox[2]) / 2
  const cy = (bbox[1] + bbox[3]) / 2
  const [lx, ly] = pagePointToLocal([cx, cy], PAGE_W, PAGE_H)
  return pageLocalToWorld(chunk.page, Math.max(pageCount, 1), [lx, ly, 0.2])
}

/** 由门牌前缀或台账猜类型 */
export function inferAttentionKeyKind(key: string): AttentionKeyKind {
  const k = key.trim()
  if (!k) return 'other'
  if (k.includes('|slot|') || k.includes('|combo|') || k.includes('|fig|')) {
    return 'book'
  }
  if (k.startsWith('bh_')) return 'brief'
  if (k.startsWith('pk_')) return 'prospect'
  if (k.startsWith('ik_')) return 'infer'
  if (k.startsWith('ph_')) return 'path'
  if (k.startsWith('nk_')) return 'norm'
  if (k.startsWith('qk_')) return 'query'
  if (k.startsWith('ru_')) return 'reuse'
  if (k.startsWith('nb_')) return 'neighbour'
  return 'other'
}

function resolveHostAndFace(input: {
  key: string
  keyKind: AttentionKeyKind
  docId: string
}): { hostBookKey: string | null; faceText: string; note: string } {
  const { key, keyKind, docId } = input
  const st = useAttentionIo.getState()

  if (keyKind === 'book') {
    const chunkNote = 'book 自为宿主'
    return { hostBookKey: key, faceText: '', note: chunkNote }
  }

  if (keyKind === 'brief') {
    const hit = mapBriefToBook(docId, key)
    if (hit) {
      return {
        hostBookKey: hit.bookKey,
        faceText: hit.brief,
        note: 'brief→book',
      }
    }
    const edge = st.edges.find((e) => e.toKey === key)
    if (edge?.fromKey) {
      const step = st.steps.find((s) => s.id === edge.stepId)
      const out = step?.output.find((r) => r.key === key)
      return {
        hostBookKey: edge.fromKey,
        faceText: out?.text || '',
        note: 'brief←attention edge',
      }
    }
    return { hostBookKey: null, faceText: '', note: 'brief 无宿主 book' }
  }

  if (keyKind === 'prospect') {
    const p = st.prospects.find((x) => x.prospectKey === key)
    if (!p) {
      return { hostBookKey: null, faceText: '', note: 'prospect 未落账' }
    }
    const hit = mapBriefToBook(docId, p.briefKey)
    return {
      hostBookKey: hit?.bookKey ?? null,
      faceText: p.text,
      note: hit ? 'prospect→brief→book' : 'prospect 有文无 book',
    }
  }

  if (keyKind === 'infer') {
    const e = st.inferEdges.find((x) => x.inferKey === key)
    if (!e) {
      return { hostBookKey: null, faceText: '', note: 'infer 未落账' }
    }
    const host =
      e.fromBookKey ||
      e.bookKeys?.[0] ||
      null
    return {
      hostBookKey: host,
      faceText: e.infer || e.rationale || e.rightText || '',
      note: 'infer→fromBook',
    }
  }

  if (keyKind === 'path') {
    const path = st.paths.find((x) => x.pathKey === key)
    if (!path) {
      return { hostBookKey: null, faceText: '', note: 'path 未落账' }
    }
    const infer = st.inferEdges.find((x) => x.inferKey === path.inferKey)
    const host = infer?.fromBookKey || infer?.bookKeys?.[0] || null
    const prospect = st.prospects.find((x) => x.prospectKey === path.prospectKey)
    return {
      hostBookKey: host,
      faceText: prospect?.text || infer?.infer || path.pathKey,
      note: 'path→infer→book',
    }
  }

  if (keyKind === 'norm') {
    const norm = st.norms.find((x) => x.normKey === key)
    if (!norm) {
      return { hostBookKey: null, faceText: '', note: 'norm 未落账' }
    }
    const path = st.paths.find((x) => x.pathKey === norm.pathKey)
    const infer = path
      ? st.inferEdges.find((x) => x.inferKey === path.inferKey)
      : undefined
    return {
      hostBookKey: infer?.fromBookKey || infer?.bookKeys?.[0] || null,
      faceText: norm.text,
      note: 'norm→path→infer→book',
    }
  }

  if (keyKind === 'query') {
    const qText = st.settledQueries[key] ?? ''
    const infer = st.inferEdges.find((x) => x.queryKey === key)
    const host = infer?.fromBookKey || infer?.bookKeys?.[0] || null
    if (host) {
      return {
        hostBookKey: host,
        faceText: qText,
        note: 'query→infer材料门',
      }
    }
    // 无 infer 时：用本问 brief 挂靠的第一扇 book
    const briefs = st.queryKeyToBriefKeys[key] ?? []
    for (const bk of briefs) {
      const hit = mapBriefToBook(docId, bk)
      if (hit) {
        return {
          hostBookKey: hit.bookKey,
          faceText: qText,
          note: 'query→brief→book',
        }
      }
    }
    return {
      hostBookKey: null,
      faceText: qText,
      note: 'query 尚无材料锚',
    }
  }

  if (keyKind === 'reuse') {
    const link = st.queryReuseLinks.find((x) => x.reuseKey === key)
    if (!link) {
      return { hostBookKey: null, faceText: '', note: 'reuse 未落账' }
    }
    const norm = st.norms.find((x) => x.normKey === link.normKey)
    const path = st.paths.find((x) => x.pathKey === link.pathKey)
    const infer = path
      ? st.inferEdges.find((x) => x.inferKey === path.inferKey)
      : undefined
    return {
      hostBookKey: infer?.fromBookKey || infer?.bookKeys?.[0] || null,
      faceText: norm?.text || link.rationale || '',
      note: 'reuse→norm→path→infer',
    }
  }

  if (keyKind === 'neighbour') {
    const n = st.neighbours.find((x) => x.neighbourKey === key)
    if (!n) {
      return { hostBookKey: null, faceText: '', note: 'neighbour 未落账' }
    }
    const infer = st.inferEdges.find(
      (x) =>
        x.queryKey === n.historicQueryKey || x.queryKey === n.nowQueryKey,
    )
    return {
      hostBookKey: infer?.fromBookKey || infer?.bookKeys?.[0] || null,
      faceText: st.settledQueries[n.historicQueryKey] ?? n.neighbourKey,
      note: 'neighbour→historic infer',
    }
  }

  return { hostBookKey: null, faceText: '', note: '未知类型' }
}

/**
 * 任意 key → 壳上世界锚点。
 * 一对 key 各调一次，即得 construction 用的 A、B。
 */
export function resolveKeyWorldAnchor(input: {
  key: string
  bookIndex: BookIndex
  pageCount?: number
  keyKind?: AttentionKeyKind
  globalScale?: number
  /**
   * 当前已调取的类型集合：只对这些层打包相邻半径；
   * 未调取的中间层不占位。
   */
  activeKinds?: AttentionKeyKind[]
  /** 相邻壳几何步长（拉链）；默认 ADJACENT_SHELL_STEP */
  shellStep?: number
  /** 问线方位（同壳分扇区） */
  queryKeyForAzimuth?: string
}): KeyAnchorResolve {
  const key = input.key.trim()
  const keyKind = input.keyKind ?? inferAttentionKeyKind(key)
  const pageCount = Math.max(
    input.pageCount ?? input.bookIndex.chunks.reduce((m, c) => Math.max(m, c.page), 0) + 1,
    1,
  )
  const docId = input.bookIndex.docId
  const { hostBookKey, faceText, note } = resolveHostAndFace({
    key,
    keyKind,
    docId,
  })

  let hostWorld: [number, number, number] | null = null
  if (hostBookKey) {
    hostWorld = bookKeyHostWorld(hostBookKey, input.bookIndex, pageCount)
  }

  // book 正文：从 index 读 T
  let face = faceText
  if (keyKind === 'book') {
    const chunk = input.bookIndex.chunks.find((c) => c.key === key)
    face = chunk?.content?.trim() || ''
    hostWorld = bookKeyHostWorld(key, input.bookIndex, pageCount)
  }

  if (!hostWorld) {
    return {
      key,
      keyKind,
      hostBookKey,
      faceText: face,
      hostWorld: null,
      world: null,
      ok: false,
      note: `${note} · 无宿主世界点`,
    }
  }

  const activeKinds = input.activeKinds?.length
    ? input.activeKinds
    : [keyKind]
  const step = input.shellStep
  const ratio = adjacentRatioForKind(keyKind, activeKinds, step)
  const innerR = innerSphereRadius(pageCount)
  const az = azimuthRadForQueryKey(input.queryKeyForAzimuth)
  const world = panelWorldAnchorFromHost(
    hostWorld,
    keyKind,
    innerR,
    input.globalScale ?? 1,
    activeKinds,
    step,
    az,
  )

  return {
    key,
    keyKind,
    hostBookKey: hostBookKey ?? (keyKind === 'book' ? key : null),
    faceText: face,
    hostWorld,
    world,
    ok: true,
    note: `${note} · adjacent×${ratio.toFixed(2)} · az=${az.toFixed(2)} · step=${typeof step === 'number' ? step.toFixed(2) : 'def'} · in[${activeKinds.join(',')}]`,
  }
}

/** 两 key → A/B 锚点（建构前一步）；半径按这两类相邻打包 */
export function resolveKeyAnchorPair(input: {
  keyA: string
  keyB: string
  bookIndex: BookIndex
  pageCount?: number
  globalScale?: number
  activeKinds?: AttentionKeyKind[]
  shellStep?: number
}): {
  a: KeyAnchorResolve
  b: KeyAnchorResolve
  ok: boolean
  note: string
  packed: Map<AttentionKeyKind, number>
} {
  const kindA = inferAttentionKeyKind(input.keyA)
  const kindB = inferAttentionKeyKind(input.keyB)
  const activeKinds = [
    ...new Set([...(input.activeKinds ?? []), kindA, kindB]),
  ]
  const step = input.shellStep
  const packed = packAdjacentShellRatios(activeKinds, step)
  const a = resolveKeyWorldAnchor({
    key: input.keyA,
    bookIndex: input.bookIndex,
    pageCount: input.pageCount,
    globalScale: input.globalScale,
    activeKinds,
    shellStep: step,
  })
  const b = resolveKeyWorldAnchor({
    key: input.keyB,
    bookIndex: input.bookIndex,
    pageCount: input.pageCount,
    globalScale: input.globalScale,
    activeKinds,
    shellStep: step,
  })
  const ok = Boolean(a.ok && b.ok && a.world && b.world)
  return {
    a,
    b,
    ok,
    packed,
    note: ok
      ? `A=${a.keyKind}(${packed.get(kindA)?.toFixed(2)}) B=${b.keyKind}(${packed.get(kindB)?.toFixed(2)}) · 相邻壳`
      : `缺锚：A(${a.note}) · B(${b.note})`,
  }
}
