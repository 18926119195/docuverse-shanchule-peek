/** Formal path / gateway-ops shared contracts (client + validator). */

export type FormalOpKind =
  | 'attend'
  | 'infer'
  | 'combine'
  | 'contrast'
  | 'conclude'
  | 'defer'

export interface FormalOp {
  op: FormalOpKind
  keys: string[]
  /** How this step uses the keys (procedure). */
  note: string
  /**
   * Intermediate claim produced by this step (required for derivation).
   * Chain of claims should lead to formalConclusion.
   */
  claim: string
}

export interface FormalPathV1 {
  schemaVersion: 'formalPath.v1'
  usedKeys: string[]
  ops: FormalOp[]
  formalConclusion: string
  path?: string
  skipOriginalNextTime?: boolean
  rationale?: string
}

export interface AbBlock {
  key: string
  text: string
  page?: number
  shortHandle?: string
}

export interface AbCompareInput {
  question: string
  blocks: AbBlock[]
  /** Optional fixture id for logs */
  fixtureId?: string
  unitLabel?: string
}

export const FORMAL_OP_KINDS: readonly FormalOpKind[] = [
  'attend',
  'infer',
  'combine',
  'contrast',
  'conclude',
  'defer',
] as const

export function allowedKeysOf(blocks: AbBlock[]): Set<string> {
  return new Set(blocks.map((b) => b.key).filter(Boolean))
}

export function isFormalOpKind(v: unknown): v is FormalOpKind {
  return (
    typeof v === 'string' &&
    (FORMAL_OP_KINDS as readonly string[]).includes(v)
  )
}

/** Shared prompt fragment: derivation-first ops contract. */
export function formalOpsJsonContractHint(): string {
  return [
    'ops 是有序推导步骤（越细越好）。每项必须含：',
    '{ "op": "attend|infer|combine|contrast|conclude|defer",',
    '  "keys": string[]（AllowedKeys 完整串）,',
    '  "note": string（本步如何处理这些木块）,',
    '  "claim": string（本步得出的中间主张；conclude 的 claim 须对齐最终结论）}',
    '',
    '语义：',
    '- attend：从 keys 读出可核对的事实/表述（claim=读出的要点）',
    '- infer：由本步 keys（及已有主张）推出新中间主张（重点：为何能推出）',
    '- combine：并置多块共同支撑同一中间主张',
    '- contrast：对照多块，claim 写清张力/同异如何影响下一步',
    '- conclude：汇总如何接到最终结论',
    '- defer：依据不足；claim 写清不能推出什么',
    '',
    '硬要求：',
    '- 禁止「只 attend 完全部块然后直接 conclude」；中间至少要有 infer/combine/contrast 说明推导',
    '- claim 必须具体，不能空、不能只写「见上」',
    '- 禁止发明/截断 key；勿编造袋外事实',
  ].join('\n')
}
