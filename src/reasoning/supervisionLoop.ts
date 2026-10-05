/**
 * Supervision loop shell — gray-same / bright-diff + material check (checklist P3).
 * Does not replace G*; sits beside gateway after infer / peek.
 */

import type { ActionRecord, FanoutPath } from './types'
import type { GateFail } from './hardGates'
import { gateReturnSubset } from './hardGates'

export type SupervisionTone = 'gray_same' | 'bright_diff' | 'reject' | 'ok'

export interface SupervisionDelta {
  tone: SupervisionTone
  summary: string
  deliveredKeys: string[]
  returnedKeys: string[]
  droppedKeys: string[]
  missingKeys: string[]
  materialSupportsConclusion?: boolean | null
  notes: string[]
}

export interface SupervisionReport {
  ok: boolean
  delta: SupervisionDelta
  gateFails: GateFail[]
  action: ActionRecord
}

function newActionId(): string {
  return `sup_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Compare delivered package keys vs path / infer return; flag material support softly.
 */
export function runSupervisionPass(input: {
  question: string
  deliveredKeys: ReadonlyArray<string>
  returnedKeys: ReadonlyArray<string>
  conclusion?: string
  path?: FanoutPath | null
  priorBriefHashes?: ReadonlyArray<string>
}): SupervisionReport {
  const g = gateReturnSubset(input.deliveredKeys, input.returnedKeys)
  const dropped = g.dropped ?? []
  const missing = g.missing ?? []
  const accepted = g.accepted ?? []

  const notes: string[] = []
  let tone: SupervisionTone = 'ok'
  let materialSupportsConclusion: boolean | null = null

  if (!g.ok || (dropped.length > 0 && accepted.length === 0)) {
    tone = 'reject'
    notes.push('返回键不在递交集')
  } else if (dropped.length > 0 || missing.length > 0) {
    tone = 'bright_diff'
    if (dropped.length) notes.push(`多报: ${dropped.slice(0, 3).join(',')}`)
    if (missing.length) notes.push(`未回: ${missing.slice(0, 3).join(',')}`)
  } else if (
    input.conclusion &&
    input.deliveredKeys.length > 0 &&
    input.conclusion.length < 12
  ) {
    tone = 'bright_diff'
    notes.push('结论过短·材料是否撑住存疑')
    materialSupportsConclusion = false
  } else if (accepted.length > 0 && !dropped.length && !missing.length) {
    tone = 'gray_same'
    notes.push('递交与回执键一致')
    materialSupportsConclusion =
      input.conclusion != null ? input.conclusion.trim().length >= 12 : null
  }

  const delta: SupervisionDelta = {
    tone,
    summary:
      tone === 'ok' || tone === 'gray_same'
        ? '监督通过'
        : tone === 'reject'
          ? '监督拒绝'
          : '监督标黄·有增量差',
    deliveredKeys: [...input.deliveredKeys],
    returnedKeys: [...input.returnedKeys],
    droppedKeys: dropped,
    missingKeys: missing,
    materialSupportsConclusion,
    notes,
  }

  const action: ActionRecord = {
    actionId: newActionId(),
    actionKind: 'supervise',
    premiseKeys: [...input.deliveredKeys],
    inputsRef: {
      question: input.question,
      role: 'supervise',
      priorBriefHashes: input.priorBriefHashes
        ? [...input.priorBriefHashes]
        : undefined,
    },
    outputsRef: {
      tone: delta.tone,
      summary: delta.summary,
      notes: delta.notes,
      roleNote: `监督 · ${delta.tone}`,
      candidateKeys: accepted,
    },
    createdAt: Date.now(),
  }

  return {
    ok: tone === 'ok' || tone === 'gray_same' || tone === 'bright_diff',
    delta,
    gateFails: g.ok ? [] : g.fails,
    action,
  }
}
