/**
 * 热启 peek：seedRange 草案（可半开）→ 台晚执行闭集 → 书序 bookKey[]。
 *
 * - 早写：decide 可吐 closed | open_low(−∞,k] | open_high[k,+∞)
 * - 晚执行：并行 decide 草案汇齐后，锚点 brief 须已读（非 unread），台配对成闭集
 * - peek 只吃闭集 {from,to}
 */

import type { BookIndex, AChunk } from '../reasoning/pipelineA'
import { isRetrievableAtom } from '../reasoning/hybridRetrieve'
import { mapBriefToBook, doorHasBrief } from '../reasoning/masterTableMap'

/** 热启区间两端：实验下为 bookKey（亦可兼容旧 briefKey） */
export type SeedRange = { from: string; to: string }

/**
 * toc_nav / 台侧导航：校准后机器牌 strand 闭区间。
 * A1 字段名仍为 chunk.page，语义即 strand。
 */
export type StrandRange = { fromStrand: number; toStrand: number }

/** decide 早写草案（可半开） */
export type SeedRangeDraft =
  | { kind: 'closed'; from: string; to: string }
  | { kind: 'open_low'; to: string }
  | { kind: 'open_high'; from: string }

const DEFAULT_MAX_KEYS = 24

const OPEN_LO = new Set([
  '',
  '-inf',
  '-∞',
  '-infinity',
  'neg_inf',
  'open_low',
  'open-lo',
  '*',
  '−∞',
])
const OPEN_HI = new Set([
  '',
  '+inf',
  '+∞',
  '+infinity',
  'pos_inf',
  'inf',
  'infinity',
  '∞',
  'open_high',
  'open-hi',
  '*',
])

function sortChunks(chunks: AChunk[]): AChunk[] {
  return [...chunks].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page
    const dy = a.bbox[1] - b.bbox[1]
    if (Math.abs(dy) > 8) return dy
    return a.bbox[0] - b.bbox[0] || a.slotK - b.slotK
  })
}

/** A1 书序门牌（可检索） */
export function orderedRetrievableBookKeys(bookIndex: BookIndex): string[] {
  return sortChunks(bookIndex.chunks)
    .filter((c) => isRetrievableAtom(c))
    .map((c) => c.key)
}

/** 端点 → bookKey：已是书序门牌，或旧 brief map */
export function resolveSeedEndpointToBookKey(
  docId: string,
  bookIndex: BookIndex,
  key: string,
): string | null {
  const k = key.trim()
  if (!k) return null
  const ordered = orderedRetrievableBookKeys(bookIndex)
  if (ordered.includes(k)) return k
  return mapBriefToBook(docId, k)?.bookKey?.trim() || null
}

function normEndpoint(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
}

function isOpenLoToken(s: string): boolean {
  return OPEN_LO.has(s)
}

function isOpenHiToken(s: string): boolean {
  return OPEN_HI.has(s)
}

/**
 * 解析 decide 早写草案。
 * 半开：from 为 −∞ 类 / 缺省 → open_low；to 为 +∞ 类 / 缺省 → open_high。
 * 双端都有限 → closed。
 */
export function parseSeedRangeDraft(raw: unknown): SeedRangeDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const kindHint = String(o.kind ?? o.open ?? o.side ?? '')
    .trim()
    .toLowerCase()
  const fromRaw = o.from ?? o.start ?? o.lo ?? o.anchorFrom
  const toRaw = o.to ?? o.end ?? o.hi ?? o.anchorTo
  const fromNorm = normEndpoint(fromRaw)
  const toNorm = normEndpoint(toRaw)
  const fromKey = String(fromRaw ?? '').trim()
  const toKey = String(toRaw ?? '').trim()

  if (
    kindHint === 'open_low' ||
    kindHint === 'open-lo' ||
    kindHint === 'lo' ||
    kindHint === '-inf'
  ) {
    if (!toKey || isOpenHiToken(toNorm) || isOpenLoToken(toNorm)) return null
    return { kind: 'open_low', to: toKey }
  }
  if (
    kindHint === 'open_high' ||
    kindHint === 'open-hi' ||
    kindHint === 'hi' ||
    kindHint === '+inf'
  ) {
    if (!fromKey || isOpenLoToken(fromNorm) || isOpenHiToken(fromNorm)) return null
    return { kind: 'open_high', from: fromKey }
  }

  const fromOpen = fromRaw == null || isOpenLoToken(fromNorm)
  const toOpen = toRaw == null || isOpenHiToken(toNorm)

  if (!fromOpen && !toOpen && fromKey && toKey) {
    return { kind: 'closed', from: fromKey, to: toKey }
  }
  if (fromOpen && !toOpen && toKey && !isOpenLoToken(toNorm)) {
    return { kind: 'open_low', to: toKey }
  }
  if (!fromOpen && toOpen && fromKey && !isOpenHiToken(fromNorm)) {
    return { kind: 'open_high', from: fromKey }
  }
  return null
}

/** @deprecated 仅闭集；半开请用 parseSeedRangeDraft */
export function parseSeedRange(raw: unknown): SeedRange | null {
  const d = parseSeedRangeDraft(raw)
  if (!d || d.kind !== 'closed') return null
  return { from: d.from, to: d.to }
}

/** 缺 seedRange 时：用队列首尾 / lastBriefKey 兜底两端（闭集） */
export function fallbackSeedRange(
  briefKeys: string[],
  lastBriefKey: string | null,
): SeedRange | null {
  const uniq = [...new Set(briefKeys.filter(Boolean))]
  if (uniq.length === 0) return null
  if (uniq.length === 1) {
    const only = uniq[0]!
    return { from: only, to: only }
  }
  if (lastBriefKey && uniq.includes(lastBriefKey)) {
    const i = uniq.indexOf(lastBriefKey)
    const from = uniq[Math.max(0, i - 1)]!
    return { from, to: lastBriefKey }
  }
  return { from: uniq[0]!, to: uniq[uniq.length - 1]! }
}

function briefBookOrderIndex(
  docId: string,
  bookIndex: BookIndex,
  endpointKey: string,
): number {
  const bookKey = resolveSeedEndpointToBookKey(docId, bookIndex, endpointKey)
  if (!bookKey) return -1
  return orderedRetrievableBookKeys(bookIndex).indexOf(bookKey)
}

function closedKey(c: SeedRange): string {
  return `${c.from}\0${c.to}`
}

/**
 * 写信台：并行 decide 草案 → 仅保留锚点已读 → 半开配对/已有闭集 → 闭集列表。
 * peek 只应消费返回的 closed[]。
 */
export function closeSeedRangeDrafts(input: {
  docId: string
  bookIndex: BookIndex
  drafts: SeedRangeDraft[]
  /** 锚点 brief 是否已读（非 unread）；未报态视为未读 */
  isBriefRead: (briefKey: string) => boolean
}): {
  closed: SeedRange[]
  droppedUnreadAnchors: string[]
  unpairedOpen: SeedRangeDraft[]
  note: string
} {
  const droppedUnreadAnchors: string[] = []
  const closed: SeedRange[] = []
  const openLows: Array<{ to: string; idx: number }> = []
  const openHighs: Array<{ from: string; idx: number }> = []
  const unpairedOpen: SeedRangeDraft[] = []
  const seenClosed = new Set<string>()

  const pushClosed = (from: string, to: string) => {
    const c = { from, to }
    const id = closedKey(c)
    if (seenClosed.has(id)) return
    seenClosed.add(id)
    closed.push(c)
  }

  for (const d of input.drafts) {
    if (d.kind === 'closed') {
      const aOk = input.isBriefRead(d.from)
      const bOk = input.isBriefRead(d.to)
      if (!aOk || !bOk) {
        if (!aOk) droppedUnreadAnchors.push(d.from)
        if (!bOk) droppedUnreadAnchors.push(d.to)
        continue
      }
      pushClosed(d.from, d.to)
      continue
    }
    if (d.kind === 'open_low') {
      if (!input.isBriefRead(d.to)) {
        droppedUnreadAnchors.push(d.to)
        continue
      }
      const idx = briefBookOrderIndex(input.docId, input.bookIndex, d.to)
      if (idx < 0) {
        unpairedOpen.push(d)
        continue
      }
      openLows.push({ to: d.to, idx })
      continue
    }
    if (d.kind === 'open_high') {
      if (!input.isBriefRead(d.from)) {
        droppedUnreadAnchors.push(d.from)
        continue
      }
      const idx = briefBookOrderIndex(input.docId, input.bookIndex, d.from)
      if (idx < 0) {
        unpairedOpen.push(d)
        continue
      }
      openHighs.push({ from: d.from, idx })
    }
  }

  // 半开配对：open_high[from,+∞) × open_low(−∞,to] 且书序 fromIdx ≤ toIdx → 闭集 [from,to]
  // 贪心：每个 high 配「≥ from 的最近 low」；每个 low 最多用一次
  openHighs.sort((a, b) => a.idx - b.idx)
  openLows.sort((a, b) => a.idx - b.idx)
  const usedLow = new Set<number>()
  const usedHigh = new Set<number>()
  for (let hi = 0; hi < openHighs.length; hi++) {
    const h = openHighs[hi]!
    let best = -1
    for (let li = 0; li < openLows.length; li++) {
      if (usedLow.has(li)) continue
      const l = openLows[li]!
      if (l.idx < h.idx) continue
      if (best < 0 || l.idx < openLows[best]!.idx) best = li
    }
    if (best < 0) continue
    usedHigh.add(hi)
    usedLow.add(best)
    pushClosed(h.from, openLows[best]!.to)
  }

  for (let hi = 0; hi < openHighs.length; hi++) {
    if (!usedHigh.has(hi)) unpairedOpen.push({ kind: 'open_high', from: openHighs[hi]!.from })
  }
  for (let li = 0; li < openLows.length; li++) {
    if (!usedLow.has(li)) unpairedOpen.push({ kind: 'open_low', to: openLows[li]!.to })
  }

  const note =
    `seedRange闭集化 · 草案×${input.drafts.length} → 闭集×${closed.length}` +
    (droppedUnreadAnchors.length
      ? ` · 锚点未读丢×${[...new Set(droppedUnreadAnchors)].length}`
      : '') +
    (unpairedOpen.length ? ` · 半开未配×${unpairedOpen.length}` : '')

  return {
    closed,
    droppedUnreadAnchors: [...new Set(droppedUnreadAnchors)],
    unpairedOpen,
    note,
  }
}

/**
 * strand 闭区间 ∩ A1（chunk.page = strand）→ 书序 bookKey[]。
 * 确定性集合运算；多段轮询取样，避免前缀独吞配额。
 */
export function expandStrandRangesToBookKeys(input: {
  bookIndex: BookIndex
  ranges: StrandRange[]
  maxKeys?: number
  docId?: string
  /**
   * 取样优先：走廊内问核命中的 bookKey 先入队（仍须 ∈ strand∩A1）。
   * 避免轮询先抽到标题/图脸而漏掉点名块。
   */
  preferKeys?: string[]
}): {
  bookKeys: string[]
  unopened: string[]
  opened: string[]
  /** 每段有效 span 的书序首尾 bookKey（供后续 seedRange 锚点） */
  usedClosed: SeedRange[]
  note: string
} {
  const maxKeys = input.maxKeys ?? DEFAULT_MAX_KEYS
  const ordered = orderedRetrievableBookKeys(input.bookIndex)
  const byKey = new Map(
    input.bookIndex.chunks.map((c) => [c.key, c] as const),
  )
  const hit = new Set<string>()
  const usedClosed: SeedRange[] = []
  const perRange: string[][] = []

  for (const raw of input.ranges) {
    let lo = Math.min(raw.fromStrand, raw.toStrand)
    let hi = Math.max(raw.fromStrand, raw.toStrand)
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
    lo = Math.max(0, Math.floor(lo))
    hi = Math.max(0, Math.floor(hi))
    const span: string[] = []
    for (const k of ordered) {
      const c = byKey.get(k)
      if (!c) continue
      if (c.page >= lo && c.page <= hi) {
        span.push(k)
        hit.add(k)
      }
    }
    if (span.length === 0) continue
    perRange.push(span)
    usedClosed.push({ from: span[0]!, to: span[span.length - 1]! })
  }

  let preferN = 0
  let slice: string[]
  if (perRange.length === 0) {
    slice = []
  } else {
    const picked: string[] = []
    const seen = new Set<string>()
    for (const k of input.preferKeys ?? []) {
      if (picked.length >= maxKeys) break
      if (!hit.has(k) || seen.has(k)) continue
      seen.add(k)
      picked.push(k)
      preferN++
    }
    if (hit.size <= maxKeys && preferN === 0) {
      slice = ordered.filter((k) => hit.has(k))
    } else if (hit.size <= maxKeys) {
      for (const k of ordered) {
        if (picked.length >= maxKeys) break
        if (!hit.has(k) || seen.has(k)) continue
        seen.add(k)
        picked.push(k)
      }
      slice = picked
    } else {
      let depth = 0
      while (picked.length < maxKeys) {
        let added = false
        for (const span of perRange) {
          if (depth >= span.length) continue
          const k = span[depth]!
          if (seen.has(k)) continue
          seen.add(k)
          picked.push(k)
          added = true
          if (picked.length >= maxKeys) break
        }
        if (!added) break
        depth++
      }
      slice = picked
    }
  }

  const opened: string[] = []
  const unopened: string[] = []
  const docId = input.docId ?? input.bookIndex.docId
  for (const k of slice) {
    if (doorHasBrief(docId, k)) opened.push(k)
    else unopened.push(k)
  }
  const bookKeys = [...unopened, ...opened]
  const fullDump = hit.size > 0 && hit.size <= maxKeys
  return {
    bookKeys,
    unopened,
    opened,
    usedClosed,
    note:
      `strand∩A1 ×${input.ranges.length} → 有效段×${usedClosed.length}` +
      (fullDump
        ? ` · 全量 N=${bookKeys.length}`
        : ` · 取样 N=${bookKeys.length}`) +
      `（未开 ${unopened.length} · 已开 ${opened.length}` +
      (preferN > 0 ? ` · 问核优先×${preferN}` : '') +
      `）`,
  }
}

/**
 * 多闭集 → 书序 bookKey 并集（单次热启 peek 窗）。
 * 任一端锚点 map 失败的闭集跳过。
 */
export function expandClosedSeedRangesToBookKeys(input: {
  docId: string
  bookIndex: BookIndex
  closed: SeedRange[]
  maxKeys?: number
}): {
  bookKeys: string[]
  unopened: string[]
  opened: string[]
  usedClosed: SeedRange[]
  note: string
} {
  const maxKeys = input.maxKeys ?? DEFAULT_MAX_KEYS
  const ordered = orderedRetrievableBookKeys(input.bookIndex)
  const hit = new Set<string>()
  const usedClosed: SeedRange[] = []

  /** 每条闭集各自成片；超 maxKeys 时按区间轮询取样，避免书序前缀独吞配额 */
  const perRange: string[][] = []
  for (const seed of input.closed) {
    const fromBook = resolveSeedEndpointToBookKey(
      input.docId,
      input.bookIndex,
      seed.from,
    )
    const toBook = resolveSeedEndpointToBookKey(
      input.docId,
      input.bookIndex,
      seed.to,
    )
    if (!fromBook || !toBook) continue
    let i0 = ordered.indexOf(fromBook)
    let i1 = ordered.indexOf(toBook)
    if (i0 < 0 || i1 < 0) continue
    if (i0 > i1) {
      const t = i0
      i0 = i1
      i1 = t
    }
    const span: string[] = []
    for (let i = i0; i <= i1; i++) {
      const k = ordered[i]!
      span.push(k)
      hit.add(k)
    }
    if (span.length > 0) {
      perRange.push(span)
      usedClosed.push(seed)
    }
  }

  let slice: string[]
  if (perRange.length === 0) {
    slice = []
  } else if (hit.size <= maxKeys) {
    slice = ordered.filter((k) => hit.has(k))
  } else {
    const picked: string[] = []
    const seen = new Set<string>()
    let depth = 0
    while (picked.length < maxKeys) {
      let added = false
      for (const span of perRange) {
        if (depth >= span.length) continue
        const k = span[depth]!
        if (seen.has(k)) continue
        seen.add(k)
        picked.push(k)
        added = true
        if (picked.length >= maxKeys) break
      }
      if (!added) break
      depth++
    }
    slice = picked
  }

  const unopened: string[] = []
  const opened: string[] = []
  for (const k of slice) {
    // 实验无 brief 时大多进 unopened；有旧 brief 的门仍标 opened
    if (doorHasBrief(input.docId, k)) opened.push(k)
    else unopened.push(k)
  }
  const bookKeys = [...unopened, ...opened]
  return {
    bookKeys,
    unopened,
    opened,
    usedClosed,
    note:
      `闭集×${usedClosed.length}/${input.closed.length} → 取样 N=${bookKeys.length}` +
      `（轮询·未开 ${unopened.length} · 已开 ${opened.length}）`,
  }
}

export function expandSeedRangeToBookKeys(input: {
  docId: string
  bookIndex: BookIndex
  seed: SeedRange
  maxKeys?: number
}): {
  bookKeys: string[]
  unopened: string[]
  opened: string[]
  note: string
} {
  const r = expandClosedSeedRangesToBookKeys({
    docId: input.docId,
    bookIndex: input.bookIndex,
    closed: [input.seed],
    maxKeys: input.maxKeys,
  })
  if (r.usedClosed.length === 0) {
    return {
      bookKeys: [],
      unopened: [],
      opened: [],
      note: `seedRange 硬闸：无法 map brief→book 或端点不在书序（from=${input.seed.from.slice(0, 12)}… to=${input.seed.to.slice(0, 12)}…）`,
    }
  }
  return {
    bookKeys: r.bookKeys,
    unopened: r.unopened,
    opened: r.opened,
    note: r.note,
  }
}

/** lastBriefKey 之后尚可续滚的 brief */
export function briefsAfterCursor(
  queue: string[],
  lastBriefKey: string | null,
): string[] {
  if (!lastBriefKey) return [...queue]
  const i = queue.indexOf(lastBriefKey)
  if (i < 0) return [...queue]
  return queue.slice(i + 1)
}
