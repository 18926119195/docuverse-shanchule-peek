/**
 * queryKey 题族谱系：原问（根）↔ 深化子问。
 * 完全换问 = 新根（无父）；深化 = 子 qk 挂 parentQueryKey。
 */

export type QueryParentMap = Record<string, string>

/** 子 → 父；无父则自身为根 */
export function getQueryRoot(
  parentOf: QueryParentMap,
  queryKey: string,
): string {
  const seen = new Set<string>()
  let cur = queryKey.trim()
  while (cur && parentOf[cur] && !seen.has(cur)) {
    seen.add(cur)
    cur = parentOf[cur]!
  }
  return cur
}

/** 从近到远：直接父 → … → 根（不含自身） */
export function listQueryAncestors(
  parentOf: QueryParentMap,
  queryKey: string,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let cur = queryKey.trim()
  while (cur && parentOf[cur] && !seen.has(cur)) {
    seen.add(cur)
    const p = parentOf[cur]!
    out.push(p)
    cur = p
  }
  return out
}

/** 直接子问 */
export function listQueryChildren(
  parentOf: QueryParentMap,
  parentQueryKey: string,
): string[] {
  const p = parentQueryKey.trim()
  if (!p) return []
  return Object.entries(parentOf)
    .filter(([, parent]) => parent === p)
    .map(([child]) => child)
}

/** 根下整族（含根与所有后代） */
export function listQueryFamilyKeys(
  parentOf: QueryParentMap,
  queryKey: string,
): string[] {
  const root = getQueryRoot(parentOf, queryKey)
  const out: string[] = []
  const seen = new Set<string>()
  const stack = [root]
  while (stack.length) {
    const k = stack.pop()!
    if (seen.has(k)) continue
    seen.add(k)
    out.push(k)
    for (const c of listQueryChildren(parentOf, k)) stack.push(c)
  }
  return out
}

/** 自身 + 祖先（深化继承 prospect / path 用） */
export function listQuerySelfAndAncestors(
  parentOf: QueryParentMap,
  queryKey: string,
): string[] {
  const qk = queryKey.trim()
  if (!qk) return []
  return [qk, ...listQueryAncestors(parentOf, qk)]
}
