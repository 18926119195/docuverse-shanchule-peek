/**
 * Instruction compose — bags from motion brain / human (handbook §0.10).
 * Geometric fallback DELETED.
 */

import type { BookIndex, CircleCandidate, AChunk } from './pipelineA'
import type { FanoutInferUnit } from './fanoutCompose'
import { unitFromMemberKeys } from './fanoutCompose'
import { gateBagSubset } from './hardGates'
import { FANOUT_ROLE_NOTE } from './fanoutRoles'
import type { ActionRecord } from './types'

function newActionId(kind: string): string {
  return `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export type InstructionBagMode =
  | 'fine_only'
  | 'top_singles'
  | 'pair_adjacent'
  | 'custom'

export interface InstructionComposeSpec {
  mode?: InstructionBagMode
  /** Max bags (default 5) */
  maxBags?: number
  /** Explicit bags from motion brain / human (each ⊆ allow set) */
  customBags?: ReadonlyArray<ReadonlyArray<string>>
}

function chunkByKey(index: BookIndex, key: string): AChunk | undefined {
  return index.chunks.find((c) => c.key === key)
}

function adjacentPairs(
  hits: Array<AChunk & { score: number }>,
): Array<[AChunk & { score: number }, AChunk & { score: number }]> {
  const sorted = [...hits].sort((a, b) => a.ord - b.ord)
  const pairs: Array<[AChunk & { score: number }, AChunk & { score: number }]> =
    []
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (a.page === b.page && b.ord === a.ord + 1) pairs.push([a, b])
  }
  return pairs
}

/**
 * Build instruction bags; drops any bag that fails G1.
 */
export async function composeInstructionBags(
  bookIndex: BookIndex,
  fineCandidates: CircleCandidate[],
  draftKeys: ReadonlyArray<string>,
  scopedKeys: ReadonlyArray<string> = [],
  spec: InstructionComposeSpec = {},
): Promise<FanoutInferUnit[]> {
  const maxBags = spec.maxBags ?? 5
  const mode = spec.mode ?? 'top_singles'
  const allow = new Set([...draftKeys, ...scopedKeys])
  const units: FanoutInferUnit[] = []

  const pushIfOk = async (u: FanoutInferUnit | null) => {
    if (!u || units.length >= maxBags) return
    const members = u.candidate.R.memberKeys?.length
      ? u.candidate.R.memberKeys
      : [u.candidate.R.key]
    const g = gateBagSubset(members, draftKeys, scopedKeys)
    if (!g.ok) return
    units.push(u)
  }

  if (mode === 'custom' && spec.customBags?.length) {
    for (const bag of spec.customBags) {
      const keys = bag.filter((k) => allow.has(k))
      if (keys.length === 0) continue
      await pushIfOk(await unitFromMemberKeys(bookIndex, keys))
    }
    return units
  }

  const scored = fineCandidates
    .map((c) => {
      const chunk = chunkByKey(bookIndex, c.R.key)
      if (!chunk || !allow.has(c.R.key)) return null
      return { ...chunk, score: c.score }
    })
    .filter((c): c is AChunk & { score: number } => Boolean(c))
    .sort((a, b) => b.score - a.score)

  if (mode === 'fine_only' || mode === 'top_singles') {
    for (const c of scored.slice(0, maxBags)) {
      await pushIfOk(await unitFromMemberKeys(bookIndex, [c.key]))
    }
  }

  if (mode === 'pair_adjacent') {
    for (const [a, b] of adjacentPairs(scored).slice(0, maxBags)) {
      await pushIfOk(await unitFromMemberKeys(bookIndex, [a.key, b.key]))
    }
    for (const c of scored) {
      if (units.length >= maxBags) break
      await pushIfOk(await unitFromMemberKeys(bookIndex, [c.key]))
    }
  }

  return units
}

export async function executeInstructionCompose(input: {
  bookIndex: BookIndex
  fineCandidates: CircleCandidate[]
  draftKeys: ReadonlyArray<string>
  scopedKeys?: ReadonlyArray<string>
  question?: string
  spec?: InstructionComposeSpec
}): Promise<{
  action: ActionRecord
  units: FanoutInferUnit[]
  ok: boolean
  error?: string
}> {
  const scoped = input.scopedKeys ?? []
  const draftKeys =
    input.draftKeys.length > 0
      ? input.draftKeys
      : input.fineCandidates.map((c) => c.R.key)

  const units = await composeInstructionBags(
    input.bookIndex,
    input.fineCandidates,
    draftKeys,
    scoped,
    input.spec,
  )

  const allMembers = [
    ...new Set(
      units.flatMap((u) =>
        u.candidate.R.memberKeys?.length
          ? u.candidate.R.memberKeys
          : [u.candidate.R.key],
      ),
    ),
  ]

  const action: ActionRecord = {
    actionId: newActionId('compose'),
    actionKind: 'compose',
    premiseKeys: [...allMembers],
    inputsRef: {
      question: input.question,
      sourceKeys: [...draftKeys],
      role: 'letter',
      composeMode: input.spec?.mode ?? 'top_singles',
    },
    outputsRef: {
      units: units.map((u) => {
        const memberKeys =
          u.candidate.R.memberKeys?.length
            ? u.candidate.R.memberKeys
            : [u.candidate.R.key]
        return {
          kind: u.kind,
          label: u.label,
          unitKey: u.candidate.R.key,
          memberKeys,
        }
      }),
      candidateKeys: units.map((u) => u.candidate.R.key),
      roleNote: `${FANOUT_ROLE_NOTE.letter} · 运动脑/指令组袋`,
    },
    createdAt: Date.now(),
  }

  if (units.length === 0) {
    return {
      action,
      units: [],
      ok: false,
      error: '指令组袋为空（运动脑未提出有效袋）',
    }
  }

  return { action, units, ok: true }
}
