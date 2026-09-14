/**
 * Hard gates G* — letter desk / gateway collection checks (handbook §0.11).
 * Supervision LLM must NOT do set membership; these rules do.
 */

export type GateCode =
  | 'G1_BAG_SUBSET'
  | 'G2_RETURN_SUBSET'
  | 'G3_FAULTIN_APPROVED'
  | 'G4_PEEK_SINGLE_KEY'
  | 'G5_SCHEMA'
  | 'G6_BRIEF_REF'

export interface GateFail {
  code: GateCode
  message: string
  detail?: Record<string, unknown>
}

export interface GateOk {
  ok: true
}

export interface GateErr {
  ok: false
  fails: GateFail[]
}

export type GateResult = GateOk | GateErr

function fail(code: GateCode, message: string, detail?: Record<string, unknown>): GateErr {
  return { ok: false, fails: [{ code, message, detail }] }
}

/** G1: memberKeys ⊆ draftKeys ∪ scopedKeys */
export function gateBagSubset(
  memberKeys: ReadonlyArray<string>,
  draftKeys: ReadonlyArray<string>,
  scopedKeys: ReadonlyArray<string> = [],
): GateResult {
  const allow = new Set([...draftKeys, ...scopedKeys])
  const bad = memberKeys.filter((k) => !allow.has(k))
  if (bad.length > 0) {
    return fail('G1_BAG_SUBSET', `袋内假门牌: ${bad.slice(0, 4).join(', ')}`, {
      bad,
    })
  }
  return { ok: true }
}

/** G2: returned keys ⊆ delivered keys (R ⊆ D) */
export function gateReturnSubset(
  deliveredKeys: ReadonlyArray<string>,
  returnedKeys: ReadonlyArray<string>,
): GateResult & {
  dropped?: string[]
  accepted?: string[]
  missing?: string[]
} {
  const D = new Set(deliveredKeys)
  const R = [...new Set(returnedKeys)]
  const dropped = R.filter((k) => !D.has(k))
  const accepted = R.filter((k) => D.has(k))
  const missing = deliveredKeys.filter((k) => !R.includes(k))
  if (dropped.length > 0 && accepted.length === 0) {
    return {
      ok: false,
      fails: [
        {
          code: 'G2_RETURN_SUBSET',
          message: `返回 key 均不在递交集: ${dropped.slice(0, 4).join(', ')}`,
          detail: { dropped, delivered: [...D] },
        },
      ],
      dropped,
      accepted,
      missing,
    }
  }
  return { ok: true, dropped, accepted, missing }
}

/** G3: faultIn/peek keys ∈ approved list */
export function gateFaultInApproved(
  keys: ReadonlyArray<string>,
  approved: ReadonlyArray<string>,
): GateResult {
  const allow = new Set(approved)
  const bad = keys.filter((k) => !allow.has(k))
  if (bad.length > 0) {
    return fail('G3_FAULTIN_APPROVED', `未批准开 T: ${bad.slice(0, 4).join(', ')}`, {
      bad,
    })
  }
  return { ok: true }
}

/** G4: default peek writes one key at a time (|D|=1) */
export function gatePeekSingleKey(deliveredKeys: ReadonlyArray<string>): GateResult {
  if (deliveredKeys.length !== 1) {
    return fail(
      'G4_PEEK_SINGLE_KEY',
      `铸贴默认单键，收到 ${deliveredKeys.length} 个`,
      { deliveredKeys: [...deliveredKeys] },
    )
  }
  return { ok: true }
}

/** G6: briefRef must equal current briefKey when citing a door tip */
export function gateBriefRef(
  briefRef: string | undefined,
  briefKey: string | undefined,
): GateResult {
  if (!briefKey) return { ok: true }
  if (!briefRef) {
    return fail('G6_BRIEF_REF', '有门贴时须带 briefRef')
  }
  if (briefRef !== briefKey) {
    return fail('G6_BRIEF_REF', 'briefRef 与当前 briefKey 不一致', {
      briefRef,
      briefKey,
    })
  }
  return { ok: true }
}

export function combineGates(...results: GateResult[]): GateResult {
  const fails: GateFail[] = []
  for (const r of results) {
    if (!r.ok) fails.push(...r.fails)
  }
  return fails.length ? { ok: false, fails } : { ok: true }
}
