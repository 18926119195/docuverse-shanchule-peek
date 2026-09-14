/**
 * KeyDecisionState — door-level briefs (小抄) keyed by A1 bookKey.
 * Handbook: brief is task fill on the door; NOT written into BookIndex.
 *
 * briefKey = 写信台 peek 落账微动作铸键（方案 B）。
 * contentFingerprint = 正文副索引，不当门牌。
 *
 * 同门多贴：仅同 peekFamilyId（同一次 peek LLM 母族）可并挂；
 * 跨 peek 禁止乱挂 sibling；热启修贴走 hangMode:'revise'。
 */

import {
  contentFingerprint,
  newSettleActionId,
  mintInstanceKey,
} from './settleMint'

export type SuggestAction = 'open' | 'defer' | 'reuse' | 'need_more_peek'

/** sibling=同母族加贴；revise=跨族显式修贴（换 head）；默认按族闸 */
export type PeekHangMode = 'sibling' | 'revise'

export interface BriefVersion {
  brief: string
  suggestAction: SuggestAction
  /** 该版 brief 的实例门牌（settle） */
  briefKey: string
  /** 正文副索引 */
  contentFingerprint?: string
  actionId?: string
  settleActionId?: string
  /** 同一次 peek 母族 id（与 KeyDecisionEntry.peekFamilyId 同义） */
  taskId?: string
  peekFamilyId?: string
  at: number
  excerptPreviewHash?: string
}

export interface KeyDecisionEntry {
  key: string
  /** Hot tip for next open-door decision (rolled) */
  decisionBrief: string
  suggestAction: SuggestAction
  /** brief 实例门牌（方案 B settle） */
  briefKey: string
  /** 正文副索引（fp_*）；仅「像不像」，不当可调取门牌 */
  contentFingerprint: string
  settleActionId: string
  updatedAt: number
  lastActionId?: string
  lastTaskId?: string
  /** 当前 head 所属 peek 母族（同一次 peek LLM） */
  peekFamilyId?: string
  /** Append-only audit (not default WM input) */
  history: BriefVersion[]
}

export interface KeyDecisionStore {
  docId: string
  byKey: Record<string, KeyDecisionEntry>
  updatedAt: number
}

export type RollDoorBriefResult =
  | {
      ok: true
      entry: KeyDecisionEntry
      hung: 'fresh' | 'sibling' | 'revise'
    }
  | {
      ok: false
      reason: 'cross_peek_blocked' | 'duplicate_brief'
      entry: KeyDecisionEntry | null
      note: string
    }

const storeByDoc = new Map<string, KeyDecisionStore>()

/**
 * @deprecated 名称易误解。现为正文副索引 fp_*。
 * 新代码请用 contentFingerprint；门牌请用 entry.briefKey。
 */
export function briefContentHash(
  brief: string,
  suggestAction: SuggestAction,
): string {
  return contentFingerprint(`${suggestAction}\0${brief.trim()}`)
}

export function emptyKeyDecisionStore(docId: string): KeyDecisionStore {
  return { docId, byKey: {}, updatedAt: Date.now() }
}

export function getKeyDecisionStore(docId: string): KeyDecisionStore {
  let s = storeByDoc.get(docId)
  if (!s) {
    s = emptyKeyDecisionStore(docId)
    storeByDoc.set(docId, s)
  }
  return s
}

export function saveKeyDecisionStore(store: KeyDecisionStore): void {
  store.updatedAt = Date.now()
  storeByDoc.set(store.docId, store)
}

export function getDoorEntry(
  docId: string,
  key: string,
): KeyDecisionEntry | null {
  return getKeyDecisionStore(docId).byKey[key] ?? null
}

function familyOfVersion(v: {
  peekFamilyId?: string
  taskId?: string
}): string | null {
  const id = (v.peekFamilyId ?? v.taskId ?? '').trim()
  return id || null
}

/** 门上已出现过的 peek 母族（head + history） */
export function doorPeekFamilies(entry: KeyDecisionEntry): Set<string> {
  const out = new Set<string>()
  const head = familyOfVersion({
    peekFamilyId: entry.peekFamilyId,
    taskId: entry.lastTaskId,
  })
  if (head) out.add(head)
  for (const h of entry.history) {
    const id = familyOfVersion(h)
    if (id) out.add(id)
  }
  return out
}

function doorHasSameBrief(
  entry: KeyDecisionEntry,
  brief: string,
  suggestAction: SuggestAction,
): boolean {
  const fp = contentFingerprint(`${suggestAction}\0${brief.trim()}`)
  if (entry.contentFingerprint === fp || entry.decisionBrief.trim() === brief.trim()) {
    return true
  }
  return entry.history.some(
    (h) =>
      h.contentFingerprint === fp || h.brief.trim() === brief.trim(),
  )
}

/**
 * 落账门贴。
 * - 处女门 → fresh
 * - 同 peekFamilyId → sibling（同门多贴）
 * - 异族 + revise → 修贴换 head
 * - 异族 + sibling → 拒绝（禁跨 peek 乱挂）
 */
export function rollDoorBrief(input: {
  docId: string
  key: string
  decisionBrief: string
  suggestAction: SuggestAction
  actionId?: string
  /** @deprecated 用 peekFamilyId；仍写入 lastTaskId 兼容 */
  taskId?: string
  /** 同一次 peek LLM 母族；缺省回退 taskId */
  peekFamilyId?: string
  hangMode?: PeekHangMode
  excerptPreviewHash?: string
  maxHistory?: number
  /** 若调用方已有 settle，可传入；否则台内现铸 */
  settleActionId?: string
}): RollDoorBriefResult {
  const store = getKeyDecisionStore(input.docId)
  const prev = store.byKey[input.key]
  const peekFamilyId = (
    input.peekFamilyId ??
    input.taskId ??
    ''
  ).trim()
  const hangMode: PeekHangMode = input.hangMode ?? 'sibling'
  const briefText = input.decisionBrief.trim()

  if (prev && prev.decisionBrief.trim()) {
    if (doorHasSameBrief(prev, briefText, input.suggestAction)) {
      return {
        ok: false,
        reason: 'duplicate_brief',
        entry: prev,
        note: `同门已有相同 brief · 跳过 · ${input.key.slice(0, 28)}`,
      }
    }
    const families = doorPeekFamilies(prev)
    const sameFamily =
      Boolean(peekFamilyId) && families.has(peekFamilyId)
    // 无族标记的旧贴也当异族：禁止 sibling 乱挂，只许 revise 修贴
    if (!sameFamily && hangMode !== 'revise') {
      return {
        ok: false,
        reason: 'cross_peek_blocked',
        entry: prev,
        note: `跨 peek 禁乱挂 · 门已有异族贴 · ${input.key.slice(0, 28)}`,
      }
    }
  }

  const settleActionId =
    input.settleActionId ||
    input.actionId ||
    newSettleActionId('peek')
  const briefKey = mintInstanceKey('brief', settleActionId)
  const fingerprint = contentFingerprint(
    `${input.suggestAction}\0${briefText}`,
  )
  const now = Date.now()
  const history = [...(prev?.history ?? [])]
  if (prev && prev.decisionBrief.trim()) {
    history.push({
      brief: prev.decisionBrief,
      suggestAction: prev.suggestAction,
      briefKey: prev.briefKey,
      contentFingerprint: prev.contentFingerprint,
      actionId: prev.lastActionId,
      settleActionId: prev.settleActionId,
      taskId: prev.lastTaskId,
      peekFamilyId: prev.peekFamilyId ?? prev.lastTaskId,
      at: prev.updatedAt,
    })
  }
  const maxH = input.maxHistory ?? 12
  const trimmed = history.slice(-maxH)

  let hung: 'fresh' | 'sibling' | 'revise' = 'fresh'
  if (prev && prev.decisionBrief.trim()) {
    const families = doorPeekFamilies(prev)
    const sameFamily =
      Boolean(peekFamilyId) && families.has(peekFamilyId)
    hung = sameFamily ? 'sibling' : 'revise'
  }

  const entry: KeyDecisionEntry = {
    key: input.key,
    decisionBrief: briefText,
    suggestAction: input.suggestAction,
    briefKey,
    contentFingerprint: fingerprint,
    settleActionId,
    updatedAt: now,
    lastActionId: input.actionId ?? settleActionId,
    lastTaskId: peekFamilyId || input.taskId,
    peekFamilyId: peekFamilyId || undefined,
    history: trimmed,
  }
  store.byKey[input.key] = entry
  saveKeyDecisionStore(store)
  return { ok: true, entry, hung }
}

export function doorsForKeys(
  docId: string,
  keys: ReadonlyArray<string>,
): KeyDecisionEntry[] {
  const store = getKeyDecisionStore(docId)
  return keys
    .map((k) => store.byKey[k])
    .filter((e): e is KeyDecisionEntry => Boolean(e))
}
