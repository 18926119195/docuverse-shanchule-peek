/**
 * Repeat-reject → forbidDirections pattern tracking.
 */

import type { FanoutPath } from './types'
import type { ForbidPatternEntry } from './harnessTypes'
import { memberKeysSignature } from './toolGateway'

const REPEAT_THRESHOLD = 3

export function patternFingerprint(path: FanoutPath): string {
  const sig = memberKeysSignature(
    path.direction.premiseKeys ?? path.slots.map((s) => s.key),
  )
  const conc = (path.direction.conclusion || '').slice(0, 80)
  return `${sig}\0${conc}`
}

export function recordReject(
  patterns: ForbidPatternEntry[],
  path: FanoutPath,
): { patterns: ForbidPatternEntry[]; newlyForbidden: boolean } {
  const fp = patternFingerprint(path)
  const memberSig = memberKeysSignature(
    path.direction.premiseKeys ?? path.slots.map((s) => s.key),
  )
  const conc = path.direction.conclusion || ''
  const q = path.question || ''

  const idx = patterns.findIndex((p) => p.fingerprint === fp)
  const now = Date.now()

  if (idx >= 0) {
    const prev = patterns[idx]
    const next: ForbidPatternEntry = {
      ...prev,
      rejectCount: prev.rejectCount + 1,
      lastRejectedAt: now,
    }
    const out = [...patterns]
    out[idx] = next
    return {
      patterns: out,
      newlyForbidden: next.rejectCount >= REPEAT_THRESHOLD,
    }
  }

  const entry: ForbidPatternEntry = {
    fingerprint: fp,
    memberKeysSignature: memberSig,
    conclusionPrefix: conc.slice(0, 120),
    rejectCount: 1,
    lastRejectedAt: now,
    questionPrefix: q.slice(0, 100),
  }
  return { patterns: [...patterns, entry], newlyForbidden: false }
}

export function isForbidden(
  patterns: ForbidPatternEntry[],
  memberKeys: ReadonlyArray<string>,
  conclusion?: string,
): ForbidPatternEntry | null {
  const sig = memberKeysSignature([...memberKeys])
  const conc = (conclusion || '').slice(0, 80)
  const fp = `${sig}\0${conc}`
  const hit = patterns.find(
    (p) => p.fingerprint === fp && p.rejectCount >= REPEAT_THRESHOLD,
  )
  return hit ?? null
}

export function forbidItemsFromPatterns(
  patterns: ForbidPatternEntry[],
): Array<{ directionId: string; questionSummary: string; conclusionSummary: string }> {
  return patterns
    .filter((p) => p.rejectCount >= REPEAT_THRESHOLD)
    .map((p) => ({
      directionId: `forbid_${p.fingerprint.slice(0, 12)}`,
      questionSummary: p.questionPrefix,
      conclusionSummary: p.conclusionPrefix,
    }))
}
