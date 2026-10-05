/**
 * Motion brain: propose MotionPlan[] without reading full T text.
 * Handbook: motion brain commands bags (§0.10); geometric compose not main path.
 */

import type { BookIndex } from './pipelineA'
import type { BookSemanticIndex } from './semanticIndex'
import type { MotionBrainInput, MotionPlan, ScopeProbeInput } from './harnessTypes'
import { keysNeedingOpen } from './workingSet'
import { isForbidden } from './forbidPatterns'
import { memberKeysSignature } from './toolGateway'

/**
 * Propose 0～K bags from draft pool (handbook §0.10).
 * With confirmed TOC: group keys that share a section when possible.
 * Without TOC: one key per bag (singles) — not geometric window/cross.
 */
export function proposeComposeBags(input: {
  draftKeys: ReadonlyArray<string>
  bookIndex: BookIndex
  semantic?: BookSemanticIndex | null
  maxBags?: number
}): { bags: string[][]; rationale: string } {
  const maxBags = Math.max(1, input.maxBags ?? 5)
  const keys = [...input.draftKeys].filter(Boolean).slice(0, maxBags * 2)
  if (keys.length === 0) {
    return { bags: [], rationale: '运动脑组袋 · draft 空' }
  }

  const semantic = input.semantic
  if (semantic?.tocConfirmed && semantic.sections.length > 0) {
    const keyToSec = new Map<string, string>()
    for (const s of semantic.sections) {
      for (const k of s.memberKeys ?? []) keyToSec.set(k, s.nodeId)
    }
    const bySec = new Map<string, string[]>()
    const orphans: string[] = []
    for (const k of keys) {
      const sec = keyToSec.get(k)
      if (!sec) {
        orphans.push(k)
        continue
      }
      const list = bySec.get(sec) ?? []
      list.push(k)
      bySec.set(sec, list)
    }
    const bags: string[][] = []
    for (const group of bySec.values()) {
      if (bags.length >= maxBags) break
      bags.push(group.slice(0, 4))
    }
    for (const k of orphans) {
      if (bags.length >= maxBags) break
      bags.push([k])
    }
    if (bags.length > 0) {
      return {
        bags: bags.slice(0, maxBags),
        rationale: `运动脑组袋 · 同廊捆 ${bags.length} 袋（TOC 已确认）`,
      }
    }
  }

  // Default: singles — attention packs of one door each
  const bags = keys.slice(0, maxBags).map((k) => [k])
  return {
    bags,
    rationale: '运动脑组袋 · 单门袋（非几何穷举）',
  }
}

function planId(prefix: string, unitKey: string, idx: number): string {
  return `${prefix}_${unitKey.slice(0, 12)}_${idx}`
}

export function probeScope(input: ScopeProbeInput): MotionPlan['probeResult'] {
  const { scope, archivePaths, currentMemory, bookIndexKeys } = input
  const keySet = new Set(bookIndexKeys)
  const candidateKeys: string[] = []
  const candidatePathIds: string[] = []

  if (scope.target === 'currentMemory') {
    for (const e of currentMemory) {
      candidatePathIds.push(e.pathId)
      const keys =
        e.path.direction.premiseKeys ?? e.path.slots.map((s) => s.key)
      for (const k of keys) {
        if (candidateKeys.length < scope.maxKeys) candidateKeys.push(k)
      }
    }
  } else {
    for (const e of archivePaths) {
      candidatePathIds.push(e.pathId)
      const keys =
        e.path.direction.premiseKeys ?? e.path.slots.map((s) => s.key)
      for (const k of keys) {
        if (keySet.has(k) && candidateKeys.length < scope.maxKeys) {
          candidateKeys.push(k)
        }
      }
    }
    if (scope.target === 'crossDoc' && scope.docId) {
      for (const k of bookIndexKeys) {
        if (k.startsWith(scope.docId) && candidateKeys.length < scope.maxKeys) {
          candidateKeys.push(k)
        }
      }
    }
  }

  const found = candidateKeys.length > 0 || candidatePathIds.length > 0
  return {
    found,
    candidateKeys: [...new Set(candidateKeys)].slice(0, scope.maxKeys),
    candidatePathIds: [...new Set(candidatePathIds)].slice(0, scope.maxKeys),
    note: found
      ? `probe: ${candidateKeys.length} keys, ${candidatePathIds.length} paths in ${scope.target}`
      : `probe: nothing in ${scope.target}`,
  }
}

export function buildMotionPlans(input: MotionBrainInput): MotionPlan[] {
  const plans: MotionPlan[] = []
  let expandQuota = input.expandBudget

  for (let i = 0; i < input.composeCandidates.length; i++) {
    const unit = input.composeCandidates[i]
    const members = [...unit.memberKeys]

    const forbidden = isForbidden([...input.forbidPatterns], members)
    if (forbidden) {
      plans.push({
        rank: 0,
        planId: planId('forbid', unit.unitKey, i),
        action: 'deferred',
        faultInKeys: [],
        collapseKeys: [],
        unitKey: unit.unitKey,
        score: 0,
        rationale: `重复拒绝模式≥3 · ${forbidden.conclusionPrefix.slice(0, 40)}`,
        trigger: input.validatorSignal,
      })
      continue
    }

    const reuseHit = input.reuseHits.find((h) => h.unitKey === unit.unitKey)
    const needOpen = keysNeedingOpen(members, input.workingSet)

    if (reuseHit && needOpen.length === 0) {
      // Soft reuse: fingerprint/combo already matched upstream; do not lexicalOverlap(pathId).
      plans.push({
        rank: 0,
        planId: planId('reuse', unit.unitKey, i),
        action: 'reuse',
        faultInKeys: [],
        collapseKeys: [],
        unitKey: unit.unitKey,
        reuseFromPathId: reuseHit.pathId,
        score: 0.85 + reuseHit.score * 0.1,
        rationale: `reuse 命中 ${reuseHit.pathId}`,
        trigger: input.validatorSignal,
      })
      continue
    }

    if (needOpen.length > 0 && expandQuota > 0) {
      const partial =
        members.length > 1
          ? needOpen.slice(
              0,
              Math.min(
                input.maxKeysPerPlan,
                Math.max(1, Math.ceil(members.length / 2)),
              ),
            )
          : needOpen.slice(0, input.maxKeysPerPlan)
      const faultInKeys = partial
      const isPartial = faultInKeys.length < needOpen.length
      plans.push({
        rank: 0,
        planId: planId(isPartial ? 'partial' : 'expand', unit.unitKey, i),
        action: isPartial ? 'faultIn' : 'expand',
        faultInKeys,
        collapseKeys: [],
        unitKey: unit.unitKey,
        score: 0.7 + faultInKeys.length * 0.05,
        rationale: isPartial
          ? `partial fault-in ${unit.label} · ${faultInKeys.length}/${needOpen.length} 槽`
          : `expand ${unit.label} · 开 ${faultInKeys.length} 槽`,
        trigger: input.validatorSignal,
      })
      expandQuota -= 1
    } else if (needOpen.length > 0 && input.validatorSignal) {
      plans.push({
        rank: 0,
        planId: planId('faultIn', unit.unitKey, i),
        action: 'faultIn',
        faultInKeys: needOpen.slice(0, input.maxKeysPerPlan),
        collapseKeys: [],
        unitKey: unit.unitKey,
        score: 0.55,
        rationale: '证据缺口 · 提议 fault-in',
        trigger: input.validatorSignal,
      })
    } else if (
      needOpen.length > 0 &&
      input.archivePaths.length > 0 &&
      input.workingSet.expanded.size === 0
    ) {
      plans.push({
        rank: 0,
        planId: planId('scope', unit.unitKey, i),
        action: 'scopeRequest',
        faultInKeys: [],
        collapseKeys: [],
        unitKey: unit.unitKey,
        score: 0.45,
        rationale: 'archiveOnly · 须 scopeRequest + 人批',
        scopeRequest: {
          target: 'archiveOnly',
          docId: input.docId,
          maxKeys: input.maxKeysPerPlan,
          reason: '槽在 archiveOnly 记忆',
        },
        trigger: input.validatorSignal,
      })
    } else {
      plans.push({
        rank: 0,
        planId: planId('defer', unit.unitKey, i),
        action: 'deferred',
        faultInKeys: [],
        collapseKeys: [],
        unitKey: unit.unitKey,
        score: 0.2,
        rationale: '本轮 deferred',
        trigger: input.validatorSignal,
      })
    }
  }

  plans.sort((a, b) => b.score - a.score)
  return plans.map((p, idx) => ({ ...p, rank: idx + 1 }))
}

export function motionActionToLetterDecision(
  action: MotionPlan['action'],
): 'reuse' | 'expand' | 'deferred' | null {
  if (action === 'reuse') return 'reuse'
  if (action === 'expand' || action === 'faultIn' || action === 'peek') {
    return 'expand'
  }
  if (action === 'deferred' || action === 'scopeRequest' || action === 'collapse') {
    return 'deferred'
  }
  return null
}

export function memberKeysSig(keys: ReadonlyArray<string>): string {
  return memberKeysSignature([...keys])
}

/**
 * Corridor scout from Package A — pick lockCorridor when human has not locked.
 * Does not emit conclusions; only a corridor preference plan.
 */
export function pickCorridorFromPackage(
  pkg: {
    question: string
    rows: Array<{ nodeId: string; title: string; score: number }>
    lockCorridor?: string
    skipPackageA: boolean
  },
): { lockCorridor: string | null; skipped: boolean; rationale: string } {
  if (pkg.skipPackageA && pkg.lockCorridor) {
    return {
      lockCorridor: pkg.lockCorridor,
      skipped: true,
      rationale: `人锁廊 · skip 包A · ${pkg.lockCorridor}`,
    }
  }
  if (pkg.lockCorridor) {
    return {
      lockCorridor: pkg.lockCorridor,
      skipped: true,
      rationale: `已锁廊 ${pkg.lockCorridor}`,
    }
  }
  const top = pkg.rows[0]
  if (!top) {
    return { lockCorridor: null, skipped: false, rationale: '无可用廊道' }
  }
  return {
    lockCorridor: top.nodeId,
    skipped: false,
    rationale: `廊道优选 ${top.title} (${top.score.toFixed(2)})`,
  }
}

/**
 * Build MotionPlan[] from Package B (doors + bags). Prefers peek when door
 * has no brief yet; reuse / expand / defer otherwise. No conclusions.
 */
export function buildMotionPlansFromDoorPackage(input: {
  question: string
  docId: string
  doorPackage: {
    lockCorridor: string
    doors: Array<{
      key: string
      doorBrief?: string
      briefKey?: string
      briefContentHash?: string
      suggestAction?: string
      alreadyExpanded: boolean
    }>
    bags: Array<{
      unitKey: string
      memberKeys: string[]
      label: string
      kind: string
      reuseFromPathId?: string
      briefRef?: string
    }>
    weakenPackageB: boolean
    lockKeys?: string[]
  }
  workingSet: MotionBrainInput['workingSet']
  forbidPatterns: MotionBrainInput['forbidPatterns']
  expandBudget: number
  maxKeysPerPlan?: number
  validatorSignal?: MotionBrainInput['validatorSignal']
}): MotionPlan[] {
  const pkg = input.doorPackage
  if (pkg.weakenPackageB && pkg.lockKeys?.length) {
    return pkg.lockKeys.map((key, i) => ({
      rank: i + 1,
      planId: planId('lock', key, i),
      action: 'expand' as const,
      faultInKeys: [key],
      collapseKeys: [],
      unitKey: key,
      score: 1,
      rationale: `人锁门 · weaken 包B · ${key.slice(-10)}`,
      briefRef: pkg.doors.find((d) => d.key === key)?.briefKey,
      lockCorridor: pkg.lockCorridor,
      trigger: input.validatorSignal,
    }))
  }

  const composeCandidates = pkg.bags.map((b) => ({
    unitKey: b.unitKey,
    kind: b.kind,
    label: b.label,
    memberKeys: b.memberKeys,
  }))

  const reuseHits = pkg.bags
    .filter((b) => b.reuseFromPathId)
    .map((b) => ({
      unitKey: b.unitKey,
      pathId: b.reuseFromPathId!,
      score: 0.9,
    }))

  const base = buildMotionPlans({
    question: input.question,
    docId: input.docId,
    draftKeys: pkg.doors.map((d) => d.key),
    composeCandidates,
    workingSet: input.workingSet,
    currentMemory: [],
    archivePaths: [],
    reuseHits,
    expandBudget: input.expandBudget,
    maxKeysPerPlan: input.maxKeysPerPlan ?? 8,
    forbidPatterns: input.forbidPatterns,
    validatorSignal: input.validatorSignal,
  })

  // Upgrade expand/faultIn on doors without brief → peek (cast tip first)
  return base.map((p) => {
    if (p.action !== 'expand' && p.action !== 'faultIn') {
      const briefRef =
        p.briefRef ??
        pkg.bags.find((b) => b.unitKey === p.unitKey)?.briefRef
      return { ...p, briefRef, lockCorridor: pkg.lockCorridor }
    }
    const keys = p.faultInKeys.length ? p.faultInKeys : []
    const needPeek = keys.filter((k) => {
      const door = pkg.doors.find((d) => d.key === k)
      return door && !door.doorBrief?.trim() && !door.alreadyExpanded
    })
    if (needPeek.length === 1 && keys.length === 1) {
      const door = pkg.doors.find((d) => d.key === needPeek[0])
      return {
        ...p,
        action: 'peek' as const,
        faultInKeys: needPeek,
        rationale: `peek 铸贴 · ${needPeek[0].slice(-10)}`,
        briefRef: door?.briefKey,
        lockCorridor: pkg.lockCorridor,
      }
    }
    return {
      ...p,
      briefRef:
        p.briefRef ??
        pkg.bags.find((b) => b.unitKey === p.unitKey)?.briefRef,
      lockCorridor: pkg.lockCorridor,
    }
  })
}
