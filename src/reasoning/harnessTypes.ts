/**
 * Harness context types — strict contracts for working vs historical memory.
 */

import type { FormalOp } from './formalPath'
import type { ActionRecord, FanoutPath } from './types'
import type { DeferredUnitArchive } from './letterDesk'

/** Path settlement lifecycle */
export type SettlementStatus = 'pending' | 'settled' | 'discarded'

/** Where an accepted path lives in memory */
export type MemoryTier = 'current' | 'archive'

export type MotionAction =
  | 'expand'
  | 'reuse'
  | 'deferred'
  | 'faultIn'
  | 'collapse'
  | 'scopeRequest'
  | 'peek'

export type MotionTriggerKind =
  | 'supervision'
  | 'evidence_gap'
  | 'user_question'
  | 'scope_need'
  /** @deprecated use supervision / evidence_gap */
  | 'validator'

export interface MotionTrigger {
  kind: MotionTriggerKind
  priorQuestion?: string
  signal: string
  ref?: string
}

export interface ScopeRequest {
  target: 'currentMemory' | 'archiveOnly' | 'crossDoc'
  docId?: string
  maxKeys: number
  reason: string
}

export interface ProbeResult {
  found: boolean
  candidateKeys: string[]
  candidatePathIds: string[]
  note: string
}

export interface MotionPlan {
  rank: number
  planId: string
  action: MotionAction
  faultInKeys: string[]
  collapseKeys: ReadonlyArray<string>
  unitKey?: string
  reuseFromPathId?: string
  score: number
  rationale: string
  trigger?: MotionTrigger
  scopeRequest?: ScopeRequest
  probeResult?: ProbeResult
  /** Cite door tip when plan used KeyDecisionState */
  briefRef?: string
  lockCorridor?: string
}

export interface WorkingSetState {
  expanded: ReadonlySet<string>
  collapsed: ReadonlySet<string>
  pinned: ReadonlySet<string>
  closed: ReadonlySet<string>
}

export interface PathMemoryEntry {
  pathId: string
  path: FanoutPath
  settlement: SettlementStatus
  memoryTier: MemoryTier | null
  acceptedAt: number | null
  /** @deprecated formal ops theater retired; always empty */
  formalOps: ReadonlyArray<FormalOp>
  referencedPathIds: ReadonlyArray<string>
}

export interface ForbidPatternEntry {
  fingerprint: string
  memberKeysSignature: string
  conclusionPrefix: string
  rejectCount: number
  lastRejectedAt: number
  questionPrefix: string
}

export interface HistoricalLedger {
  settledPaths: PathMemoryEntry[]
  actionLog: ActionRecord[]
  archivePaths: PathMemoryEntry[]
  forbidPatterns: ForbidPatternEntry[]
}

export interface WorkingContext {
  taskId: string
  question: string
  pendingPaths: PathMemoryEntry[]
  currentMemory: PathMemoryEntry[]
  workingSet: WorkingSetState
  deferredUnits: DeferredUnitArchive[]
  draftKeys: string[]
  lastMotionPlans: MotionPlan[]
  approvedPlanIds: ReadonlyArray<string>
}

export interface HarnessContext {
  docId: string
  taskId: string
  updatedAt: number
  historical: HistoricalLedger
  working: WorkingContext
}

export interface AcceptPathOptions {
  pinToCurrent: boolean
  /** Promote referenced paths to archive pointers when accepting */
  lineageClosure: boolean
}

export interface CompilerBlock {
  key: string
  text: string
  page?: number
  shortHandle?: string
  sectionTitle?: string
}

export interface HarnessCompileResult {
  question: string
  allowedKeys: ReadonlyArray<string>
  blocks: ReadonlyArray<CompilerBlock>
  pathMarkers: ReadonlyArray<string>
  refluxPremise: ReadonlyArray<{
    conclusion: string
    pathSummary: string
    fromKey: string
  }>
  mode: 'expand' | 'reuse' | 'deferred' | 'faultInOnly'
}

export interface MotionBrainInput {
  question: string
  docId: string
  draftKeys: ReadonlyArray<string>
  composeCandidates: ReadonlyArray<{
    unitKey: string
    kind: string
    label: string
    memberKeys: ReadonlyArray<string>
  }>
  workingSet: WorkingSetState
  currentMemory: ReadonlyArray<PathMemoryEntry>
  archivePaths: ReadonlyArray<PathMemoryEntry>
  reuseHits: ReadonlyArray<{
    unitKey: string
    pathId: string
    score: number
  }>
  expandBudget: number
  maxKeysPerPlan: number
  forbidPatterns: ReadonlyArray<ForbidPatternEntry>
  validatorSignal?: MotionTrigger
}

export interface ScopeProbeInput {
  scope: ScopeRequest
  docId: string
  bookIndexKeys: ReadonlyArray<string>
  archivePaths: ReadonlyArray<PathMemoryEntry>
  currentMemory: ReadonlyArray<PathMemoryEntry>
}

export const DEFAULT_ACCEPT_OPTIONS: AcceptPathOptions = {
  pinToCurrent: true,
  lineageClosure: true,
}

export function emptyWorkingSet(): WorkingSetState {
  return {
    expanded: new Set(),
    collapsed: new Set(),
    pinned: new Set(),
    closed: new Set(),
  }
}

export function cloneWorkingSet(ws: WorkingSetState): WorkingSetState {
  return {
    expanded: new Set(ws.expanded),
    collapsed: new Set(ws.collapsed),
    pinned: new Set(ws.pinned),
    closed: new Set(ws.closed),
  }
}
