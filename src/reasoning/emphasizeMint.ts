/**
 * 强调笔空白 → 用户确认铸门 → 与指针成员合成 regionKey（combo）。
 */

import type { EmphasisEdge } from '../data/emphasis'
import {
  appendConfirmedLayoutSlotFromEmphasize,
  decomposeEmphasizeAgainstLayout,
  sealEmphasizeRegionKey,
  type BookIndex,
} from './pipelineA'
import { decompositionToRegionBinding } from '../arch/pageMark'
import { usePageMarkStore } from './pageMarkStore'
import { useIndexGate } from './indexGate'

export type ConfirmEmphasizeMintResult =
  | {
      ok: true
      /** 空白新门 */
      bookKey: string
      layoutK: number
      /** 强调笔区域把手 = 指针∪空白 */
      regionKey: string
      regionMemberKeys: string[]
      index: BookIndex
      note: string
    }
  | { ok: false; note: string }

/**
 * 仅空白铸门（confirm:true）。铸完与已有指针合成 regionKey。
 */
export async function confirmEmphasizeMintBookKey(input: {
  edge: EmphasisEdge
  bookIndex: BookIndex
  confirm: true
  content?: string
  mintAabb?: [number, number, number, number]
}): Promise<ConfirmEmphasizeMintResult> {
  if (input.confirm !== true) {
    return { ok: false, note: '须用户确认（confirm:true）才可铸空白门' }
  }
  const pending = usePageMarkStore.getState().pendingEmphasizeConfirm
  const mintAabb =
    input.mintAabb ??
    (pending?.emphasizeId === input.edge.id ? pending.aabb : undefined) ??
    input.edge.region.aabb

  try {
    const { index, bookKey, layoutK, note } =
      await appendConfirmedLayoutSlotFromEmphasize({
        index: input.bookIndex,
        edge: input.edge,
        content: input.content,
        mintAabb,
      })

    const bindingBefore = decompositionToRegionBinding(
      decomposeEmphasizeAgainstLayout(input.bookIndex, input.edge),
    )
    const reuseKeys = bindingBefore.reuse.map((r) => r.bookKey)
    const sealed = await sealEmphasizeRegionKey({
      docId: index.docId,
      reuseBookKeys: reuseKeys,
      blankBookKey: bookKey,
    })

    useIndexGate.getState().setBookIndex(index, true)
    const st = usePageMarkStore.getState()
    st.attachBookKeyToEmphasize({
      docId: index.docId,
      emphasizeId: input.edge.id,
      bookKey,
      layoutK,
      aabb: mintAabb,
    })
    st.attachRegionToEmphasize({
      docId: index.docId,
      emphasizeId: input.edge.id,
      regionKey: sealed.regionKey,
      regionMemberKeys: sealed.regionMemberKeys,
    })
    st.clearPendingEmphasizeConfirm()

    return {
      ok: true,
      bookKey,
      layoutK,
      regionKey: sealed.regionKey,
      regionMemberKeys: sealed.regionMemberKeys,
      index,
      note: `${note} · regionKey=${sealed.regionKey.slice(0, 18)}… · members×${sealed.regionMemberKeys.length}`,
    }
  } catch (e) {
    return {
      ok: false,
      note: e instanceof Error ? e.message : String(e),
    }
  }
}

export async function confirmPendingEmphasizeMint(input: {
  edge: EmphasisEdge
  confirm: true
  content?: string
}): Promise<ConfirmEmphasizeMintResult> {
  const bookIndex = useIndexGate.getState().bookIndex
  if (!bookIndex) {
    return { ok: false, note: '尚无 BookIndex，无法铸门' }
  }
  const pending = usePageMarkStore.getState().pendingEmphasizeConfirm
  if (!pending || pending.emphasizeId !== input.edge.id) {
    return {
      ok: false,
      note: '无匹配的 pending 空白确认',
    }
  }
  return confirmEmphasizeMintBookKey({
    edge: input.edge,
    bookIndex,
    confirm: true,
    content: input.content,
    mintAabb: pending.aabb,
  })
}
