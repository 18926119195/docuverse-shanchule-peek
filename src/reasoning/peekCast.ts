/**
 * Peek cast — single-key In/Out + V0–V4 posterior (handbook peek / G*).
 * Motion LLM writes brief; gateway validates R⊆D and key pairing.
 */

import type { BookIndex } from './pipelineA'
import { atomSearchText } from './hybridRetrieve'
import {
  briefContentHash,
  rollDoorBrief,
  type KeyDecisionEntry,
  type SuggestAction,
} from './keyDecisionState'
import {
  combineGates,
  gateFaultInApproved,
  gatePeekSingleKey,
  gateReturnSubset,
  type GateFail,
} from './hardGates'
import type { ActionRecord } from './types'
import { FANOUT_ROLE_NOTE } from './fanoutRoles'

function newActionId(kind: string): string {
  return `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export type PeekVerdict =
  | 'V0_ok'
  | 'V1_key_mismatch'
  | 'V2_empty_brief'
  | 'V3_return_not_subset'
  | 'V4_unapproved'

export interface PeekIn {
  key: string
  /** Short T window already faulted-in (or gateway will load) */
  textWindow?: string
  approvedKeys: ReadonlyArray<string>
  question?: string
  taskId?: string
}

export interface PeekOut {
  key: string
  decisionBrief: string
  suggestAction: SuggestAction
  textPreview?: string
  /** Optional: model claims a different key — hard fail if ≠ In.key */
  claimedKey?: string
}

export interface PeekCastResult {
  ok: boolean
  verdict: PeekVerdict
  action: ActionRecord
  entry?: KeyDecisionEntry
  fails: GateFail[]
  warnings: string[]
}

const BRIEF_MAX = 280

function heuristicBrief(text: string, question?: string): {
  brief: string
  suggestAction: SuggestAction
} {
  const t = text.replace(/\s+/g, ' ').trim()
  const head = t.slice(0, BRIEF_MAX)
  const q = (question ?? '').trim()
  let suggestAction: SuggestAction = 'open'
  if (q && head) {
    const qt = q.slice(0, 24)
    if (!head.includes(qt.slice(0, 4)) && head.length < 40) {
      suggestAction = 'need_more_peek'
    }
  }
  if (!head) {
    return { brief: '', suggestAction: 'defer' }
  }
  return {
    brief: `【窥视】${head}${t.length > BRIEF_MAX ? '…' : ''}`,
    suggestAction,
  }
}

/**
 * Deliver one key's T window, produce brief, validate V0–V4, roll State.
 * V0: ok; V1: key'≠key*; V2: empty brief; V3: R⊈D; V4: unapproved.
 */
export function executePeekCast(input: {
  docId: string
  bookIndex: BookIndex
  peekIn: PeekIn
  /** Optional LLM/out-of-band Out; else heuristic from T */
  peekOut?: Partial<PeekOut>
}): PeekCastResult {
  const { peekIn } = input
  const delivered = [peekIn.key]
  const warnings: string[] = []

  const gApprove = gateFaultInApproved(delivered, peekIn.approvedKeys)
  if (!gApprove.ok) {
    return {
      ok: false,
      verdict: 'V4_unapproved',
      fails: gApprove.fails,
      warnings,
      action: makeAction(peekIn, null, 'V4_unapproved', gApprove.fails),
    }
  }

  const gSingle = gatePeekSingleKey(delivered)
  if (!gSingle.ok) {
    return {
      ok: false,
      verdict: 'V4_unapproved',
      fails: gSingle.fails,
      warnings,
      action: makeAction(peekIn, null, 'V1_key_mismatch', gSingle.fails),
    }
  }

  const chunk = input.bookIndex.chunks.find((c) => c.key === peekIn.key)
  const textWindow =
    peekIn.textWindow?.trim() ||
    (chunk ? atomSearchText(chunk).slice(0, 600) : '')

  const heur = heuristicBrief(textWindow, peekIn.question)
  const outKey = input.peekOut?.claimedKey ?? input.peekOut?.key ?? peekIn.key
  const brief = (input.peekOut?.decisionBrief ?? heur.brief).trim()
  const suggestAction =
    input.peekOut?.suggestAction ?? heur.suggestAction

  const returnedKeys = [outKey]
  const gReturn = gateReturnSubset(delivered, returnedKeys)

  if (outKey !== peekIn.key) {
    return {
      ok: false,
      verdict: 'V1_key_mismatch',
      fails: [
        {
          code: 'G4_PEEK_SINGLE_KEY',
          message: `key'≠key* · ${outKey} ≠ ${peekIn.key}`,
          detail: { in: peekIn.key, out: outKey },
        },
      ],
      warnings,
      action: makeAction(peekIn, null, 'V1_key_mismatch', [
        {
          code: 'G4_PEEK_SINGLE_KEY',
          message: `key'≠key*`,
        },
      ]),
    }
  }

  if (!brief) {
    return {
      ok: false,
      verdict: 'V2_empty_brief',
      fails: [
        {
          code: 'G5_SCHEMA',
          message: '铸贴 brief 为空',
        },
      ],
      warnings,
      action: makeAction(peekIn, null, 'V2_empty_brief', [
        { code: 'G5_SCHEMA', message: 'empty brief' },
      ]),
    }
  }

  if (!gReturn.ok) {
    return {
      ok: false,
      verdict: 'V3_return_not_subset',
      fails: gReturn.fails,
      warnings,
      action: makeAction(peekIn, null, 'V3_return_not_subset', gReturn.fails),
    }
  }

  if (gReturn.dropped && gReturn.dropped.length > 0) {
    warnings.push(`黄灯·丢弃非递交 key: ${gReturn.dropped.join(',')}`)
  }

  const peekFamilyId =
    peekIn.taskId?.trim() ||
    `peekcast_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const rolled = rollDoorBrief({
    docId: input.docId,
    key: peekIn.key,
    decisionBrief: brief,
    suggestAction,
    peekFamilyId,
    taskId: peekFamilyId,
    hangMode: 'sibling',
    actionId: newActionId('peek'),
  })
  if (!rolled.ok) {
    return {
      ok: false,
      verdict: 'V4_unapproved',
      fails: [
        {
          code: 'G5_SCHEMA',
          message: rolled.note,
        },
      ],
      warnings,
      action: makeAction(peekIn, null, 'V4_unapproved', [
        { code: 'G5_SCHEMA', message: rolled.note },
      ]),
    }
  }
  const entry = rolled.entry

  const action = makeAction(
    peekIn,
    {
      key: peekIn.key,
      decisionBrief: brief,
      suggestAction,
      briefKey: entry.briefKey,
      textPreview: textWindow.slice(0, 120),
    },
    'V0_ok',
    [],
  )

  return {
    ok: true,
    verdict: 'V0_ok',
    action,
    entry,
    fails: [],
    warnings,
  }
}

function makeAction(
  peekIn: PeekIn,
  out: {
    key: string
    decisionBrief: string
    suggestAction: SuggestAction
    briefKey: string
    textPreview?: string
  } | null,
  verdict: PeekVerdict,
  fails: GateFail[],
): ActionRecord {
  return {
    actionId: newActionId('peek'),
    actionKind: 'peek',
    premiseKeys: [peekIn.key],
    inputsRef: {
      key: peekIn.key,
      role: 'peek',
      approvedKeys: [...peekIn.approvedKeys],
    },
    outputsRef: {
      verdict,
      fails,
      decisionBrief: out?.decisionBrief,
      suggestAction: out?.suggestAction,
      briefKey: out?.briefKey,
      briefContentHash: out?.briefKey,
      briefRef: out?.briefKey,
      roleNote: `${FANOUT_ROLE_NOTE.letter} · peek ${verdict}`,
      candidateKeys: out ? [out.key] : [],
    },
    createdAt: Date.now(),
  }
}

/** Parallel single-key peeks (default product path). */
export function executePeekCastParallel(input: {
  docId: string
  bookIndex: BookIndex
  keys: ReadonlyArray<string>
  approvedKeys: ReadonlyArray<string>
  question?: string
  taskId?: string
}): PeekCastResult[] {
  return input.keys.map((key) =>
    executePeekCast({
      docId: input.docId,
      bookIndex: input.bookIndex,
      peekIn: {
        key,
        approvedKeys: input.approvedKeys,
        question: input.question,
        taskId: input.taskId,
      },
    }),
  )
}

export { briefContentHash, combineGates }
