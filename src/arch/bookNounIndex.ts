/**
 * 书内名词表 · 材料面与 S₀ / S（无 LLM）。
 * 协议：docs/book-noun-pipeline-protocol-2026-09-14.md
 *
 * 建表产物只有 Draft `{ text }`：
 * - S₀：规则从 T 抠出的串
 * - S₁：LLM 默写 → 本批回配后的原文切片
 * 去重：ignore-case(text) 整串全等；禁止子串吞并。
 * 无 df；**建表不做 locate**。门牌在提问：`S_q` → NounHit 时再 locate。
 */

import type { BookIndex, AChunk } from '../reasoning/pipelineA'
import {
  atomSearchText,
  isRetrievableAtom,
} from '../reasoning/hybridRetrieve'

/** 一条名词 = 一条连续原文 */
export type BookNounDraft = {
  /** 书中连续原文（S₁=LLM 回配切片；S₀=规则抠出） */
  text: string
}

/** 问核定位后才有：Draft + 命中门牌 */
export type BookNounEntry = BookNounDraft & {
  bookKeys: string[]
}

/** 建库名词表：全程 Draft，不含 bookKeys */
export type BookNounIndex = {
  docId: string
  builtAt: number
  s0: BookNounDraft[]
  s1: BookNounDraft[]
  S: BookNounDraft[]
}

export type PlainText = { T: string }

const MASK_CHAR = '█'

const STOP_SURFACES = new Set(
  [
    'the',
    'and',
    'for',
    'with',
    'from',
    'that',
    'this',
    'these',
    'those',
    'dans',
    'les',
    'des',
    'une',
    'pour',
    'avec',
    'sur',
    'par',
    'est',
    'sont',
    '如何',
    '什么',
    '怎么',
    '怎样',
    '是否',
    '提到',
    '一个',
    '我们',
    '他们',
    '它们',
    '因为',
    '所以',
    '但是',
    '如果',
    '可以',
    '没有',
    '已经',
    '自己',
  ].map((s) => s.toLowerCase()),
)

export function nounCanonical(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function stripMarkupNoise(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** 仅纯原文 T；不含 bookKey / page（材料面与地址分离） */
export function collectPlainTexts(bookIndex: BookIndex): PlainText[] {
  const plains: PlainText[] = []
  for (const c of bookIndex.chunks) {
    if (!isRetrievableAtom(c)) continue
    const T = stripMarkupNoise(atomSearchText(c))
    if (T.trim().length < 4) continue
    plains.push({ T })
  }
  return plains
}

export function extractS0FromPlainTexts(plains: PlainText[]): BookNounDraft[] {
  const map = new Map<string, string>() // canon → first text
  const hit = new Map<string, number>()

  const bump = (raw: string) => {
    const text = raw.replace(/\s+/g, ' ').trim()
    if (!text || text.length < 2) return
    const canon = nounCanonical(text)
    if (STOP_SURFACES.has(canon)) return
    if (/^[\d\W_]+$/.test(text)) return
    if (!map.has(canon)) map.set(canon, text)
    hit.set(canon, (hit.get(canon) ?? 0) + 1)
  }

  for (const { T } of plains) {
    const latin =
      T.match(
        /\b[A-ZÁÉÍÓÚÄÖÜÂÊÎÔÛÀÈÌÒÙÇ][A-Za-zÁÉÍÓÚÄÖÜÂÊÎÔÛÀÈÌÒÙÄÖÜäöüâêîôûàèìòùç\-']{1,40}\b/g,
      ) ?? []
    for (const w of latin) bump(w)
    const cjk = T.match(/[\u4e00-\u9fff]{2,8}/g) ?? []
    for (const w of cjk) bump(w)
  }

  const drafts: BookNounDraft[] = []
  for (const [canon, text] of map) {
    if ((hit.get(canon) ?? 0) >= 80 && canon.length <= 2) continue
    drafts.push({ text })
  }
  drafts.sort((a, b) => nounCanonical(a.text).localeCompare(nounCanonical(b.text)))
  return drafts
}

export function extractS0FromBookIndex(bookIndex: BookIndex): BookNounDraft[] {
  return extractS0FromPlainTexts(collectPlainTexts(bookIndex))
}

/**
 * 问核用：用 draft.text 在 A1 上定位门牌。
 * **不进建表**；仅 `S_q` → NounHit 等提问链路调用。
 */
export function attachBookKeysByLocate(
  drafts: BookNounDraft[],
  bookIndex: BookIndex,
): BookNounEntry[] {
  const chunks = bookIndex.chunks.filter((c) => isRetrievableAtom(c))
  return drafts.map((d) => {
    const needle = d.text.trim()
    if (!needle || needle.length < 2) return { text: d.text, bookKeys: [] }
    const keys = new Set<string>()
    const lowerNeedle = needle.toLowerCase()
    for (const c of chunks) {
      const hay = stripMarkupNoise(atomSearchText(c))
      if (hay.toLowerCase().indexOf(lowerNeedle) < 0) continue
      keys.add(c.key)
    }
    return { text: needle, bookKeys: [...keys] }
  })
}

export function maskSurfacesInText(
  text: string,
  surfaces: Iterable<string>,
): string {
  const list = [...surfaces]
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .sort((a, b) => b.length - a.length)
  if (list.length === 0) return text
  let out = text
  for (const s of list) {
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(escaped, 'gi')
    out = out.replace(re, (m) => MASK_CHAR.repeat(Math.max(1, m.length)))
  }
  return out
}

export function buildResidualPlainTexts(
  plains: PlainText[],
  s0: BookNounDraft[],
): PlainText[] {
  const surfaces = s0.map((e) => e.text)
  return plains.map((p) => ({ T: maskSurfacesInText(p.T, surfaces) }))
}

export function dedupeNounDrafts(drafts: BookNounDraft[]): BookNounDraft[] {
  const map = new Map<string, BookNounDraft>()
  for (const e of drafts) {
    const text = e.text.replace(/\s+/g, ' ').trim()
    const canon = nounCanonical(text)
    if (!canon) continue
    if (map.has(canon)) continue
    map.set(canon, { text })
  }
  return [...map.values()].sort((a, b) =>
    nounCanonical(a.text).localeCompare(nounCanonical(b.text)),
  )
}

export function dedupeNounEntries(entries: BookNounEntry[]): BookNounEntry[] {
  const map = new Map<string, BookNounEntry>()
  for (const e of entries) {
    const text = e.text.replace(/\s+/g, ' ').trim()
    const canon = nounCanonical(text)
    if (!canon) continue
    const prev = map.get(canon)
    if (!prev) {
      map.set(canon, { text, bookKeys: [...new Set(e.bookKeys)] })
      continue
    }
    prev.bookKeys = [...new Set([...prev.bookKeys, ...e.bookKeys])]
  }
  return [...map.values()].sort((a, b) =>
    nounCanonical(a.text).localeCompare(nounCanonical(b.text)),
  )
}

export function mergeS0S1Drafts(
  s0: BookNounDraft[],
  s1: BookNounDraft[],
): BookNounDraft[] {
  return dedupeNounDrafts([...s0, ...s1])
}

export function mergeS0S1(
  s0: BookNounEntry[],
  s1: BookNounEntry[],
): BookNounEntry[] {
  return dedupeNounEntries([...s0, ...s1])
}

export function emptyBookNounIndex(docId: string): BookNounIndex {
  return { docId, builtAt: Date.now(), s0: [], s1: [], S: [] }
}

export function buildBookNounIndexRulesOnly(
  bookIndex: BookIndex,
): BookNounIndex {
  const plains = collectPlainTexts(bookIndex)
  const s0 = dedupeNounDrafts(extractS0FromPlainTexts(plains))
  return {
    docId: bookIndex.docId,
    builtAt: Date.now(),
    s0,
    s1: [],
    S: s0,
  }
}

export function joinResidualBatchText(
  plains: PlainText[],
  sep = '\n\n',
): string {
  // 禁止 filter/trim：与 residual 对齐切 S₀ 间隙时必须 1:1 同长拼接
  return plains.map((p) => p.T).join(sep)
}

export type ResidualBatch = {
  batchId: string
  text: string
}

type NounSpan = { start: number; end: number; text: string }

/**
 * 在一段正文里按与 S₀ 相同形态扫「名词样」连续串（含位置）。
 * 跳过纯掩码 █。
 */
export function listNounSpansInText(text: string): NounSpan[] {
  const spans: NounSpan[] = []
  const push = (m: RegExpExecArray) => {
    const t = m[0] ?? ''
    if (!t || /^█+$/.test(t)) return
    if (STOP_SURFACES.has(nounCanonical(t))) return
    spans.push({ start: m.index, end: m.index + t.length, text: t })
  }
  const latin =
    /\b[A-ZÁÉÍÓÚÄÖÜÂÊÎÔÛÀÈÌÒÙÇ][A-Za-zÁÉÍÓÚÄÖÜÂÊÎÔÛÀÈÌÒÙÄÖÜäöüâêîôûàèìòùç\-']{1,40}\b/g
  const cjk = /[\u4e00-\u9fff]{2,8}/g
  let m: RegExpExecArray | null
  while ((m = latin.exec(text))) push(m)
  while ((m = cjk.exec(text))) push(m)
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  // 同起点留更长；简单去重重叠短串
  const out: NounSpan[] = []
  for (const s of spans) {
    const prev = out[out.length - 1]
    if (prev && s.start < prev.end) continue
    out.push(s)
  }
  return out
}

/**
 * 批界重叠后缀：从「截断处最近一个名词」再往前 `priorNouns` 个名词起，
 * 一直截到本批末尾。
 *
 * 例：… N1 N2 拉康 | 成员…
 * 截在拉康后 → 从 N1（拉康前 2 个名词）起到批末（含拉康）带进下一批，
 * 与「成员」同窗，避免短语被拆开。
 */
export function overlapSuffixByPriorNouns(
  batchText: string,
  priorNouns = 2,
): string {
  const spans = listNounSpansInText(batchText)
  if (spans.length === 0) {
    // 无名词样串：退回批末一小截（≤64 字），避免空重叠
    return batchText.slice(Math.max(0, batchText.length - 64))
  }
  const lastIdx = spans.length - 1
  const fromIdx = Math.max(0, lastIdx - Math.max(0, priorNouns))
  const start = spans[fromIdx]!.start
  return batchText.slice(start).trim()
}

/** 单段过长：按 maxChars 串联切，批界 priorNouns 重叠；尽量在空白处软切 */
export function chunkLongTextSerial(
  text: string,
  opts?: { maxChars?: number; priorNouns?: number; batchIdPrefix?: string },
): ResidualBatch[] {
  const maxChars = opts?.maxChars ?? 12_000
  const priorNouns = opts?.priorNouns ?? 2
  const prefix = opts?.batchIdPrefix ?? 's1s'
  const raw = text
  if (!raw.replace(/█/g, '').trim()) return []
  if (raw.length <= maxChars) {
    return [{ batchId: `${prefix}_01`, text: raw }]
  }

  const takeBudget = (from: number): { body: string; consumed: number } => {
    if (from >= raw.length) return { body: '', consumed: 0 }
    if (from + maxChars >= raw.length) {
      return { body: raw.slice(from), consumed: raw.length - from }
    }
    const hard = from + maxChars
    const softFloor = from + Math.floor(maxChars * 0.85)
    for (let i = hard - 1; i >= softFloor; i--) {
      if (/\s/.test(raw[i]!)) {
        return { body: raw.slice(from, i + 1), consumed: i + 1 - from }
      }
    }
    return { body: raw.slice(from, hard), consumed: maxChars }
  }

  const out: ResidualBatch[] = []
  let i = 0
  let pending = ''
  let n = 0
  while (i < raw.length) {
    const { body, consumed } = takeBudget(i)
    if (consumed <= 0) break
    const piece = (pending ? `${pending}\n${body}` : body).trimEnd()
    n += 1
    out.push({
      batchId: `${prefix}_${String(n).padStart(2, '0')}`,
      text: piece,
    })
    i += consumed
    pending = i < raw.length ? overlapSuffixByPriorNouns(body, priorNouns) : ''
  }
  return out
}

function findAllS0Offsets(
  haystack: string,
  s0: BookNounDraft[],
): Array<{ start: number; end: number }> {
  const hits: Array<{ start: number; end: number }> = []
  const lowerHay = haystack.toLowerCase()
  for (const d of s0) {
    const needle = d.text.trim()
    if (needle.length < 2) continue
    const lower = needle.toLowerCase()
    let from = 0
    while (from < lowerHay.length) {
      const at = lowerHay.indexOf(lower, from)
      if (at < 0) break
      hits.push({ start: at, end: at + needle.length })
      from = at + Math.max(1, needle.length)
    }
  }
  hits.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: Array<{ start: number; end: number }> = []
  for (const h of hits) {
    const prev = merged[merged.length - 1]
    if (prev && h.start <= prev.end) prev.end = Math.max(prev.end, h.end)
    else merged.push({ ...h })
  }
  return merged
}

/**
 * 主分批（加速口径）：
 * 1) 规则 S₀ 相邻落点之间的残文间隙 → **可并行**（互不依赖 LLM 结果）
 * 2) **跨 S₀ 切口**也做 priorNouns 前缀重叠：把「切口前 N 个名词样串 + 中间的 █ 掩码」
 *    带进下一间隙，避免规则短词（如 Lacan）把「Jacques ░ 学派」拆到两批互不见面
 * 3) 单间隙过长 → 间隙内 **串联**（同一套 priorNouns 重叠 + 空白软切）
 *
 * 说明：根因是 S₀ 落点切边界，不是并行本身；重叠只复制残文上下文，不把 S₀ 词表当可抄清单。
 * plains / residualPlains 必须同序、等长 unit；mask 同长占位，拼接禁止 trim/filter。
 */
export function buildS1BatchesByS0Gaps(input: {
  plains: PlainText[]
  residualPlains: PlainText[]
  s0: BookNounDraft[]
  maxChars?: number
  priorNouns?: number
}): ResidualBatch[] {
  if (input.plains.length !== input.residualPlains.length) {
    throw new Error(
      'buildS1BatchesByS0Gaps: plains 与 residualPlains 长度必须一致（偏移对齐）',
    )
  }
  const maxChars = input.maxChars ?? 12_000
  const priorNouns = input.priorNouns ?? 2
  const original = joinResidualBatchText(input.plains)
  const residual = joinResidualBatchText(input.residualPlains)
  if (!residual.replace(/█/g, '').trim()) return []

  const anchors = findAllS0Offsets(original, input.s0)
  const gaps: Array<{ start: number; end: number }> = []
  if (anchors.length === 0) {
    gaps.push({ start: 0, end: residual.length })
  } else {
    if (anchors[0]!.start > 0) {
      gaps.push({ start: 0, end: anchors[0]!.start })
    }
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i]!.end
      const b = anchors[i + 1]!.start
      if (b > a) gaps.push({ start: a, end: b })
    }
    const last = anchors[anchors.length - 1]!.end
    if (last < residual.length) {
      gaps.push({ start: last, end: residual.length })
    }
  }

  const batches: ResidualBatch[] = []
  let gi = 0
  for (const g of gaps) {
    const end = Math.min(g.end, residual.length)
    const body = residual.slice(g.start, end)
    if (body.replace(/█/g, '').trim().length < 4) continue

    // 与串联批界同一药方：切口左侧（含 S₀ 的 █）取 priorNouns 后缀，粘到本间隙
    const crossCutPrefix =
      g.start > 0
        ? overlapSuffixByPriorNouns(residual.slice(0, g.start), priorNouns)
        : ''
    const slice = crossCutPrefix ? `${crossCutPrefix}${body}` : body

    gi += 1
    const gapId = `gap${String(gi).padStart(3, '0')}`
    if (slice.length <= maxChars) {
      batches.push({
        batchId: `s1_${gapId}`,
        text: slice,
      })
    } else {
      batches.push(
        ...chunkLongTextSerial(slice, {
          maxChars,
          priorNouns,
          batchIdPrefix: `s1_${gapId}`,
        }),
      )
    }
  }
  return batches
}

export function chunkPlainT(c: AChunk): string {
  return stripMarkupNoise(atomSearchText(c))
}

/** LLM/规则收下的连续串 → Draft */
export function surfacesToDrafts(surfaces: string[]): BookNounDraft[] {
  return surfaces.map((text) => ({ text: text.replace(/\s+/g, ' ').trim() }))
}
