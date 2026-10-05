/**
 * Micro loop (handbook R5): supervision evidence_gap → partial faultIn → retry infer.
 * Formal Validator / REJECT_* is no longer the driver.
 */

import type { BookIndex } from './pipelineA'
import type { FanoutInferUnit } from './fanoutCompose'
import type {
  HarnessContext,
  MotionBrainInput,
  MotionPlan,
  MotionTrigger,
  WorkingSetState,
} from './harnessTypes'
import { buildMotionPlans } from './motionBrain'
import { executeInferOps } from './toolGateway'
import {
  augmentQuestionWithMarkers,
  compileHarnessProjection,
  compilerBlocksToAbBlocks,
} from './harnessCompiler'
import { blocksFromInferUnit } from './inferBlocks'
import { unitMemberKeysOf } from './letterDesk'
import { applyFaultIn } from './workingSet'
import { runSupervisionPass } from './supervisionLoop'

export const MAX_MICRO_LOOPS = 2

export interface MicroLoopResult {
  result: Awaited<ReturnType<typeof executeInferOps>>
  workingSet: WorkingSetState
  plansTried: MotionPlan[]
  loopCount: number
  /** Supervision tones that triggered retries */
  lastSupervisionNotes: string[]
}

function supervisionTrigger(
  signal: string,
  ref?: string,
): MotionTrigger {
  return { kind: 'evidence_gap', signal, ref }
}

function nextPartialPlan(
  base: MotionPlan,
  memberKeys: ReadonlyArray<string>,
  openedCount: number,
): MotionPlan {
  const remaining = memberKeys.filter((k) => !base.faultInKeys.includes(k))
  const extra = remaining.slice(0, Math.max(1, memberKeys.length - openedCount))
  const faultInKeys = [...new Set([...base.faultInKeys, ...extra])]
  return {
    ...base,
    planId: `${base.planId}_micro_${openedCount}`,
    action: 'faultIn',
    faultInKeys,
    rationale: `微 loop · 监督证据缺口 · partial fault-in ${faultInKeys.length}/${memberKeys.length}`,
    trigger: base.trigger,
  }
}

async function inferOnce(input: {
  unit: FanoutInferUnit
  question: string
  bookIndex: BookIndex
  ctx: HarnessContext
  plan: MotionPlan
  workingSet: WorkingSetState
}): Promise<{
  result: Awaited<ReturnType<typeof executeInferOps>>
  workingSet: WorkingSetState
}> {
  const memberKeys = unitMemberKeysOf(input.unit)
  let ws = input.workingSet
  if (input.plan.faultInKeys.length > 0) {
    ws = applyFaultIn(ws, input.plan.faultInKeys)
  }

  const compiled = compileHarnessProjection({
    ctx: input.ctx,
    bookIndex: input.bookIndex,
    plan: input.plan,
    memberKeys,
  })

  let abBlocks = compilerBlocksToAbBlocks(compiled.blocks)
  if (abBlocks.length === 0) {
    abBlocks = blocksFromInferUnit(input.unit, input.bookIndex)
  }

  if (abBlocks.length === 0) {
    const action = {
      actionId: `infer_empty_${Date.now()}`,
      actionKind: 'infer' as const,
      premiseKeys: [...memberKeys],
      inputsRef: { question: input.question, role: 'gateway' as const },
      outputsRef: { error: '编译 blocks 为空' },
      createdAt: Date.now(),
    }
    return {
      result: {
        action,
        direction: null,
        ok: false,
        error: '编译 blocks 为空',
      },
      workingSet: ws,
    }
  }

  const augmentedQuestion = augmentQuestionWithMarkers({
    question: input.question,
    pathMarkers: compiled.pathMarkers,
    refluxPremise: compiled.refluxPremise,
  })

  const result = await executeInferOps({
    question: augmentedQuestion,
    blocks: abBlocks,
    unitLabel: input.unit.label,
    premiseKeys: memberKeys,
  })

  return { result, workingSet: ws }
}

/**
 * Infer with up to MAX_MICRO_LOOPS retries when supervision flags evidence gap.
 */
export async function inferWithMicroLoop(input: {
  unit: FanoutInferUnit
  question: string
  bookIndex: BookIndex
  ctx: HarnessContext
  initialPlan: MotionPlan
  brainInput: MotionBrainInput
  workingSet: WorkingSetState
  maxLoops?: number
}): Promise<MicroLoopResult> {
  const maxLoops = input.maxLoops ?? MAX_MICRO_LOOPS
  const memberKeys = unitMemberKeysOf(input.unit)
  const plansTried: MotionPlan[] = []
  let plan = input.initialPlan
  let ws = input.workingSet
  const lastNotes: string[] = []
  let loopCount = 0

  for (let i = 0; i <= maxLoops; i++) {
    loopCount = i
    plansTried.push(plan)
    const { result, workingSet: nextWs } = await inferOnce({
      unit: input.unit,
      question: input.question,
      bookIndex: input.bookIndex,
      ctx: input.ctx,
      plan,
      workingSet: ws,
    })
    ws = nextWs

    if (!result.ok || !result.direction) {
      lastNotes.push(result.error ?? 'infer 失败')
      if (i >= maxLoops) break
      const trigger = supervisionTrigger(result.error ?? 'infer 失败', 'infer_fail')
      plan = nextPartialPlan(plan, memberKeys, plan.faultInKeys.length + 1)
      plan = { ...plan, trigger }
      continue
    }

    const delivered =
      plan.faultInKeys.length > 0 ? plan.faultInKeys : memberKeys
    const returned =
      result.usedKeys?.length
        ? result.usedKeys
        : result.direction.premiseKeys?.length
          ? result.direction.premiseKeys
          : delivered

    const sup = runSupervisionPass({
      question: input.question,
      deliveredKeys: delivered,
      returnedKeys: returned,
      conclusion: result.direction.conclusion,
      path: null,
    })

    const materialOk = sup.delta.materialSupportsConclusion !== false
    const toneOk =
      (sup.delta.tone === 'ok' ||
        sup.delta.tone === 'gray_same' ||
        (sup.delta.tone === 'bright_diff' && materialOk)) &&
      sup.ok

    if (toneOk && materialOk && sup.delta.tone !== 'reject') {
      return {
        result,
        workingSet: ws,
        plansTried,
        loopCount,
        lastSupervisionNotes: [],
      }
    }

    const note = [
      sup.delta.summary,
      ...sup.delta.notes,
      materialOk ? '' : '材料是否撑住结论存疑',
    ]
      .filter(Boolean)
      .join(' · ')
    lastNotes.push(note)

    if (i >= maxLoops) {
      return {
        result,
        workingSet: ws,
        plansTried,
        loopCount,
        lastSupervisionNotes: lastNotes,
      }
    }

    const trigger = supervisionTrigger(note, sup.delta.tone)
    const nextPlans = buildMotionPlans({
      ...input.brainInput,
      validatorSignal: trigger,
      expandBudget: Math.max(1, input.brainInput.expandBudget),
    })

    const unitPlan =
      nextPlans.find((p) => p.unitKey === input.unit.candidate.R.key) ??
      nextPlans[0]

    if (unitPlan && memberKeys.length > 1) {
      plan = nextPartialPlan(plan, memberKeys, plan.faultInKeys.length + 1)
      plan = { ...plan, trigger }
    } else if (unitPlan) {
      plan = { ...unitPlan, trigger }
    } else {
      plan = nextPartialPlan(plan, memberKeys, plan.faultInKeys.length + 1)
      plan = { ...plan, trigger }
    }
  }

  const last = await inferOnce({
    unit: input.unit,
    question: input.question,
    bookIndex: input.bookIndex,
    ctx: input.ctx,
    plan,
    workingSet: ws,
  })

  return {
    result: last.result,
    workingSet: last.workingSet,
    plansTried,
    loopCount,
    lastSupervisionNotes: lastNotes,
  }
}
