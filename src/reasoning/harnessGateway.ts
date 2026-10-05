/**
 * Harness gateway: dual-gate (probe → human → execute) for motion actions.
 */

import type { BookIndex } from './pipelineA'
import type { FanoutInferUnit } from './fanoutCompose'
import type { ActionRecord } from './types'
import type {
  HarnessContext,
  MotionPlan,
  ProbeResult,
  ScopeRequest,
  WorkingSetState,
} from './harnessTypes'
import { probeScope } from './motionBrain'
import { applyCollapse, applyFaultIn } from './workingSet'
import {
  augmentQuestionWithMarkers,
  compileHarnessProjection,
  compilerBlocksToAbBlocks,
} from './harnessCompiler'
import { executeInferOps } from './toolGateway'
import { blocksFromInferUnit } from './inferBlocks'
import { unitMemberKeysOf } from './letterDesk'
import { FANOUT_ROLE_NOTE } from './fanoutRoles'

function newActionId(kind: string): string {
  return `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export type GatewayGateStatus = 'probe' | 'awaiting_approval' | 'approved' | 'rejected'

export interface PendingGatewayPlan {
  planId: string
  plan: MotionPlan
  probeResult: ProbeResult | null
  status: GatewayGateStatus
  unitKey?: string
}

export function plansNeedingHumanGate(plans: ReadonlyArray<MotionPlan>): MotionPlan[] {
  return plans.filter(
    (p) =>
      p.action === 'scopeRequest' ||
      p.action === 'faultIn' ||
      p.action === 'peek' ||
      (p.action === 'expand' &&
        p.faultInKeys.length > 0 &&
        p.faultInKeys.length <= 4),
  )
}

export function probeFaultInKeys(
  keys: ReadonlyArray<string>,
  bookIndex: BookIndex,
): ProbeResult {
  const keySet = new Set(bookIndex.chunks.map((c) => c.key))
  const candidateKeys = keys.filter((k) => keySet.has(k))
  return {
    found: candidateKeys.length > 0,
    candidateKeys,
    candidatePathIds: [],
    note:
      candidateKeys.length > 0
        ? `faultIn probe: ${candidateKeys.length}/${keys.length} keys in BookIndex`
        : 'faultIn probe: no keys in BookIndex',
  }
}

export function runProbeForPlan(input: {
  plan: MotionPlan
  ctx: HarnessContext
  bookIndex: BookIndex
}): MotionPlan {
  const { plan, ctx, bookIndex } = input
  if (plan.action === 'scopeRequest' && plan.scopeRequest) {
    const probeResult = probeScope({
      scope: plan.scopeRequest,
      docId: ctx.docId,
      bookIndexKeys: bookIndex.chunks.map((c) => c.key),
      archivePaths: ctx.historical.archivePaths,
      currentMemory: ctx.working.currentMemory,
    })
    return { ...plan, probeResult }
  }
  if (plan.action === 'faultIn' || plan.action === 'expand' || plan.action === 'peek') {
    const probeResult = probeFaultInKeys(plan.faultInKeys, bookIndex)
    return { ...plan, probeResult }
  }
  return plan
}

export function buildPendingGatewayPlans(
  plans: ReadonlyArray<MotionPlan>,
  ctx: HarnessContext,
  bookIndex: BookIndex,
  approvedIds: ReadonlySet<string>,
): PendingGatewayPlan[] {
  return plansNeedingHumanGate(plans).map((plan) => {
    const probed = runProbeForPlan({ plan, ctx, bookIndex })
    const approved = approvedIds.has(plan.planId)
    return {
      planId: plan.planId,
      plan: probed,
      probeResult: probed.probeResult ?? null,
      status: approved ? 'approved' : 'awaiting_approval',
      unitKey: plan.unitKey,
    }
  })
}

export function collapseActionRecord(input: {
  keys: ReadonlyArray<string>
  question: string
}): ActionRecord {
  return {
    actionId: newActionId('collapse'),
    actionKind: 'collapse',
    premiseKeys: [...input.keys],
    inputsRef: { question: input.question, role: 'gateway' },
    outputsRef: {
      roleNote: `${FANOUT_ROLE_NOTE.gateway} · collapse ${input.keys.length} keys`,
    },
    createdAt: Date.now(),
  }
}

export function faultInActionRecord(input: {
  keys: ReadonlyArray<string>
  question: string
  probe: ProbeResult
}): ActionRecord {
  return {
    actionId: newActionId('faultIn'),
    actionKind: 'faultIn',
    premiseKeys: [...input.keys],
    inputsRef: { question: input.question, role: 'gateway' },
    outputsRef: {
      roleNote: `${FANOUT_ROLE_NOTE.gateway} · faultIn · ${input.probe.note}`,
    },
    createdAt: Date.now(),
  }
}

export function scopeProbeActionRecord(input: {
  scope: ScopeRequest
  question: string
  probe: ProbeResult
}): ActionRecord {
  return {
    actionId: newActionId('scopeProbe'),
    actionKind: 'scopeProbe',
    premiseKeys: input.probe.candidateKeys.slice(0, input.scope.maxKeys),
    inputsRef: { question: input.question, role: 'gateway' },
    outputsRef: {
      roleNote: `${FANOUT_ROLE_NOTE.gateway} · scopeProbe ${input.scope.target} · ${input.probe.note}`,
      candidateKeys: input.probe.candidateKeys,
    },
    createdAt: Date.now(),
  }
}

export interface HarnessMotionResult {
  workingSet: WorkingSetState
  inferResult: Awaited<ReturnType<typeof executeInferOps>> | null
  actions: ActionRecord[]
  skipped: boolean
  skipReason?: string
}

/** Execute approved motion plan through gateway (faultIn / collapse / scopeRequest). */
export async function executeHarnessMotion(input: {
  plan: MotionPlan
  ctx: HarnessContext
  bookIndex: BookIndex
  unit: FanoutInferUnit
  question: string
  workingSet: WorkingSetState
  approved: boolean
}): Promise<HarnessMotionResult> {
  const actions: ActionRecord[] = []
  let ws = input.workingSet
  const memberKeys = unitMemberKeysOf(input.unit)

  if (!input.approved && plansNeedingHumanGate([input.plan]).length > 0) {
    return {
      workingSet: ws,
      inferResult: null,
      actions,
      skipped: true,
      skipReason: '未人批 · 双闸拒绝执行',
    }
  }

  if (input.plan.action === 'collapse') {
    ws = applyCollapse(ws, input.plan.collapseKeys)
    actions.push(
      collapseActionRecord({
        keys: input.plan.collapseKeys,
        question: input.question,
      }),
    )
    return { workingSet: ws, inferResult: null, actions, skipped: false }
  }

  if (input.plan.action === 'scopeRequest') {
    const probed = runProbeForPlan({
      plan: input.plan,
      ctx: input.ctx,
      bookIndex: input.bookIndex,
    })
    const probe = probed.probeResult
    if (!probe?.found) {
      return {
        workingSet: ws,
        inferResult: null,
        actions,
        skipped: true,
        skipReason: probe?.note ?? 'scope probe 无命中',
      }
    }
    actions.push(
      scopeProbeActionRecord({
        scope: input.plan.scopeRequest!,
        question: input.question,
        probe,
      }),
    )
    const scopePlan: MotionPlan = {
      ...input.plan,
      action: 'faultIn',
      faultInKeys: probe.candidateKeys,
    }
    return executeHarnessMotion({
      ...input,
      plan: scopePlan,
      workingSet: ws,
      approved: true,
    })
  }

  if (input.plan.action === 'peek') {
    const { executePeekCastParallel } = await import('./peekCast')
    const keys =
      input.plan.faultInKeys.length > 0
        ? input.plan.faultInKeys
        : memberKeys.slice(0, 1)
    const results = executePeekCastParallel({
      docId: input.bookIndex.docId,
      bookIndex: input.bookIndex,
      keys,
      approvedKeys: [...keys, ...memberKeys],
      question: input.question,
      taskId: input.ctx.taskId,
    })
    actions.push(...results.map((r) => r.action))
    const okKeys = results
      .filter((r) => r.ok)
      .map((r) => (r.ok ? r.entry?.key : undefined))
      .filter(Boolean) as string[]
    if (okKeys.length > 0) {
      ws = applyFaultIn(ws, okKeys)
    }
    const failed = results.filter((r) => !r.ok)
    if (failed.length === results.length) {
      return {
        workingSet: ws,
        inferResult: null,
        actions,
        skipped: true,
        skipReason: failed[0]?.verdict ?? 'peek 失败',
      }
    }
    return { workingSet: ws, inferResult: null, actions, skipped: false }
  }

  if (input.plan.action === 'faultIn' || input.plan.action === 'expand') {
    const probed = runProbeForPlan({
      plan: input.plan,
      ctx: input.ctx,
      bookIndex: input.bookIndex,
    })
    const keysToOpen =
      probed.probeResult?.candidateKeys.length
        ? probed.probeResult.candidateKeys
        : probed.faultInKeys

    if (keysToOpen.length === 0) {
      return {
        workingSet: ws,
        inferResult: null,
        actions,
        skipped: true,
        skipReason: 'faultIn keys 为空',
      }
    }

    ws = applyFaultIn(ws, keysToOpen)
    actions.push(
      faultInActionRecord({
        keys: keysToOpen,
        question: input.question,
        probe: probed.probeResult ?? probeFaultInKeys(keysToOpen, input.bookIndex),
      }),
    )

    const execPlan: MotionPlan = {
      ...probed,
      action: 'expand',
      faultInKeys: keysToOpen,
    }
    const compiled = compileHarnessProjection({
      ctx: input.ctx,
      bookIndex: input.bookIndex,
      plan: execPlan,
      memberKeys,
    })

    let abBlocks = compilerBlocksToAbBlocks(compiled.blocks)
    if (abBlocks.length === 0) {
      abBlocks = blocksFromInferUnit(input.unit, input.bookIndex)
    }
    if (abBlocks.length === 0) {
      return {
        workingSet: ws,
        inferResult: null,
        actions,
        skipped: true,
        skipReason: '编译 blocks 为空',
      }
    }

    const augmentedQuestion = augmentQuestionWithMarkers({
      question: input.question,
      pathMarkers: compiled.pathMarkers,
      refluxPremise: compiled.refluxPremise,
    })

    const inferResult = await executeInferOps({
      question: augmentedQuestion,
      blocks: abBlocks,
      unitLabel: input.unit.label,
      premiseKeys: memberKeys,
    })

    return { workingSet: ws, inferResult, actions, skipped: false }
  }

  return {
    workingSet: ws,
    inferResult: null,
    actions,
    skipped: true,
    skipReason: `未支持的 action: ${input.plan.action}`,
  }
}

export function allGatewayPlansApproved(
  pending: ReadonlyArray<PendingGatewayPlan>,
): boolean {
  if (pending.length === 0) return true
  return pending.every((p) => p.status === 'approved')
}
