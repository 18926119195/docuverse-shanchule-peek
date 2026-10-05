/**
 * bookKey 身份（权威）：
 *   bookKey = layout 划重点铸键 = (docId, page, layoutK)
 *   与强调笔共享页上基底（见 pageMark.ts）；OCR/改字不是开门。
 *
 * 面上的 T：OCR 初读或人手改正文，挂在门上；同槽改 T / 重 OCR → 不换 bookKey。
 * 仅 layout 重切（槽集合/序位变）才可能换门。
 *
 * 服务端 lockId 公式（勿改，封印依赖稳定）：
 *   `${docId}|slot|p${page}|k${layoutK}`
 * 浏览器只持 opaque handle；|slot| 为历史词，语义=layout 槽。
 */

export type BookKeyCoord = {
  docId: string
  page: number
  /** 页内 layout 步序（0-based）；≠ OCR 步 */
  layoutK: number
}

/** 与 api/_lib/protocol/keys.makeSlotKey 同构（仅文档/测试用；浏览器禁止自铸门牌） */
export function bookKeyLockIdFormula(c: BookKeyCoord): string {
  return `${c.docId}|slot|p${c.page}|k${c.layoutK}`
}

export const BOOK_KEY_RULE = {
  identity: 'layout_coord' as const,
  /** 铸键：layout 提案 seal；强调未覆盖经用户确认后亦走同一公式 */
  mint: 'seal_layout_coord' as const,
  face: 'T' as const,
  remintOnTextEdit: false,
  remintOnOcrReread: false,
  remintOnLayoutRecut: true,
  remintOnEmphasizeStroke: false,
  /** 强调未覆盖：确认后铸新门（与 layout 同级） */
  mintOnEmphasizeConfirmWhenUncovered: true,
} as const
