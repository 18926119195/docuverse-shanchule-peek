/**
 * reframe 轻量硬闸：新 prospect 正文若与尸检坏框过像，拒铸。
 * 不做深度语义，只做规范化相等 / 指纹 / 包含 / bigram 重合。
 */

import { contentFingerprint } from './settleMint'

function normalizeProspectText(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。、；：""''（）()【】\[\]《》<>·…\-_—,/.=]/g, '')
}

function bigramSet(s: string): Set<string> {
  const out = new Set<string>()
  if (s.length < 2) {
    if (s) out.add(s)
    return out
  }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** 与任一坏框同构 → true（应拒铸） */
export function prospectIsomorphicToAny(
  text: string,
  badTexts: string[],
): boolean {
  const a = normalizeProspectText(text)
  if (!a || badTexts.length === 0) return false
  const aFp = contentFingerprint(a)
  const aBi = bigramSet(a)
  for (const raw of badTexts) {
    const b = normalizeProspectText(raw)
    if (!b) continue
    if (a === b) return true
    if (aFp === contentFingerprint(b)) return true
    if (a.length >= 20 && b.length >= 20) {
      const head = Math.min(36, Math.floor(Math.min(a.length, b.length) * 0.45))
      if (head >= 12 && (a.includes(b.slice(0, head)) || b.includes(a.slice(0, head)))) {
        return true
      }
    }
    if (jaccard(aBi, bigramSet(b)) >= 0.72) return true
  }
  return false
}

export function filterKeepsAvoidingBadProspects<
  T extends { prospect: string; briefKey: string },
>(
  keeps: T[],
  badTexts: string[],
): { kept: T[]; rejected: Array<{ briefKey: string; reason: string }> } {
  if (!badTexts.length) return { kept: keeps, rejected: [] }
  const kept: T[] = []
  const rejected: Array<{ briefKey: string; reason: string }> = []
  for (const row of keeps) {
    if (prospectIsomorphicToAny(row.prospect, badTexts)) {
      rejected.push({
        briefKey: row.briefKey,
        reason: '同构坏 prospect（reframe 尸检硬闸）',
      })
    } else {
      kept.push(row)
    }
  }
  return { kept, rejected }
}
