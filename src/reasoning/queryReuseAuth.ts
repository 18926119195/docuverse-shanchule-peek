/**
 * query 硬闸 → 是否授权 reuse。
 * 原则：先 query；只有明确可整段复用才开 reuse LLM；中高/半边只喂材料、不烧复用闸。
 * 微小启发式以后再加；本文件只做硬规则。
 */

export type QueryNeighbourAuthInput = {
  degree?: string
  /** queryLLM 显式字段；缺省则靠 degree 硬词 */
  reuseEligible?: boolean | null
}

const ALLOW_RE =
  /极高|完整复用|可直接复用|可整段复用|同问深化|几乎同问|同问同解|reuseEligible\s*[:=]\s*true/i

const DENY_RE =
  /仅覆盖|仅一侧|半边|半覆盖|一侧|只撑|不完整|不可复用|reuseEligible\s*[:=]\s*false/i

/**
 * 单条 neighbour 是否授权进入 reuse 闸。
 * - 显式 reuseEligible=true → 过（除非 degree 同时写死半边否认）
 * - 显式 reuseEligible=false → 不过
 * - 无显式：degree 须命中「极高/同问/可完整复用」类硬词，且无半边否认词
 * - 默认不过（中高、空串、模糊相关 ≠ 授权）
 */
export function neighbourAuthorizesReuse(
  input: QueryNeighbourAuthInput,
): boolean {
  const degree = (input.degree ?? '').trim()
  if (input.reuseEligible === false) return false
  if (DENY_RE.test(degree)) return false
  if (input.reuseEligible === true) return true
  if (!degree) return false
  return ALLOW_RE.test(degree)
}

/** 邻域行里至少一条授权 → 才开 reuse LLM */
export function queryAuthorizesReuse(
  rows: QueryNeighbourAuthInput[],
): boolean {
  return rows.some((r) => neighbourAuthorizesReuse(r))
}

/** 授权复用的历史问键（已是全长 qk） */
export function reuseAuthorizedHistoricKeys(
  rows: Array<{ queryKey: string } & QueryNeighbourAuthInput>,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const qk = r.queryKey.trim()
    if (!qk || seen.has(qk)) continue
    if (!neighbourAuthorizesReuse(r)) continue
    seen.add(qk)
    out.push(qk)
  }
  return out
}
