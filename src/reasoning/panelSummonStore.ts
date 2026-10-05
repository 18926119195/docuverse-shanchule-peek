/**
 * 被调取的注意力面板（常显）。
 * 调取单位 = 一次 LLM 调用批（llmCallId → 一门多格）；单 key 仍兼容。
 */

import { create } from 'zustand'
import { ADJACENT_SHELL_STEP } from '../arch/attentionPanel'
import type { AttentionKeyKind } from '../arch/attentionPanel'
import { inferAttentionKeyKind } from './keyWorldAnchor'
import { memberKeysForLlmCall } from './turnJobProgress'
import { useAttentionIo } from './attentionIoStore'

export type SummonedPanel = {
  /** 面板门牌：batch 用 llmCallId；单 key 用 instance key */
  panelId: string
  llmCallId?: string
  keyKind: AttentionKeyKind
  memberKeys: string[]
  queryKey?: string
  summonedAt: number
}

const STEP_MIN = 0.04
const STEP_MAX = 0.55

type PanelSummonState = {
  panels: SummonedPanel[]
  /** 进度图选中的边（llmCallId） */
  selectedEdgeIds: string[]
  globalScale: number
  shellStep: number
  setGlobalScale: (s: number) => void
  setShellStep: (step: number) => void
  nudgeShellStep: (delta: number) => void
  toggleEdgeSelect: (llmCallId: string) => void
  clearEdgeSelect: () => void
  /** ≥2 条选中边 → 调取对应集合面板 */
  summonSelectedEdges: () => { ok: boolean; note: string }
  summonCallBatch: (llmCallId: string) => void
  summonKeys: (keys: string[]) => void
  dismissPanel: (panelId: string) => void
  /** @deprecated 用 dismissPanel */
  dismissKey: (key: string) => void
  dismissAll: () => void
  has: (key: string) => boolean
}

function clampStep(s: number): number {
  return Math.max(STEP_MIN, Math.min(STEP_MAX, s))
}

export const usePanelSummonStore = create<PanelSummonState>((set, get) => ({
  panels: [],
  selectedEdgeIds: [],
  globalScale: 1,
  shellStep: ADJACENT_SHELL_STEP,
  setGlobalScale: (s) => set({ globalScale: Math.max(0.35, Math.min(3, s)) }),
  setShellStep: (step) => set({ shellStep: clampStep(step) }),
  nudgeShellStep: (delta) =>
    set({ shellStep: clampStep(get().shellStep + delta) }),

  toggleEdgeSelect: (llmCallId) => {
    const id = llmCallId.trim()
    if (!id) return
    set((s) => {
      const has = s.selectedEdgeIds.includes(id)
      return {
        selectedEdgeIds: has
          ? s.selectedEdgeIds.filter((x) => x !== id)
          : [...s.selectedEdgeIds, id],
      }
    })
  },

  clearEdgeSelect: () => set({ selectedEdgeIds: [] }),

  summonSelectedEdges: () => {
    const ids = get().selectedEdgeIds
    if (ids.length < 2) {
      return { ok: false, note: '至少选两条进度边才能跳转双面板' }
    }
    for (const id of ids) get().summonCallBatch(id)
    return { ok: true, note: `已调取 ${ids.length} 块集合面板` }
  },

  summonCallBatch: (llmCallId) => {
    const id = llmCallId.trim()
    if (!id) return
    const ledger = useAttentionIo
      .getState()
      .llmCallLedger.find((c) => c.llmCallId === id)
    const memberKeys =
      ledger?.memberKeys ?? memberKeysForLlmCall(id)
    if (memberKeys.length === 0) return
    const keyKind =
      ledger?.keyKind ?? inferAttentionKeyKind(memberKeys[0]!)
    const now = Date.now()
    set((s) => {
      const rest = s.panels.filter((p) => p.panelId !== id)
      return {
        panels: [
          ...rest,
          {
            panelId: id,
            llmCallId: id,
            keyKind,
            memberKeys,
            queryKey: ledger?.queryKey,
            summonedAt: now,
          },
        ],
      }
    })
  },

  summonKeys: (keys) => {
    const now = Date.now()
    set((s) => {
      const map = new Map(s.panels.map((p) => [p.panelId, p]))
      for (const raw of keys) {
        const key = raw.trim()
        if (!key) continue
        // 若 key 已在某 batch 内，仍可单开一块单成员面板
        map.set(key, {
          panelId: key,
          keyKind: inferAttentionKeyKind(key),
          memberKeys: [key],
          summonedAt: now,
        })
      }
      return { panels: [...map.values()] }
    })
  },

  dismissPanel: (panelId) =>
    set((s) => ({ panels: s.panels.filter((p) => p.panelId !== panelId) })),

  dismissKey: (key) => get().dismissPanel(key),

  dismissAll: () => set({ panels: [], selectedEdgeIds: [] }),

  has: (key) =>
    get().panels.some(
      (p) => p.panelId === key || p.memberKeys.includes(key),
    ),
}))

export const SHELL_STEP_MIN = STEP_MIN
export const SHELL_STEP_MAX = STEP_MAX
