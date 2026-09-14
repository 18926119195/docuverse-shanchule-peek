/** Local lexical probe — stand-in for CPU lightweight embedding (demo). */

const DIM = 64

export function textToProbe(text: string): number[] {
  const v = new Array<number>(DIM).fill(0)
  const norm = text.toLowerCase().trim()
  if (!norm) return v
  for (let i = 0; i < norm.length; i++) {
    const code = norm.charCodeAt(i)
    const i0 = code % DIM
    const i1 = (code * 17 + i) % DIM
    v[i0] += 1
    v[i1] += 0.5
  }
  let sum = 0
  for (const x of v) sum += x * x
  const inv = sum > 0 ? 1 / Math.sqrt(sum) : 1
  return v.map((x) => x * inv)
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0
  // Different embedding spaces must not silently share a prefix
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}
