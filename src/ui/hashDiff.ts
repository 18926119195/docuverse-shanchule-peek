/**
 * Hash-aligned same/diff tokens for left|right attention panes.
 * Same spans gray; differing / only-one-side bright.
 */

export type DiffTone = 'same' | 'diff' | 'only'

export interface DiffToken {
  text: string
  tone: DiffTone
}

/** Align two strings by shared character runs (good enough for short Chinese briefs). */
export function alignTextDiff(
  left: string,
  right: string,
): { left: DiffToken[]; right: DiffToken[] } {
  const a = left || ''
  const b = right || ''
  if (!a && !b) return { left: [], right: [] }
  if (!a) return { left: [], right: [{ text: b, tone: 'only' }] }
  if (!b) return { left: [{ text: a, tone: 'only' }], right: [] }

  // LCS on characters (cap length for UI)
  const A = a.slice(0, 800)
  const B = b.slice(0, 800)
  const n = A.length
  const m = B.length
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array(m + 1).fill(0),
  )
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] =
        A[i - 1] === B[j - 1]
          ? dp[i - 1]![j - 1]! + 1
          : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
    }
  }
  let i = n
  let j = m
  const stackL: DiffToken[] = []
  const stackR: DiffToken[] = []
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && A[i - 1] === B[j - 1]) {
      stackL.push({ text: A[i - 1]!, tone: 'same' })
      stackR.push({ text: B[j - 1]!, tone: 'same' })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      stackR.push({ text: B[j - 1]!, tone: 'diff' })
      j--
    } else if (i > 0) {
      stackL.push({ text: A[i - 1]!, tone: 'diff' })
      i--
    }
  }
  const merge = (toks: DiffToken[]) => {
    const out: DiffToken[] = []
    for (const t of toks.reverse()) {
      const last = out[out.length - 1]
      if (last && last.tone === t.tone) last.text += t.text
      else out.push({ ...t })
    }
    return out
  }
  return { left: merge(stackL), right: merge(stackR) }
}

/** Pair rows by key for side-by-side hash panes. */
export function pairRowsByKey<T extends { key: string; text: string }>(
  input: T[],
  output: T[],
): Array<{ key: string; left?: T; right?: T }> {
  const keys = new Set<string>()
  for (const r of input) keys.add(r.key)
  for (const r of output) keys.add(r.key)
  const inMap = new Map(input.map((r) => [r.key, r]))
  const outMap = new Map(output.map((r) => [r.key, r]))
  return [...keys].map((key) => ({
    key,
    left: inMap.get(key),
    right: outMap.get(key),
  }))
}
