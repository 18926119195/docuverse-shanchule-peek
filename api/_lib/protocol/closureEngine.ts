/**
 * Closure / reuse rules — server authority.
 * Client may hold a snapshot; transitions must go through these rules.
 */

export interface DirectionSnap {
  directionId: string
  questionText: string
  conclusion: string
  path: string
  probe?: number[]
  createdAt: number
  variants: string[]
}

export interface ClosureSnap {
  key: string
  excerpt: string
  memberKeys: string[]
  directions: DirectionSnap[]
  createdAt: number
  updatedAt: number
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d > 0 ? dot / d : 0
}

/** Lightweight lexical probe (server) — same spirit as client probe, not the identity. */
export function textToProbe(text: string, dim = 64): number[] {
  const v = new Array<number>(dim).fill(0)
  const tokens = text.toLowerCase().match(/[\u4e00-\u9fff]|[a-z0-9]{2,}/g) ?? []
  for (const t of tokens) {
    let h = 2166136261
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    const idx = (h >>> 0) % dim
    v[idx] += 1
  }
  let sum = 0
  for (const x of v) sum += x * x
  const inv = sum > 0 ? 1 / Math.sqrt(sum) : 1
  return v.map((x) => x * inv)
}

export function ensureClosure(
  map: Record<string, ClosureSnap>,
  input: { key: string; excerpt: string; memberKeys?: string[] },
): { map: Record<string, ClosureSnap>; closure: ClosureSnap } {
  const existing = map[input.key]
  if (existing) return { map, closure: existing }
  const now = Date.now()
  const closure: ClosureSnap = {
    key: input.key,
    excerpt: input.excerpt,
    memberKeys:
      input.memberKeys && input.memberKeys.length > 0
        ? input.memberKeys
        : [input.key],
    directions: [],
    createdAt: now,
    updatedAt: now,
  }
  return { map: { ...map, [input.key]: closure }, closure }
}

export function matchDirections(
  closure: ClosureSnap,
  question: string,
  topK = 5,
): Array<{ directionId: string; score: number }> {
  const q = textToProbe(question)
  const scored = closure.directions.map((d) => {
    const probe = d.probe && d.probe.length > 0 ? d.probe : textToProbe(d.questionText)
    return { directionId: d.directionId, score: cosine(q, probe) }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK).filter((x) => x.score > 0.15)
}

export function rememberDirection(
  map: Record<string, ClosureSnap>,
  input: {
    key: string
    questionText: string
    path: string
    conclusion: string
  },
): { map: Record<string, ClosureSnap>; directionId: string } {
  const cur = map[input.key]
  if (!cur) throw new Error('closure not found')
  const directionId = `dir_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  const dir: DirectionSnap = {
    directionId,
    questionText: input.questionText,
    conclusion: input.conclusion,
    path: input.path,
    probe: textToProbe(input.questionText),
    createdAt: Date.now(),
    variants: [],
  }
  const nextClosure: ClosureSnap = {
    ...cur,
    directions: [...cur.directions, dir],
    updatedAt: Date.now(),
  }
  return {
    map: { ...map, [input.key]: nextClosure },
    directionId,
  }
}

/** Reuse = return existing direction; do not call model (protocol short-circuit). */
export function resolveReuse(
  closure: ClosureSnap,
  directionId: string,
): { reuse: true; path: string; conclusion: string } | { reuse: false } {
  const d = closure.directions.find((x) => x.directionId === directionId)
  if (!d) return { reuse: false }
  return { reuse: true, path: d.path, conclusion: d.conclusion }
}
