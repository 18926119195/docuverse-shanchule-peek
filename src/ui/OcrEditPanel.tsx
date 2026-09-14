import { useState } from 'react'
import { useDocuverse } from '../canvas/store'
import { ocrPageHasEdits } from '../data/ocrService'

/**
 * OCR tools + permanent bond sealing.
 * Primary edit = double-click on OCR twin.
 * Bond = PDF bbox ↔ user-confirmed text ↔ comment.
 */
export function OcrEditPanel() {
  const ocrOpen = useDocuverse((s) => s.ocrOpen)
  const ocrActiveStrand = useDocuverse((s) => s.ocrActiveStrand)
  const ocrByStrand = useDocuverse((s) => s.ocrByStrand)
  const ocrEditingBlockId = useDocuverse((s) => s.ocrEditingBlockId)
  const ocrHoverBlock = useDocuverse((s) => s.ocrHoverBlock)
  const ocrInlineEdit = useDocuverse((s) => s.ocrInlineEdit)
  const permanentBonds = useDocuverse((s) => s.permanentBonds)
  const beginOcrInlineEdit = useDocuverse((s) => s.beginOcrInlineEdit)
  const restoreOcrBlockContent = useDocuverse((s) => s.restoreOcrBlockContent)
  const confirmOcrBlock = useDocuverse((s) => s.confirmOcrBlock)
  const sealPermanentBond = useDocuverse((s) => s.sealPermanentBond)
  const deleteOcrBlock = useDocuverse((s) => s.deleteOcrBlock)
  const addOcrBlock = useDocuverse((s) => s.addOcrBlock)
  const endOcrInlineEdit = useDocuverse((s) => s.endOcrInlineEdit)
  const [commentDraft, setCommentDraft] = useState('')
  const [sealMsg, setSealMsg] = useState<string | null>(null)

  const result =
    ocrOpen && ocrActiveStrand !== null ? ocrByStrand[ocrActiveStrand] : undefined
  if (!ocrOpen || !result) return null

  const activeId = ocrEditingBlockId ?? ocrHoverBlock
  const editing = result.blocks.find((b) => b.id === activeId)
  const dirty = ocrPageHasEdits(result)
  const pageBonds =
    ocrActiveStrand === null
      ? []
      : permanentBonds.filter((b) => b.strandIndex === ocrActiveStrand)

  return (
    <section className="hud-panel ocr-edit">
      <h2>OCR · 永久绑定</h2>
      <p className="hint">
        <strong>双击</strong> OCR 对照页改字 → <strong>确认检验</strong> →
        写评论并<strong>密封绑定</strong>。射线只能连两个已密封绑定。
        {dirty ? ' · 本页有本地修改' : ''}
        {ocrInlineEdit ? ' · 正在页内编辑' : ''}
      </p>

      <div className="ocr-edit-toolbar">
        <button
          type="button"
          className="corpus-chip"
          onClick={() => {
            addOcrBlock({ content: '' })
          }}
        >
          ＋ 新增并编辑
        </button>
        <button
          type="button"
          className="corpus-chip"
          disabled={!ocrHoverBlock}
          onClick={() => {
            const src = result.blocks.find((b) => b.id === ocrHoverBlock)
            if (!src) return
            addOcrBlock({
              content: '',
              bbox: [...src.bbox] as [number, number, number, number],
              label: src.label,
            })
          }}
        >
          同区新增
        </button>
      </div>
      <p className="hint">原页 Alt+点击空白处也可新增绑定切块</p>

      {editing && (
        <>
          <div className="ocr-edit-toolbar">
            <button
              type="button"
              className="corpus-chip"
              disabled={ocrInlineEdit && ocrEditingBlockId === editing.id}
              onClick={() => beginOcrInlineEdit(editing.id)}
            >
              在页内编辑此块
            </button>
            <button
              type="button"
              className="corpus-chip"
              disabled={editing.content === editing.sourceContent}
              onClick={() => restoreOcrBlockContent(editing.id)}
            >
              恢复识别原文
            </button>
            <button
              type="button"
              className={`corpus-chip${editing.confirmed ? ' active' : ''}`}
              disabled={!editing.content.trim() || editing.confirmed}
              onClick={() => {
                confirmOcrBlock(editing.id)
                setSealMsg(null)
              }}
            >
              {editing.confirmed ? '已确认检验' : '确认检验文本'}
            </button>
            <button
              type="button"
              className="corpus-chip danger"
              onClick={() => {
                if (
                  window.confirm(
                    '删除此 OCR 切块？已密封的永久绑定不受影响。',
                  )
                ) {
                  deleteOcrBlock(editing.id)
                  endOcrInlineEdit()
                }
              }}
            >
              删除切块
            </button>
          </div>

          <label className="bond-comment-label">
            评论（密封进永久绑定）
            <textarea
              className="bond-comment-input"
              rows={2}
              value={commentDraft}
              placeholder="对这段原件切片 + 检验文本的永久注释…"
              onChange={(e) => {
                setCommentDraft(e.target.value)
                setSealMsg(null)
              }}
            />
          </label>
          <div className="ocr-edit-toolbar">
            <button
              type="button"
              className="upload-btn"
              disabled={
                !editing.confirmed ||
                !editing.content.trim() ||
                !commentDraft.trim()
              }
              onClick={() => {
                const id = sealPermanentBond({
                  ocrBlockId: editing.id,
                  comment: commentDraft,
                })
                if (id) {
                  setCommentDraft('')
                  setSealMsg('已密封：原件切片 ↔ 检验文本 ↔ 评论')
                } else {
                  setSealMsg('密封失败：需先确认检验并填写评论')
                }
              }}
            >
              密封永久绑定
            </button>
          </div>
          {sealMsg && <p className="meta">{sealMsg}</p>}
          <p className="meta">
            #{editing.index} · {editing.label}
            {editing.confirmed ? ' · 已检验' : ' · 未检验'}
            {' · '}
            {editing.content.trim().slice(0, 48) || '（空）'}
          </p>
        </>
      )}

      {!editing && (
        <p className="meta">共 {result.blocks.length} 块 · 悬停或双击选择</p>
      )}

      {pageBonds.length > 0 && (
        <div className="bond-page-list">
          <p className="meta">本页永久绑定 {pageBonds.length}</p>
          <ul>
            {pageBonds.map((b) => (
              <li key={b.id}>
                <span className="bond-snippet">
                  {b.confirmedText.slice(0, 36)}
                  {b.confirmedText.length > 36 ? '…' : ''}
                </span>
                <span className="bond-comment-chip">{b.comment.slice(0, 40)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
