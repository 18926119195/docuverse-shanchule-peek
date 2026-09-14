import { create } from 'zustand'
import { classifyIntervalRelation } from './intrinsicKey'
import { shortHandle } from './ocrSlot'
import type { CircleCandidate } from './pipelineA'
import {
  protocolClosureEnsure,
  protocolClosureMatch,
  protocolClosureRemember,
  protocolClosureReuse,
} from './protocolClient'
import type {
  DialogueClosure,
  DirectionRecord,
  InstructionBundle,
  IntrinsicCoordinate,
  LinkType,
  LockBox,
  ReasonEdge,
} from './types'

/** v5: closures carry memberKeys (slot arrangement) */
const STORAGE_PREFIX = 'docuverse.reasoning.v5:'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isPlaceFaces(v: unknown): boolean {
  if (!isRecord(v)) return false
  let ok = false
  if (v.text !== undefined) {
    if (
      !isRecord(v.text) ||
      typeof v.text.start !== 'number' ||
      typeof v.text.end !== 'number' ||
      typeof v.text.content !== 'string'
    ) {
      return false
    }
    ok = true
  }
  if (v.fig !== undefined) {
    if (
      !isRecord(v.fig) ||
      typeof v.fig.figId !== 'string' ||
      typeof v.fig.note !== 'string'
    ) {
      return false
    }
    if (
      v.fig.imageRef !== undefined &&
      typeof v.fig.imageRef !== 'string'
    ) {
      return false
    }
    ok = true
  }
  return ok
}

function isR(v: unknown): v is IntrinsicCoordinate {
  if (!isRecord(v)) return false
  const sourceOk =
    v.source === 'ocr' ||
    v.source === 'pdf_text' ||
    v.source === 'page_text' ||
    v.source === 'layout_fig'
  if (
    typeof v.docId !== 'string' ||
    typeof v.start !== 'number' ||
    typeof v.end !== 'number' ||
    typeof v.key !== 'string' ||
    typeof v.page !== 'number' ||
    typeof v.emphasisId !== 'string' ||
    !Array.isArray(v.chunkIds) ||
    !sourceOk ||
    !isPlaceFaces(v.faces)
  ) {
    return false
  }
  if (v.kind === 'fig') return typeof v.figId === 'string'
  if (v.kind === 'text') return true
  return false
}

function isClosure(v: unknown): v is DialogueClosure {
  if (!isRecord(v)) return false
  if (
    typeof v.key !== 'string' ||
    !isR(v.R) ||
    typeof v.excerpt !== 'string' ||
    !Array.isArray(v.directions) ||
    typeof v.createdAt !== 'number' ||
    typeof v.updatedAt !== 'number'
  ) {
    return false
  }
  // memberKeys optional on disk → normalize later
  return true
}

function normalizeClosure(raw: {
  key: string
  R: IntrinsicCoordinate
  excerpt: string
  directions: DirectionRecord[]
  createdAt: number
  updatedAt: number
  memberKeys?: string[]
}): DialogueClosure {
  const memberKeys =
    Array.isArray(raw.memberKeys) && raw.memberKeys.length > 0
      ? raw.memberKeys.filter((k) => typeof k === 'string')
      : raw.R.memberKeys && raw.R.memberKeys.length > 0
        ? raw.R.memberKeys
        : [raw.key]
  return { ...raw, memberKeys }
}

function loadMap(corpus: string): Record<string, DialogueClosure> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + corpus)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return {}
    const out: Record<string, DialogueClosure> = {}
    for (const [k, val] of Object.entries(parsed)) {
      if (isClosure(val)) out[k] = normalizeClosure(val)
    }
    return out
  } catch {
    return {}
  }
}

function saveMap(corpus: string, map: Record<string, DialogueClosure>): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + corpus, JSON.stringify(map))
  } catch {
    /* quota */
  }
}

export type PilotPhase =
  | 'idle'
  | 'in_closure'
  | 'await_decision'
  | 'leave_pick_target'
  | 'busy'

export interface MatchHit {
  direction: DirectionRecord
  score: number
}

interface ReasoningState {
  corpus: string
  closures: Record<string, DialogueClosure>
  activeR: IntrinsicCoordinate | null
  activeKey: string | null
  activeExcerpt: string
  lockBoxes: LockBox[]
  lockCandidates: CircleCandidate[]
  lockError: string | null
  phase: PilotPhase
  lastMatches: MatchHit[]
  pendingQuestion: string
  /** directions to forbid when staying & inferring */
  forbidIds: string[]
  leaveFromKey: string | null
  pendingEdge: ReasonEdge | null
  lastBundle: InstructionBundle | null
  lastLog: string[]
  lastConclusion: string | null
  lastPath: string | null
  error: string | null
  /**
   * Set when user adds a direction to the forbid list from the audit dock —
   * Pilot should run 留房推理 once (does not clear closures / storage).
   */
  pendingInferStay: boolean

  setCorpus: (corpus: string) => void
  activateResolved: (input: {
    chosen: CircleCandidate
    candidates: CircleCandidate[]
  }) => void
  setLockFailure: (message: string) => void
  pickCandidate: (key: string) => void
  clearActive: () => void
  ensureClosure: (R: IntrinsicCoordinate, excerpt: string) => DialogueClosure
  findClosuresBySlotKey: (slotKey: string) => DialogueClosure[]
  runLocalMatch: (question: string) => Promise<MatchHit[]>
  chooseReuse: (directionId: string) => Promise<void>
  hangVariantOn: (directionId: string, question: string) => void
  toggleForbid: (directionId: string) => void
  consumePendingInferStay: () => boolean
  previewLeaveCandidate: (chosen: CircleCandidate) => void
  beginLeave: () => void
  cancelLeave: () => void
  confirmLeaveToResolved: (
    chosen: CircleCandidate,
    linkType: LinkType,
  ) => void
  setPendingQuestion: (q: string) => void
  rememberInferResult: (input: {
    bundle: InstructionBundle
    question: string
    path: string
    conclusion: string
  }) => Promise<void>
  pushLog: (line: string) => void
  setError: (msg: string | null) => void
  setPhase: (p: PilotPhase) => void
  setLastBundle: (b: InstructionBundle | null) => void
}

export const useReasoning = create<ReasoningState>((set, get) => ({
  corpus: 'pdf',
  closures: loadMap('pdf'),
  activeR: null,
  activeKey: null,
  activeExcerpt: '',
  lockBoxes: [],
  lockCandidates: [],
  lockError: null,
  phase: 'idle',
  lastMatches: [],
  pendingQuestion: '',
  forbidIds: [],
  leaveFromKey: null,
  pendingEdge: null,
  lastBundle: null,
  lastLog: [],
  lastConclusion: null,
  lastPath: null,
  error: null,
  pendingInferStay: false,

  setCorpus: (corpus) => {
    set({
      corpus,
      closures: loadMap(corpus),
      activeR: null,
      activeKey: null,
      activeExcerpt: '',
      lockBoxes: [],
      lockCandidates: [],
      lockError: null,
      phase: 'idle',
      lastMatches: [],
      forbidIds: [],
      leaveFromKey: null,
      pendingEdge: null,
    })
  },

  pushLog: (line) =>
    set((s) => {
      const seq = (s.lastLog.length > 0 ? s.lastLog.length : 0) + Date.now()
      return {
        lastLog: [
          `${seq}-${s.lastLog.length}|${new Date().toLocaleTimeString()} ${line}`,
          ...s.lastLog,
        ].slice(0, 40),
      }
    }),

  setError: (msg) => set({ error: msg }),
  setPhase: (p) => set({ phase: p }),
  setLastBundle: (b) => set({ lastBundle: b }),
  setPendingQuestion: (q) => set({ pendingQuestion: q }),

  ensureClosure: (R, excerpt) => {
    const { corpus, closures } = get()
    const existing = closures[R.key]
    if (existing) {
      void protocolClosureEnsure({
        closures,
        key: R.key,
        excerpt: existing.excerpt,
        memberKeys: existing.memberKeys,
        R,
      }).catch(() => {
        /* local shell remains authoritative for UI */
      })
      return existing
    }
    const memberKeys =
      R.memberKeys && R.memberKeys.length > 0 ? R.memberKeys : [R.key]
    const created: DialogueClosure = {
      key: R.key,
      R,
      excerpt,
      memberKeys,
      directions: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const next = { ...closures, [R.key]: created }
    saveMap(corpus, next)
    set({ closures: next })
    void protocolClosureEnsure({
      closures: next,
      key: R.key,
      excerpt,
      memberKeys,
      R,
    }).catch(() => {
      /* keep local */
    })
    return created
  },

  /** 相似命中 slot 哈希后，精确查含该成员的历史对话闭包 */
  findClosuresBySlotKey: (slotKey: string): DialogueClosure[] => {
    const { closures } = get()
    return Object.values(closures).filter(
      (c) => c.key === slotKey || c.memberKeys.includes(slotKey),
    )
  },

  activateResolved: ({ chosen, candidates }) => {
    const cur = get()
    if (
      cur.phase !== 'leave_pick_target' &&
      cur.activeKey === chosen.R.key &&
      (cur.phase === 'in_closure' ||
        cur.phase === 'await_decision' ||
        cur.phase === 'busy')
    ) {
      set({
        activeR: chosen.R,
        activeExcerpt: chosen.excerpt,
        lockBoxes: chosen.boxes,
        lockCandidates: candidates,
        lockError: null,
      })
      return
    }
    get().ensureClosure(chosen.R, chosen.excerpt)
    const gray = candidates.length > 1
    set({
      activeR: chosen.R,
      activeKey: chosen.R.key,
      activeExcerpt: chosen.excerpt,
      lockBoxes: chosen.boxes,
      lockCandidates: candidates,
      lockError: null,
      phase: 'in_closure',
      lastMatches: [],
      forbidIds: [],
      leaveFromKey: null,
      pendingEdge: null,
      error: null,
    })
    get().pushLog(
      gray
        ? `进房 ${shortHandle(chosen.R.key)}（灰度 ${candidates.length} 候选，已选最高重叠）`
        : (() => {
            const tags = [
              chosen.R.faces.text ? '文字脸' : null,
              chosen.R.faces.fig ? '图脸' : null,
            ].filter(Boolean)
            return `进房 ${shortHandle(chosen.R.key)} · ${tags.join('+') || chosen.R.kind}`
          })(),
    )
  },

  setLockFailure: (message) => {
    set({
      activeR: null,
      activeKey: null,
      activeExcerpt: '',
      lockBoxes: [],
      lockCandidates: [],
      lockError: message,
      phase: 'idle',
      error: message,
    })
    get().pushLog(`未锁定 A 切片：${message}`)
  },

  pickCandidate: (key) => {
    const { lockCandidates, phase } = get()
    const hit = lockCandidates.find((c) => c.R.key === key)
    if (!hit) return
    if (phase === 'leave_pick_target') {
      set({
        activeExcerpt: hit.excerpt,
        lockBoxes: hit.boxes,
        error: null,
      })
      get().pushLog(`B1 候选切到 ${hit.R.key}`)
      return
    }
    get().activateResolved({ chosen: hit, candidates: lockCandidates })
  },

  clearActive: () =>
    set({
      activeR: null,
      activeKey: null,
      activeExcerpt: '',
      lockBoxes: [],
      lockCandidates: [],
      lockError: null,
      phase: 'idle',
      lastMatches: [],
      forbidIds: [],
      leaveFromKey: null,
      pendingEdge: null,
    }),

  runLocalMatch: async (question) => {
    const { activeKey, closures } = get()
    if (!activeKey) return []
    const c = closures[activeKey]
    if (!c) return []
    try {
      const { hits: scored } = await protocolClosureMatch({
        closures,
        key: activeKey,
        question,
      })
      const hits: MatchHit[] = scored
        .map((h) => {
          const direction = c.directions.find((d) => d.directionId === h.directionId)
          return direction ? { direction, score: h.score } : null
        })
        .filter((x): x is MatchHit => x !== null)
        .filter((h) => h.score >= 0.35)
        .slice(0, 5)
      set({
        pendingQuestion: question,
        lastMatches: hits,
        phase: 'await_decision',
        error: null,
      })
      get().pushLog(
        hits.length
          ? `房内命中 ${hits.length} 条方向（服务端 Top1=${hits[0].score.toFixed(2)}）`
          : '房内无近似方向 → 可直接推理或退房',
      )
      return hits
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ error: `闭包匹配失败：${msg}`, phase: 'in_closure' })
      get().pushLog(`闭包匹配失败：${msg}`)
      return []
    }
  },

  chooseReuse: async (directionId) => {
    const { activeKey, closures, pendingQuestion } = get()
    if (!activeKey) return
    try {
      const result = await protocolClosureReuse({
        closures,
        key: activeKey,
        directionId,
      })
      if (!result.reuse) {
        set({ error: '复用失败：方向不存在' })
        return
      }
      get().hangVariantOn(directionId, pendingQuestion)
      set({
        lastConclusion: result.conclusion,
        lastPath: result.path,
        phase: 'in_closure',
        lastMatches: [],
      })
      get().pushLog(`复用短路 · 未调用主模型 · ${directionId}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ error: `复用失败：${msg}` })
    }
  },

  hangVariantOn: (directionId, question) => {
    const { corpus, closures, activeKey } = get()
    if (!activeKey || !question.trim()) return
    const c = closures[activeKey]
    if (!c) return
    const directions = c.directions.map((d) => {
      if (d.directionId !== directionId) return d
      if (d.variants.includes(question) || d.questionText === question) return d
      return { ...d, variants: [...d.variants, question] }
    })
    const nextC = { ...c, directions, updatedAt: Date.now() }
    const next = { ...closures, [activeKey]: nextC }
    saveMap(corpus, next)
    set({ closures: next })
  },

  toggleForbid: (directionId) => {
    const { forbidIds } = get()
    const adding = !forbidIds.includes(directionId)
    set({
      forbidIds: adding
        ? [...forbidIds, directionId]
        : forbidIds.filter((id) => id !== directionId),
      // 加入排除 → 请求一次留房推理（带负面清单）；取消排除不触发
      pendingInferStay: adding ? true : get().pendingInferStay,
    })
    if (adding) {
      get().pushLog(`已排除方向 · 进入留房推理（带负面清单）· ${directionId}`)
    }
  },

  consumePendingInferStay: () => {
    if (!get().pendingInferStay) return false
    set({ pendingInferStay: false })
    return true
  },

  previewLeaveCandidate: (chosen) => {
    if (get().phase !== 'leave_pick_target') return
    set({
      activeExcerpt: chosen.excerpt,
      lockBoxes: chosen.boxes,
      error: null,
    })
    get().pushLog(`B1 预览再入对象 · ${chosen.R.key}`)
  },

  beginLeave: () => {
    const { activeKey } = get()
    if (!activeKey) return
    set({
      leaveFromKey: activeKey,
      phase: 'leave_pick_target',
      pendingEdge: null,
    })
    get().pushLog('退房：请再选另一强调区作为新分析对象')
  },

  cancelLeave: () => {
    set({ leaveFromKey: null, phase: 'in_closure', pendingEdge: null })
    get().pushLog('取消退房')
  },

  confirmLeaveToResolved: (chosen, linkType) => {
    const { leaveFromKey, closures } = get()
    if (!leaveFromKey) return
    const fromC = closures[leaveFromKey]
    if (!fromC) return
    const toR = chosen.R
    get().ensureClosure(toR, chosen.excerpt)
    const rel = classifyIntervalRelation(fromC.R, toR)
    if (rel.adjust === 'same') {
      set({ error: '对象未变：请改用「留房 + 排除旧方向」，而非退房' })
      return
    }
    const premise =
      linkType === 'none' || linkType === 'contrast' || linkType === 'explore'
        ? undefined
        : fromC.directions.length > 0
          ? {
              conclusion: fromC.directions[fromC.directions.length - 1].conclusion,
              pathSummary: fromC.directions[fromC.directions.length - 1].path,
              fromKey: leaveFromKey,
            }
          : undefined

    const edge: ReasonEdge = {
      fromKey: leaveFromKey,
      toKey: toR.key,
      relation: rel.relation,
      adjust: rel.adjust,
      linkType,
      premiseConclusion: premise?.conclusion,
      premisePath: premise?.pathSummary,
    }
    set({
      activeR: toR,
      activeKey: toR.key,
      activeExcerpt: chosen.excerpt,
      lockBoxes: chosen.boxes,
      lockCandidates: [chosen],
      phase: 'in_closure',
      leaveFromKey: null,
      pendingEdge: edge,
      lastMatches: [],
      forbidIds: [],
      error: null,
    })
    get().pushLog(
      `B1 再入 ${toR.key} · ${rel.relation}/${rel.adjust ?? '-'} · link=${linkType}`,
    )
  },

  rememberInferResult: async ({ bundle, question, path, conclusion }) => {
    const { corpus, closures, activeKey } = get()
    if (!activeKey) return
    if (!closures[activeKey]) return
    try {
      const { closures: next, directionId } = await protocolClosureRemember({
        closures,
        key: activeKey,
        questionText: question,
        path,
        conclusion,
      })
      saveMap(corpus, next)
      set({
        closures: next,
        lastBundle: bundle,
        lastConclusion: conclusion,
        lastPath: path,
        phase: 'in_closure',
        lastMatches: [],
        forbidIds: [],
        pendingEdge: null,
      })
      get().pushLog(`回写方向 ${directionId} · 服务端登记`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ error: `回写失败：${msg}` })
      get().pushLog(`回写失败：${msg}`)
    }
  },
}))
