/**
 * Tool-class archive: fingerprint = tool × object × stepOrder × modelId (no wall-clock).
 * Powers recommend + inferred/accepted reuse lookup.
 */

import { memberKeysSignature } from './toolGateway'
import type { FanoutPath } from './types'

export type ToolClass = 'retrieve' | 'compose' | 'infer'

export interface ToolRecommend {
  toolClass: ToolClass
  label: string
  reason: string
  priority: number
}

export interface ArchiveFingerprint {
  toolClass: ToolClass
  memberKeys: string[]
  /** Stable step recipe tag, e.g. fine|window|cluster|cross */
  stepOrder: string
  modelId: string
}

/** Browser-safe short hash (not crypto; identity for archive index only). */
function clientShortHash(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

export function buildFingerprint(fp: ArchiveFingerprint): string {
  const obj = memberKeysSignature(fp.memberKeys)
  const raw = [fp.toolClass, obj, fp.stepOrder, fp.modelId || 'default'].join(
    '|',
  )
  return `fp_${clientShortHash(raw)}`
}

export function recommendToolClasses(input: {
  hasObjectLock: boolean
  hasDraftHits: boolean
  hasInferredOrAccepted: boolean
}): ToolRecommend[] {
  const out: ToolRecommend[] = []
  if (!input.hasObjectLock || !input.hasDraftHits) {
    out.push({
      toolClass: 'retrieve',
      label: '检索草稿',
      reason: '对象未钉或尚无候选 → 先检索',
      priority: 0,
    })
  }
  out.push({
    toolClass: 'compose',
    label: '写信组合',
    reason: '在候选上穷尽/策略组合',
    priority: 1,
  })
  out.push({
    toolClass: 'infer',
    label: input.hasInferredOrAccepted ? '推理或复用' : '推理',
    reason: input.hasInferredOrAccepted
      ? '存档可复用；信上定案后再跑'
      : '尚无存档 → 定案后新推',
    priority: 2,
  })
  return out.sort((a, b) => a.priority - b.priority)
}

export type CacheTier = 'accepted' | 'inferred'

export interface ReuseHit {
  path: FanoutPath
  tier: CacheTier
  fingerprint: string
}

function pathKeys(path: FanoutPath): string[] {
  if (path.direction.premiseKeys?.length) return path.direction.premiseKeys
  if (path.slots?.length) return path.slots.map((s) => s.key)
  return []
}

function questionNear(current: string, path: FanoutPath, _minOverlap?: number): boolean {
  const prevQ = path.question || path.direction.questionText || ''
  if (!prevQ.trim() || !current.trim()) return true
  if (prevQ.trim() === current.trim()) return true
  if (path.direction.variants?.some((v) => v.trim() === current.trim())) return true
  // Soft gate: exact / variant only. LLM same-task judgment is the intended upgrade;
  // lexicalOverlap removed (today's decision).
  return false
}

/**
 * Prefer accepted assets; fall back to inferred cache (未采纳也可复用).
 * Fingerprint must match tool×object×step×model when provided.
 */
export function findReusablePath(input: {
  memberKeys: string[]
  question: string
  stepOrder: string
  modelId: string
  accepted: FanoutPath[]
  inferred: FanoutPath[]
  minOverlap?: number
}): ReuseHit | null {
  const minOverlap = input.minOverlap ?? 0.35
  const wantFp = buildFingerprint({
    toolClass: 'infer',
    memberKeys: input.memberKeys,
    stepOrder: input.stepOrder,
    modelId: input.modelId,
  })
  const sig = memberKeysSignature(input.memberKeys)
  if (!sig) return null

  const scan = (paths: FanoutPath[], tier: CacheTier): ReuseHit | null => {
    const hits = paths
      .filter((p) => memberKeysSignature(pathKeys(p)) === sig)
      .filter((p) => questionNear(input.question, p, minOverlap))
      .filter((p) => {
        const stored = p.direction.fingerprint
        // Legacy paths without fingerprint: allow on keys+question only
        if (!stored) return true
        return stored === wantFp
      })
      .sort((a, b) => b.createdAt - a.createdAt)
    const path = hits[0]
    if (!path) return null
    return { path, tier, fingerprint: wantFp }
  }

  return (
    scan(
      input.accepted.filter((p) => p.direction.accepted === true),
      'accepted',
    ) ?? scan(input.inferred, 'inferred')
  )
}

/** Collect compact markers for next-hop reflux (少占上下文). */
export function collectRefluxMarkers(
  paths: FanoutPath[],
  limit = 6,
): Array<{ fromKey: string; conclusion: string; pathSummary: string }> {
  const out: Array<{ fromKey: string; conclusion: string; pathSummary: string }> =
    []
  for (const p of paths) {
    if (out.length >= limit) break
    const marker = p.direction.pathMarker
    const conclusion = p.direction.conclusion?.trim()
    if (!conclusion && !marker) continue
    out.push({
      fromKey: p.direction.premiseKeys?.[0] || p.pathId,
      conclusion: conclusion?.slice(0, 160) || marker?.slice(0, 160) || '',
      pathSummary: (marker || p.direction.path).slice(0, 200),
    })
  }
  return out
}
