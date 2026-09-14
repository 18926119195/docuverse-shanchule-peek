/**
 * Letter desk: global review before gateway runs.
 * Unit decisions: expand | deferred（指纹 combo reuse 已废除；复用只走 neighbour→path）。
 */

import type { FanoutInferUnit, FanoutUnitKind } from './fanoutCompose'
import type { FanoutPath } from './types'
import type { ReuseHit } from './toolArchive'
import type { MotionPlan } from './harnessTypes'
import { motionActionToLetterDecision } from './motionBrain'

/** Per-unit gate decided on the letter desk (not by the runner). */
export type LetterUnitDecision = 'reuse' | 'expand' | 'deferred'

/**
 * @deprecated 指纹 combo 复用策略已废除。
 * 仅保留 force_expand / budget（budget 现=新推预算，无 reuse 侧）。
 * 真正的 reuse 在 attentionIo：neighbour → historic query → path。
 */
export type LetterRunStrategy =
  | 'reuse_prefer'
  | 'budget'
  | 'reuse_only'
  | 'force_expand'

export interface LetterUnitRow {
  index: number
  kind: FanoutUnitKind
  label: string
  memberKeys: string[]
  unitKey: string
  /** Proposed / user-edited decision */
  decision: LetterUnitDecision
  /** Why this decision was proposed */
  rationale: string
  /** @deprecated 指纹 reuse 已删；恒为空 */
  reuseFromPathId?: string
}

export interface DeferredUnitArchive {
  id: string
  question: string
  kind: FanoutUnitKind
  label: string
  memberKeys: string[]
  unitKey: string
  createdAt: number
  rationale: string
}

export type LetterDeskStatus = 'empty' | 'review' | 'executing' | 'done'

export interface LetterDeskSnapshot {
  status: LetterDeskStatus
  question: string
  /** Combinations enumerated under current compose policy */
  comboCount: number
  strategy: LetterRunStrategy
  /** Max expand slots when strategy === 'budget' */
  expandBudget: number
  rows: LetterUnitRow[]
  counts: {
    reuse: number
    expand: number
    deferred: number
  }
}

export function unitMemberKeysOf(unit: FanoutInferUnit): string[] {
  if (unit.candidate.R.memberKeys?.length) return unit.candidate.R.memberKeys
  return [unit.candidate.R.key]
}

/** @deprecated 指纹 combo 复用已删；恒返回 null */
export function findAcceptedForCombo(
  _unit: FanoutInferUnit,
  _accepted: FanoutPath[],
  _currentQuestion: string,
): FanoutPath | null {
  return null
}

/**
 * @deprecated 指纹 combo 复用已删（2026-09-04）。
 * 复用请走 neighbour → path（attentionIo / runReuseGate）。
 */
export function findReusableForCombo(_input: {
  unit: FanoutInferUnit
  question: string
  accepted: FanoutPath[]
  inferred: FanoutPath[]
  modelId: string
}): ReuseHit | null {
  return null
}

const KIND_PRIORITY: Record<FanoutUnitKind, number> = {
  fine: 0,
  cluster: 1,
}

export function proposeLetterRows(input: {
  units: FanoutInferUnit[]
  question: string
  acceptedPaths: FanoutPath[]
  inferredPaths?: FanoutPath[]
  modelId?: string
  strategy: LetterRunStrategy
  expandBudget: number
  allowReuse: boolean
}): LetterUnitRow[] {
  const { units, strategy, expandBudget } = input
  // 指纹 reuse 已废除：不再查 archive combo；一律按 expand/deferred
  void input.allowReuse
  void input.acceptedPaths
  void input.inferredPaths
  void input.modelId
  void input.question

  const ordered = units
    .map((unit, index) => ({ index, unit }))
    .sort(
      (a, b) =>
        KIND_PRIORITY[a.unit.kind] - KIND_PRIORITY[b.unit.kind] ||
        a.index - b.index,
    )

  let expandQuota: number
  if (strategy === 'reuse_only') {
    // 旧 reuse_only：无指纹可复用 → 全部 deferred（引导走 path reuse）
    expandQuota = 0
  } else if (strategy === 'budget') {
    expandQuota = Math.max(0, expandBudget)
  } else {
    // force_expand / 旧 reuse_prefer → 全部新推
    expandQuota = ordered.length
  }

  const expandSet = new Set(ordered.slice(0, expandQuota).map((t) => t.index))

  return units.map((unit, index) => {
    const memberKeys = unitMemberKeysOf(unit)
    const unitKey = unit.candidate.R.key
    if (expandSet.has(index)) {
      return {
        index,
        kind: unit.kind,
        label: unit.label,
        memberKeys,
        unitKey,
        decision: 'expand' as const,
        rationale:
          strategy === 'budget'
            ? `策略：本轮预算内新推（≤${expandBudget}）；指纹 reuse 已废`
            : '策略：本轮新推（指纹 combo reuse 已废除；问线复用走 neighbour→path）',
      }
    }
    return {
      index,
      kind: unit.kind,
      label: unit.label,
      memberKeys,
      unitKey,
      decision: 'deferred' as const,
      rationale: '尚未展开 · 已入待推存档（指纹 reuse 已废）',
    }
  })
}

/**
 * Overlay motion-brain plans onto letter rows (match by unitKey).
 * 指纹 reuse 动作降级为 expand（真正的 reuse 不在 fanout 层）。
 */
export function applyMotionPlansToLetterRows(
  rows: LetterUnitRow[],
  plans: ReadonlyArray<MotionPlan>,
): LetterUnitRow[] {
  const byUnit = new Map<string, MotionPlan>()
  for (const p of plans) {
    if (p.unitKey && !byUnit.has(p.unitKey)) byUnit.set(p.unitKey, p)
  }
  return rows.map((row) => {
    const plan = byUnit.get(row.unitKey)
    if (!plan) return row
    let decision = motionActionToLetterDecision(plan.action)
    if (!decision) return row
    if (decision === 'reuse') {
      decision = 'expand'
    }
    return {
      ...row,
      decision,
      rationale: `[运动脑#${plan.rank}] ${plan.rationale}（fanout 指纹 reuse 已废→expand）`,
      reuseFromPathId: undefined,
    }
  })
}

export function countDecisions(rows: LetterUnitRow[]): LetterDeskSnapshot['counts'] {
  return {
    reuse: rows.filter((r) => r.decision === 'reuse').length,
    expand: rows.filter((r) => r.decision === 'expand').length,
    deferred: rows.filter((r) => r.decision === 'deferred').length,
  }
}

export function snapshotFromRows(input: {
  question: string
  comboCount: number
  strategy: LetterRunStrategy
  expandBudget: number
  rows: LetterUnitRow[]
  status?: LetterDeskStatus
}): LetterDeskSnapshot {
  return {
    status: input.status ?? 'review',
    question: input.question,
    comboCount: input.comboCount,
    strategy: input.strategy,
    expandBudget: input.expandBudget,
    rows: input.rows,
    counts: countDecisions(input.rows),
  }
}

export function rowsToDeferredArchive(
  question: string,
  rows: LetterUnitRow[],
): DeferredUnitArchive[] {
  const now = Date.now()
  return rows
    .filter((r) => r.decision === 'deferred')
    .map((r) => ({
      id: `deferred_${now.toString(36)}_${r.index}_${Math.random().toString(36).slice(2, 6)}`,
      question,
      kind: r.kind,
      label: r.label,
      memberKeys: r.memberKeys,
      unitKey: r.unitKey,
      createdAt: now,
      rationale: r.rationale,
    }))
}

/**
 * Compact path marker for model reflux + human glance.
 */
export function buildPathMarker(input: {
  unitLabel: string
  memberKeys: string[]
  question: string
  conclusion: string
  path: string
  reused?: boolean
}): string {
  const keys = input.memberKeys.join('+')
  const q = input.question.replace(/\s+/g, ' ').trim().slice(0, 100)
  const c = input.conclusion.replace(/\s+/g, ' ').trim().slice(0, 180)
  const p = input.path
    .replace(/^【复用[^\n]*】\n?/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)
  return [
    'PATH_MARK v1',
    `unit=${input.unitLabel}`,
    `keys=${keys}`,
    `mode=${input.reused ? 'path_reuse' : 'infer'}`,
    `Q=${q}`,
    `C=${c}`,
    `P=${p}`,
  ].join('\n')
}

export function strategyLabel(s: LetterRunStrategy): string {
  if (s === 'budget') return '新推有预算；其余尚未展开（指纹 reuse 已废）'
  if (s === 'reuse_only') return '（旧）只复用 → 现无指纹可复用，全部尚未展开'
  if (s === 'reuse_prefer') return '（旧）优先复用 → 现等同强制全部新推'
  return '强制全部新推（问线复用请走 neighbour→path）'
}
