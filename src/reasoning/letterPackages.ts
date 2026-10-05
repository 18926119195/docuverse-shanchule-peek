/**
 * Package A (corridor) / Package B (door+bag) — letter desk delivery schemas.
 * Handbook §0.9: split hops so corridor NL and door briefs never share one LLM window.
 */

import type { BookSemanticIndex, SectionNode } from './semanticIndex'
import {
  keysInSections,
  rankSections,
  sectionById,
} from './semanticIndex'
import type { SuggestAction } from './keyDecisionState'
import { doorsForKeys, getDoorEntry } from './keyDecisionState'
import type { WorkingSetState } from './harnessTypes'
import type { FanoutInferUnit } from './fanoutCompose'
import type { LetterUnitRow } from './letterDesk'
import { unitMemberKeysOf } from './letterDesk'
import type { FanoutPath } from './types'
import type { BookIndex } from './pipelineA'

export interface CorridorRow {
  nodeId: string
  title: string
  summary: string
  page: number
  pageRange?: { startPage: number; endPage: number }
  memberKeyCount: number
  sectionBrief?: string
  score: number
}

/** Package A — corridors only (no door briefs). */
export interface CorridorPackage {
  kind: 'corridor'
  question: string
  rows: CorridorRow[]
  lockCorridor?: string
  skipPackageA: boolean
  gap?: string
}

export interface DoorRow {
  key: string
  page: number
  sectionTitle?: string
  nodeId?: string
  doorBrief?: string
  briefKey?: string
  /** @deprecated 用 briefKey */
  briefContentHash?: string
  suggestAction?: SuggestAction
  alreadyExpanded: boolean
  score?: number
}

export interface BagDraftRow {
  unitKey: string
  memberKeys: string[]
  label: string
  kind: string
  decision?: 'reuse' | 'expand' | 'deferred'
  reuseFromPathId?: string
  fpExact?: boolean
  qOverlap?: number
  hint?: string
  briefRef?: string
}

/** Package B — doors + optional bag drafts (no long corridor essays). */
export interface DoorPackage {
  kind: 'door'
  question: string
  lockCorridor: string
  draftKeys: string[]
  scopedKeys: string[]
  doors: DoorRow[]
  bags: BagDraftRow[]
  lockKeys?: string[]
  weakenPackageB: boolean
}

export interface LetterLockState {
  lockCorridor?: string
  lockKeys?: string[]
  skipPackageA?: boolean
  weakenPackageB?: boolean
}

function memberKeysOfSection(
  semantic: BookSemanticIndex,
  nodeId: string,
): string[] {
  return [...keysInSections(semantic, new Set([nodeId]))]
}

export function buildCorridorPackage(input: {
  question: string
  semantic: BookSemanticIndex
  draftKeys?: ReadonlyArray<string>
  lock?: LetterLockState
  gap?: string
  topK?: number
}): CorridorPackage {
  const lockCorridor = input.lock?.lockCorridor
  const skip =
    Boolean(input.lock?.skipPackageA) ||
    Boolean(lockCorridor && input.lock?.lockCorridor)

  if (skip && lockCorridor) {
    const sec = sectionById(input.semantic, lockCorridor)
    const keys = memberKeysOfSection(input.semantic, lockCorridor)
    return {
      kind: 'corridor',
      question: input.question,
      skipPackageA: true,
      lockCorridor,
      gap: input.gap,
      rows: sec
        ? [
            {
              nodeId: sec.nodeId,
              title: sec.title,
              summary: sec.summary,
              page: sec.page,
              pageRange: sec.pageRange,
              memberKeyCount: keys.length,
              score: 1,
            },
          ]
        : [],
    }
  }

  const topK = input.topK ?? 5
  const ranked = rankSections(input.semantic, input.question, topK * 2)
  const draftSet = new Set(input.draftKeys ?? [])
  const rows: CorridorRow[] = []

  const pushSec = (sec: SectionNode, score: number) => {
    const keys = memberKeysOfSection(input.semantic, sec.nodeId)
    const overlap =
      draftSet.size === 0
        ? keys.length
        : keys.filter((k) => draftSet.has(k)).length
    rows.push({
      nodeId: sec.nodeId,
      title: sec.title,
      summary: sec.summary,
      page: sec.page,
      pageRange: sec.pageRange ?? {
        startPage: sec.page,
        endPage: sec.page,
      },
      memberKeyCount: keys.length,
      score: score + overlap * 0.01,
    })
  }

  if (ranked.length > 0) {
    for (const h of ranked.slice(0, topK)) pushSec(h.node, h.score)
  } else {
    for (const sec of input.semantic.sections.slice(0, topK)) {
      pushSec(sec, 0.1)
    }
  }

  rows.sort((a, b) => b.score - a.score)
  return {
    kind: 'corridor',
    question: input.question,
    rows: rows.slice(0, topK),
    skipPackageA: false,
    gap: input.gap,
  }
}

export function buildDoorPackage(input: {
  question: string
  docId: string
  bookIndex: BookIndex
  semantic: BookSemanticIndex
  lockCorridor: string
  draftKeys: ReadonlyArray<string>
  scopedKeys?: ReadonlyArray<string>
  workingSet?: WorkingSetState
  bags: FanoutInferUnit[]
  letterRows?: LetterUnitRow[]
  acceptedPaths?: FanoutPath[]
  inferredPaths?: FanoutPath[]
  modelId?: string
  lock?: LetterLockState
}): DoorPackage {
  const scoped = input.scopedKeys ?? []
  const corridorKeys = memberKeysOfSection(
    input.semantic,
    input.lockCorridor,
  )
  const pool = [
    ...new Set([
      ...input.draftKeys.filter((k) => corridorKeys.includes(k)),
      ...corridorKeys.filter((k) => input.draftKeys.includes(k)),
    ]),
  ]
  const effectivePool =
    pool.length > 0
      ? pool
      : corridorKeys.length > 0
        ? corridorKeys.slice(0, 24)
        : [...input.draftKeys]

  const expanded = input.workingSet?.expanded ?? new Set<string>()
  const sec = sectionById(input.semantic, input.lockCorridor)
  const tipMap = new Map(
    doorsForKeys(input.docId, effectivePool).map((e) => [e.key, e]),
  )

  const doors: DoorRow[] = effectivePool.map((key) => {
    const chunk = input.bookIndex.chunks.find((c) => c.key === key)
    const tip = tipMap.get(key) ?? getDoorEntry(input.docId, key)
    return {
      key,
      page: chunk?.page ?? sec?.page ?? 0,
      sectionTitle: sec?.title,
      nodeId: input.lockCorridor,
      doorBrief: tip?.decisionBrief,
      briefKey: tip?.briefKey,
      briefContentHash: tip?.briefKey,
      suggestAction: tip?.suggestAction,
      alreadyExpanded: expanded.has(key),
    }
  })

  const lockKeys = input.lock?.lockKeys?.filter(Boolean) ?? []
  const weaken =
    Boolean(input.lock?.weakenPackageB) ||
    (lockKeys.length > 0 &&
      lockKeys.every((k) => effectivePool.includes(k)))

  const bags: BagDraftRow[] = input.bags.map((unit, i) => {
    const members = unitMemberKeysOf(unit)
    const row = input.letterRows?.[i]
    return {
      unitKey: unit.candidate.R.key,
      memberKeys: members,
      label: unit.label,
      kind: unit.kind,
      decision: row?.decision,
      reuseFromPathId: undefined,
      fpExact: false,
      hint: row?.rationale,
      briefRef:
        members.length === 1
          ? tipMap.get(members[0])?.briefKey
          : undefined,
    }
  })

  return {
    kind: 'door',
    question: input.question,
    lockCorridor: input.lockCorridor,
    draftKeys: [...input.draftKeys],
    scopedKeys: [...scoped],
    doors,
    bags,
    lockKeys: lockKeys.length ? lockKeys : undefined,
    weakenPackageB: weaken,
  }
}

export function pickDefaultLockCorridor(pkg: CorridorPackage): string | null {
  if (pkg.lockCorridor) return pkg.lockCorridor
  return pkg.rows[0]?.nodeId ?? null
}
