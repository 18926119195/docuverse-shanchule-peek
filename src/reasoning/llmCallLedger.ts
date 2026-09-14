/**
 * 一次 LLM 调用的落账批（进度边 / 集合面板主键 = llmCallId）。
 */

import type { AttentionKeyKind } from '../arch/attentionPanel'
import type { SettleJob } from '../arch/settleMint'

export type LlmCallJob = SettleJob | 'path'

export type LlmCallLedgerEntry = {
  llmCallId: string
  job: LlmCallJob
  /** 本批 out 的种类（集合面板住哪层壳） */
  keyKind: AttentionKeyKind
  memberKeys: string[]
  queryKey: string
  createdAt: number
  /** 本问内调用序（单调） */
  turnSeq: number
}

export function jobToOutKeyKind(job: LlmCallJob): AttentionKeyKind {
  switch (job) {
    case 'peek':
      return 'brief'
    case 'decide':
      return 'prospect'
    case 'infer':
      return 'infer'
    case 'query':
    case 'neighbour':
      return 'neighbour'
    case 'reuse':
      return 'reuse'
    case 'path':
      return 'path'
    case 'supervise':
      return 'norm'
    default:
      return 'other'
  }
}
