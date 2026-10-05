/**
 * reuse 失败后：只剔除 path 实际用过的 brief，保留同门其余 brief。
 * 回溯：path → prospect.briefKey（必剔）+ infer.bookKeys 上「该 prospect 对应的那一贴」；
 * 同 bookKey 门上其他 briefKey 一律保留。
 */

import type {
  InferEdge,
  PathRecord,
  ProspectRecord,
} from '../reasoning/attentionIoStore'
import { listBriefVersionsOnDoor, mapBriefToBook } from '../reasoning/masterTableMap'

export function briefKeysUsedByPath(input: {
  docId: string
  path: PathRecord
  prospects: ProspectRecord[]
  inferEdges: InferEdge[]
}): string[] {
  const used = new Set<string>()
  const prospectKeys = [
    ...(input.path.prospectKeys ?? []),
    ...(input.path.prospectKey ? [input.path.prospectKey] : []),
  ].filter(Boolean)
  const inferKeys = [
    ...(input.path.inferKeys ?? []),
    ...(input.path.inferKey ? [input.path.inferKey] : []),
  ].filter(Boolean)

  for (const pk of prospectKeys) {
    const prospect = input.prospects.find((p) => p.prospectKey === pk)
    if (prospect?.briefKey) used.add(prospect.briefKey)
  }

  for (const ik of inferKeys) {
    const edge = input.inferEdges.find((e) => e.inferKey === ik)
    if (!edge) continue
    for (const pk of prospectKeys) {
      const prospect = input.prospects.find((p) => p.prospectKey === pk)
      if (!prospect?.briefKey) continue
      for (const bookKey of edge.bookKeys) {
        const hit = mapBriefToBook(input.docId, prospect.briefKey)
        if (hit?.bookKey === bookKey) {
          used.add(prospect.briefKey)
          void listBriefVersionsOnDoor(input.docId, bookKey)
        }
      }
    }
  }
  return [...used]
}

/** 多条失败 path → 并集（仍只含 path 用过的 brief） */
export function briefKeysUsedByPaths(input: {
  docId: string
  paths: PathRecord[]
  prospects: ProspectRecord[]
  inferEdges: InferEdge[]
}): string[] {
  const used = new Set<string>()
  for (const path of input.paths) {
    for (const bk of briefKeysUsedByPath({ ...input, path })) {
      used.add(bk)
    }
  }
  return [...used]
}
