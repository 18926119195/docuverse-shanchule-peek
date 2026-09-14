/**
 * 注意力面板上的强调笔：与页上 bookKey 同构。
 * 门 = 面板 doorAabb（+ 已确认子门）；命中只指针；空白须确认后铸面板子门（不铸 bookKey）。
 */

import { create } from 'zustand'
import {
  decomposeEmphasizeAgainstDoors,
  decompositionToDoorRegionBinding,
  type EmphasizeCoverage,
  type EmphasizeDoorDecomposition,
  type EmphasizeDoorRegionBinding,
  type NormBBox,
  type DoorFace,
} from '../arch/doorFace'
import {
  newPanelChildDoorKey,
  panelAsDoorFace,
  panelChildDoorFace,
  type AttentionPanel,
} from '../arch/attentionPanel'

export type PanelEmphasizeStroke = {
  id: string
  panelKey: string
  aabb: NormBBox
  createdAt: number
  coverage: EmphasizeCoverage
  decomposition: EmphasizeDoorDecomposition
  binding: EmphasizeDoorRegionBinding
  /** 空白确认后挂上的子门 */
  blankDoorKey?: string
}

type PanelEmphasizeState = {
  /** panelKey → 已确认子门（空白铸） */
  childDoorsByPanel: Record<string, DoorFace[]>
  strokes: PanelEmphasizeStroke[]
  pendingBlank: {
    strokeId: string
    panelKey: string
    aabb: NormBBox
  } | null
  lastCoverage: EmphasizeCoverage | null
  lastBinding: EmphasizeDoorRegionBinding | null

  doorsForPanel: (panel: AttentionPanel) => DoorFace[]
  /** 落一笔（panel_norm aabb）→ 分解，效果同页上强调笔 */
  sealStroke: (input: {
    panel: AttentionPanel
    aabb: NormBBox
  }) => PanelEmphasizeStroke
  /** 空白确认 → 铸面板子门（挂 parentKey，不当 bookKey） */
  confirmBlankChildDoor: (input: {
    panel: AttentionPanel
    confirm: true
  }) => { ok: true; doorKey: string } | { ok: false; note: string }
  clearPending: () => void
  clearPanel: (panelKey: string) => void
}

function sid(): string {
  return `pem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

export const usePanelEmphasizeStore = create<PanelEmphasizeState>(
  (set, get) => ({
    childDoorsByPanel: {},
    strokes: [],
    pendingBlank: null,
    lastCoverage: null,
    lastBinding: null,

    doorsForPanel: (panel) => {
      const main = panelAsDoorFace(panel)
      const kids = get().childDoorsByPanel[panel.key] ?? []
      // 子门优先命中：分解时多门并列；主门仍在，占块可落主门或子门
      return [main, ...kids]
    },

    sealStroke: ({ panel, aabb }) => {
      const doors = get().doorsForPanel(panel)
      const decomposition = decomposeEmphasizeAgainstDoors(aabb, doors)
      const binding = decompositionToDoorRegionBinding(decomposition)
      const stroke: PanelEmphasizeStroke = {
        id: sid(),
        panelKey: panel.key,
        aabb,
        createdAt: Date.now(),
        coverage: decomposition.coverage,
        decomposition,
        binding,
      }

      const needsConfirm =
        decomposition.coverage === 'uncovered_needs_confirm' ||
        decomposition.coverage === 'mixed_hit_and_uncovered'

      set((s) => ({
        strokes: [...s.strokes, stroke],
        lastCoverage: decomposition.coverage,
        lastBinding: binding,
        pendingBlank:
          needsConfirm && binding.blank
            ? {
                strokeId: stroke.id,
                panelKey: panel.key,
                aabb: binding.blank.aabb,
              }
            : null,
      }))
      return stroke
    },

    confirmBlankChildDoor: ({ panel, confirm }) => {
      if (confirm !== true) {
        return { ok: false, note: '须 confirm:true' }
      }
      const pending = get().pendingBlank
      if (!pending || pending.panelKey !== panel.key) {
        return { ok: false, note: '无匹配的面板空白待确认' }
      }
      const existing = get().childDoorsByPanel[panel.key] ?? []
      const k = existing.length
      const doorKey = newPanelChildDoorKey(panel.key, k)
      const child = panelChildDoorFace({
        parentKey: panel.key,
        childKey: doorKey,
        aabb: pending.aabb,
        layoutK: k,
      })
      set((s) => ({
        childDoorsByPanel: {
          ...s.childDoorsByPanel,
          [panel.key]: [...existing, child],
        },
        strokes: s.strokes.map((st) =>
          st.id === pending.strokeId
            ? {
                ...st,
                blankDoorKey: doorKey,
                binding: {
                  ...st.binding,
                  blank: st.binding.blank
                    ? { ...st.binding.blank, doorKey, layoutK: k }
                    : null,
                  regionMemberKeys: [
                    ...st.binding.regionMemberKeys,
                    doorKey,
                  ],
                },
              }
            : st,
        ),
        pendingBlank: null,
      }))
      return { ok: true, doorKey }
    },

    clearPending: () => set({ pendingBlank: null }),

    clearPanel: (panelKey) =>
      set((s) => {
        const { [panelKey]: _, ...rest } = s.childDoorsByPanel
        return {
          childDoorsByPanel: rest,
          strokes: s.strokes.filter((st) => st.panelKey !== panelKey),
          pendingBlank:
            s.pendingBlank?.panelKey === panelKey ? null : s.pendingBlank,
        }
      }),
  }),
)
