/**
 * 问核词面命中：从 Q_now 抽专名/别名，在 A1 上找含该词的 bookKey。
 * 供 toc_nav 取样优先、扩搜空时一次补给（非替代 toc_nav 主路径）。
 *
 * 廊内细排（昨天共识）：短密排序 = 命中密度高优先 + 短 T 先读，早停才踩得上真料。
 */

import {
  atomSearchText,
  isRetrievableAtom,
  tokenizeQuery,
} from '../reasoning/hybridRetrieve'
import type { BookIndex } from '../reasoning/pipelineA'

/** 中文专名 → 书内常见西文写法（OCR 多为法/英） */
const CJK_ALIASES: Record<string, string[]> = {
  拉康: ['lacan', 'lacanien', 'lacanienne'],
  弗洛伊德: ['freud', 'freudien', 'freudienne'],
  荣格: ['jung', 'jungien'],
  德勒兹: ['deleuze'],
  瓜塔里: ['guattari'],
  加塔利: ['guattari'],
  马克思: ['marx', 'marxiste'],
  黑格尔: ['hegel', 'hégel'],
  尼采: ['nietzsche'],
  萨特: ['sartre'],
  福柯: ['foucault'],
}

const Q_NOISE = new Set([
  '如何',
  '什么',
  '怎么',
  '怎样',
  '批判',
  '批评',
  '理解',
  '意思',
  '是否',
  '提到',
  '的呢',
  '呢',
  '吗',
  '啊',
  '呀',
  '吧',
])

/** 密度分母下限：过短 OCR 碎片不靠「假高密」抢队首 */
const DENSITY_LEN_FLOOR = 48

/**
 * 从 Q_now 抽问核 needle。
 * 优先扫已知专名表（避免「如何批判弗洛伊德」被整段吃掉导致 freud 别名丢失）。
 */
export function qCoreNeedles(question: string): string[] {
  const q = question.trim()
  if (!q) return []
  const out = new Set<string>()

  // 1) 已知专名：在问句中子串命中即收录 + 西文别名
  const names = Object.keys(CJK_ALIASES).sort((a, b) => b.length - a.length)
  for (const name of names) {
    if (q.includes(name)) {
      out.add(name)
      for (const a of CJK_ALIASES[name] ?? []) out.add(a)
    }
  }

  // 2) 其余 CJK 连续段：拆短、去噪（不再把整句当 needle）
  const cjkRuns = q.match(/[\u4e00-\u9fff]{2,8}/g) ?? []
  for (const run of cjkRuns) {
    if (Q_NOISE.has(run)) continue
    // 已覆盖的已知专名跳过
    if ([...out].some((n) => /[\u4e00-\u9fff]/.test(n) && run.includes(n))) {
      continue
    }
    // 含问法噪声的长串：尝试抠出已知专名，否则丢弃
    let hasNoise = false
    for (const noise of Q_NOISE) {
      if (run.includes(noise)) {
        hasNoise = true
        break
      }
    }
    if (hasNoise) continue
    if (run.length >= 2 && run.length <= 6) out.add(run)
  }

  // 3) 拉丁 token
  for (const t of tokenizeQuery(q)) {
    if (/^[a-z]{4,}$/i.test(t)) out.add(t.toLowerCase())
  }

  for (const noise of Q_NOISE) out.delete(noise)
  // 丢掉明显不是专名的整句碎片
  return [...out].filter((n) => {
    if (/[\u4e00-\u9fff]/.test(n) && n.length > 6) return false
    return true
  })
}

/** 正文是否命中任一问核 needle（大小写不敏感） */
export function textHitsQCore(
  text: string,
  needles: ReadonlyArray<string>,
): boolean {
  return countQCoreHits(text, needles) > 0
}

/** 问核命中次数（各 needle 在文中出现次数之和） */
export function countQCoreHits(
  text: string,
  needles: ReadonlyArray<string>,
): number {
  const t = text.toLowerCase()
  if (!t.trim() || needles.length === 0) return 0
  let n = 0
  for (const raw of needles) {
    const needle = raw.toLowerCase()
    if (needle.length < 2) continue
    let from = 0
    while (from < t.length) {
      const i = t.indexOf(needle, from)
      if (i < 0) break
      n += 1
      from = i + needle.length
    }
  }
  return n
}

/**
 * 短密分：命中密度（次/有效字）优先，同等密度则短 T 优先。
 * score 越大越应先扫。
 */
export function shortDenseScore(
  text: string,
  hitCount: number,
): { density: number; len: number; score: number } {
  const len = Math.max(0, text.trim().length)
  const denom = Math.max(DENSITY_LEN_FLOOR, len)
  const density = hitCount / denom
  // 短文加成：同密度下更短者 score 略高（len 越小越好）
  const score = density * 1e6 - len
  return { density, len, score }
}

type RankedKey = {
  key: string
  hitCount: number
  len: number
  density: number
  score: number
  ord: number
}

function rankKeysShortDense(
  keys: ReadonlyArray<string>,
  bookIndex: BookIndex,
  needles: ReadonlyArray<string>,
  /** 未命中段：仍按短文先扫（hitCount=0） */
  requireHit: boolean,
): RankedKey[] {
  const ranked: RankedKey[] = []
  keys.forEach((key, ord) => {
    const chunk = bookIndex.chunks.find((c) => c.key === key)
    const t = chunk ? atomSearchText(chunk) : ''
    const hitCount = countQCoreHits(t, needles)
    if (requireHit && hitCount <= 0) return
    const { density, len, score } = shortDenseScore(t, hitCount)
    ranked.push({ key, hitCount, len, density, score, ord })
  })
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.len !== b.len) return a.len - b.len
    return a.ord - b.ord
  })
  return ranked
}

/**
 * 走廊保序升级：问核命中 → 短密排序提到队首；未命中段按短 T 跟后。
 * 让 decide 先读「专名密 + 文章短」的段，satisficing 早停才有意义。
 */
export function prioritizeBookKeysByQCore(input: {
  bookKeys: ReadonlyArray<string>
  bookIndex: BookIndex
  question: string
}): { keys: string[]; hitKeys: string[]; needles: string[]; note: string } {
  const needles = qCoreNeedles(input.question)
  if (needles.length === 0 || input.bookKeys.length === 0) {
    return {
      keys: [...input.bookKeys],
      hitKeys: [],
      needles,
      note: '问核优先 · 无 needle / 空队列',
    }
  }

  const hitRanked = rankKeysShortDense(
    input.bookKeys,
    input.bookIndex,
    needles,
    true,
  )
  const hitSet = new Set(hitRanked.map((r) => r.key))
  const restKeys = input.bookKeys.filter((k) => !hitSet.has(k))
  const restRanked = rankKeysShortDense(
    restKeys,
    input.bookIndex,
    needles,
    false,
  )

  const hitKeys = hitRanked.map((r) => r.key)
  const keys = [...hitKeys, ...restRanked.map((r) => r.key)]
  const top = hitRanked.slice(0, 3)
  const topNote =
    top.length > 0
      ? ` · 短密首=${top
          .map(
            (r) =>
              `hit${r.hitCount}/L${r.len}~${(r.density * 1000).toFixed(2)}‰`,
          )
          .join(',')}`
      : ''

  return {
    keys,
    hitKeys,
    needles,
    note:
      `问核优先·短密 · needle=[${needles.slice(0, 8).join(',')}]` +
      ` · 命中×${hitKeys.length}/${input.bookKeys.length}` +
      topNote,
  }
}

/** 书序 bookKey：T 含任一 needle；短密排序后截断 */
export function bookKeysHittingQCore(input: {
  bookIndex: BookIndex
  question: string
  /** 若给，只在闭集/走廊内命中 */
  allowedKeys?: ReadonlySet<string> | null
  maxKeys?: number
}): { keys: string[]; needles: string[]; note: string } {
  const needles = qCoreNeedles(input.question)
  if (needles.length === 0) {
    return { keys: [], needles, note: '问核词面 · 无专名 needle' }
  }
  const maxKeys = input.maxKeys ?? 24
  const candidates: string[] = []
  for (const c of input.bookIndex.chunks) {
    if (input.allowedKeys && !input.allowedKeys.has(c.key)) continue
    if (!isRetrievableAtom(c)) continue
    if (!textHitsQCore(atomSearchText(c), needles)) continue
    candidates.push(c.key)
  }
  const ranked = rankKeysShortDense(
    candidates,
    input.bookIndex,
    needles,
    true,
  )
  const keys = ranked.map((r) => r.key).slice(0, maxKeys)
  return {
    keys,
    needles,
    note:
      `问核词面·短密 · needle=[${needles.slice(0, 8).join(',')}]` +
      ` · 命中×${keys.length}` +
      (input.allowedKeys ? '（走廊内）' : '（全书）'),
  }
}
