/**
 * MasterTable 型指针：briefKey↔bookKey、head、版本；供写信台 expand 查表。
 * briefKey = settle 实例门牌，不用于选契约。
 */

import {
  getDoorEntry,
  getKeyDecisionStore,
  type KeyDecisionEntry,
} from './keyDecisionState'

export function mapBookToHeadBrief(
  docId: string,
  bookKey: string,
): { briefKey: string; brief: string; entry: KeyDecisionEntry } | null {
  const entry = getDoorEntry(docId, bookKey)
  if (!entry?.briefKey || !entry.decisionBrief.trim()) return null
  return {
    briefKey: entry.briefKey,
    brief: entry.decisionBrief,
    entry,
  }
}

/** briefKey（settle 实例）→ 挂靠 bookKey */
export function mapBriefToBook(
  docId: string,
  briefKey: string,
): { bookKey: string; brief: string; entry: KeyDecisionEntry } | null {
  const store = getKeyDecisionStore(docId)
  for (const [bookKey, entry] of Object.entries(store.byKey)) {
    if (entry.briefKey === briefKey) {
      return { bookKey, brief: entry.decisionBrief, entry }
    }
    for (const h of entry.history) {
      if (h.briefKey === briefKey) {
        return { bookKey, brief: h.brief, entry }
      }
    }
  }
  return null
}

export function listBriefVersionsOnDoor(
  docId: string,
  bookKey: string,
): Array<{ briefKey: string; brief: string; isHead: boolean }> {
  const entry = getDoorEntry(docId, bookKey)
  if (!entry) return []
  const out: Array<{ briefKey: string; brief: string; isHead: boolean }> = []
  if (entry.briefKey && entry.decisionBrief.trim()) {
    out.push({
      briefKey: entry.briefKey,
      brief: entry.decisionBrief,
      isHead: true,
    })
  }
  for (let i = entry.history.length - 1; i >= 0; i--) {
    const h = entry.history[i]!
    out.push({
      briefKey: h.briefKey,
      brief: h.brief,
      isHead: false,
    })
  }
  return out
}

/** 门是否已有贴（peek 门况） */
export function doorHasBrief(docId: string, bookKey: string): boolean {
  return mapBookToHeadBrief(docId, bookKey) !== null
}

/** 本任务 MasterTable 是否已有任意 head brief（写信台确定性） */
export function docHasAnyBrief(docId: string): boolean {
  const store = getKeyDecisionStore(docId)
  for (const entry of Object.values(store.byKey)) {
    if (entry.briefKey && entry.decisionBrief.trim()) return true
  }
  return false
}

/** 本任务全部已 settle 的 brief（含 history；一槽一 briefKey，不丢同门多贴） */
export function listAllSettledBriefs(docId: string): Array<{
  bookKey: string
  briefKey: string
  brief: string
  isHead: boolean
}> {
  const store = getKeyDecisionStore(docId)
  const out: Array<{
    bookKey: string
    briefKey: string
    brief: string
    isHead: boolean
  }> = []
  for (const [bookKey] of Object.entries(store.byKey)) {
    for (const v of listBriefVersionsOnDoor(docId, bookKey)) {
      out.push({
        bookKey,
        briefKey: v.briefKey,
        brief: v.brief,
        isHead: v.isHead,
      })
    }
  }
  return out
}

/** 本任务全部 head brief（压滚材料）；同门多贴请用 listAllSettledBriefs */
export function listAllHeadBriefs(docId: string): Array<{
  bookKey: string
  briefKey: string
  brief: string
}> {
  return listAllSettledBriefs(docId)
    .filter((r) => r.isHead)
    .map(({ bookKey, briefKey, brief }) => ({ bookKey, briefKey, brief }))
}
