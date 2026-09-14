/**
 * 注意力窗内材料槽（LLM I/O 专用）。
 *
 * - 台账 / A1 / settle 主键仍是全长 h1.… / qk_… / ph_…
 * - 组窗时按本窗 keys 顺序铸 ⟦1⟧…⟦n⟧；落账前必须展开回全键
 * - 输入用 ⟦n⟧ 独占行分隔；JSON 门牌字段只认 ⟦n⟧（不认 wN / 裸号 / slot）
 * - 别名只活在单次组窗；跨窗不得复用同一槽号指代不同全键
 */

export type WindowAliasTable = {
  /** 本窗全键（去重、保序） */
  fullKeys: readonly string[]
  /** full → ⟦n⟧ */
  aliasOf: ReadonlyMap<string, string>
  /** ⟦n⟧ → full */
  fullOf: ReadonlyMap<string, string>
}

/** 唯一合法 LLM 门牌：⟦1⟧、⟦2⟧… */
export const DESK_SLOT_RE = /^⟦([1-9]\d*)⟧$/

export function slotAlias(index1Based: number): string {
  return `⟦${index1Based}⟧`
}

export function parseDeskSlotIndex(raw: string): number | null {
  const m = DESK_SLOT_RE.exec(raw.trim())
  return m ? Number(m[1]) : null
}

export function isWindowAlias(raw: string): boolean {
  return parseDeskSlotIndex(raw) != null
}

/** @deprecated 已废除 wN；保留导出以免旧 import 炸，恒 false */
export const WINDOW_ALIAS_RE = /^$/

export function buildWindowAliasTable(
  fullKeys: ReadonlyArray<string>,
): WindowAliasTable {
  const uniq: string[] = []
  const seen = new Set<string>()
  for (const raw of fullKeys) {
    const k = raw.trim()
    if (!k || seen.has(k)) continue
    seen.add(k)
    uniq.push(k)
  }
  const aliasOf = new Map<string, string>()
  const fullOf = new Map<string, string>()
  uniq.forEach((full, i) => {
    const alias = slotAlias(i + 1)
    aliasOf.set(full, alias)
    fullOf.set(alias, full)
  })
  return { fullKeys: uniq, aliasOf, fullOf }
}

/**
 * LLM 回传门牌 → 本窗全键。
 * 只认 ⟦n⟧；不认 wN / 裸号 / 全长键（全长键由台侧自己用，不经模型）。
 */
export function resolveWindowDoorplate(
  raw: string,
  table: WindowAliasTable,
): string | null {
  const t = raw.trim()
  if (!t) return null
  return table.fullOf.get(t) ?? null
}

export function displayWindowAlias(
  fullKey: string,
  table: WindowAliasTable,
): string {
  const k = fullKey.trim()
  return table.aliasOf.get(k) ?? k
}

/**
 * 写信台材料块：⟦n⟧ 独占行 + 可选标签行 + 正文（无 bookKey=/queryKey= 行）。
 */
export function formatDeskMaterialSlot(input: {
  fullKey: string
  table: WindowAliasTable
  body: string
  /** 插在槽头与正文之间的提示行 */
  tags?: readonly string[]
}): string {
  const door = displayWindowAlias(input.fullKey, input.table)
  const tagLines = (input.tags ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
  const body = input.body.trim() ? input.body.trimEnd() : '（空）'
  return [door, ...tagLines, body, ''].join('\n')
}

/** 开放端点标记：不展开 */
const SEED_OPEN = new Set([
  '',
  '-inf',
  '-∞',
  '-infinity',
  'neg_inf',
  'open_low',
  'open-lo',
  '*',
  '−∞',
  '+inf',
  '+∞',
  '+infinity',
  'pos_inf',
  'inf',
  'infinity',
  '∞',
  'open_high',
  'open-hi',
])

/**
 * seedRange 端点：⟦n⟧→全键；开放标记原样；其它 → null
 */
export function resolveSeedEndpointDoorplate(
  raw: string,
  table: WindowAliasTable,
): string | null {
  const t = raw.trim()
  if (!t) return null
  if (SEED_OPEN.has(t.toLowerCase()) || SEED_OPEN.has(t)) return t
  return resolveWindowDoorplate(t, table)
}

export function expandSeedRangeDraftDoorplates<
  T extends
    | { kind: 'closed'; from: string; to: string }
    | { kind: 'open_low'; to: string }
    | { kind: 'open_high'; from: string },
>(draft: T, table: WindowAliasTable): T | null {
  if (draft.kind === 'closed') {
    const from = resolveSeedEndpointDoorplate(draft.from, table)
    const to = resolveSeedEndpointDoorplate(draft.to, table)
    if (!from || !to) return null
    return { ...draft, from, to }
  }
  if (draft.kind === 'open_low') {
    const to = resolveSeedEndpointDoorplate(draft.to, table)
    if (!to) return null
    return { ...draft, to }
  }
  const from = resolveSeedEndpointDoorplate(draft.from, table)
  if (!from) return null
  return { ...draft, from }
}

const KEY_FIELD = new Set([
  'key',
  'bookKey',
  'briefKey',
  'queryKey',
  'pathKey',
  'from',
  'to',
])

/**
 * 只改 JSON 门牌字段（及 bookKeys[]），不动 prospect/infer 正文。
 * 只展开合法 ⟦n⟧；无法识别则保留原串（settle 侧拒）。
 */
export function expandDoorplatesInJsonValue(
  value: unknown,
  table: WindowAliasTable,
): unknown {
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((v) => expandDoorplatesInJsonValue(v, table))
  }
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    if (k === 'bookKeys' && Array.isArray(v)) {
      const slots: number[] = []
      out[k] = v.map((item) => {
        if (typeof item !== 'string') return item
        const t = item.trim()
        const m = DESK_SLOT_RE.exec(t)
        if (m) slots.push(Number(m[1]))
        return resolveWindowDoorplate(item, table) ?? item
      })
      // 多门一步：保留窗内槽号，供审计用 ⟦n⟧ 对回全长 bookKey
      if (
        slots.length > 0 &&
        Array.isArray(out[k]) &&
        slots.length === (out[k] as unknown[]).length
      ) {
        out.bookSlots = slots
      }
      continue
    }
    if (KEY_FIELD.has(k) && typeof v === 'string') {
      if (k === 'from' || k === 'to') {
        out[k] = resolveSeedEndpointDoorplate(v, table) ?? v
      } else {
        out[k] = resolveWindowDoorplate(v, table) ?? v
      }
      continue
    }
    out[k] = expandDoorplatesInJsonValue(v, table)
  }
  return out
}

/**
 * 从 LLM 文本抽出 JSON → 展开门牌 → 写回围栏。
 */
export function expandDoorplatesInLlmText(
  llmText: string,
  table: WindowAliasTable,
  extractJsonObject: (text: string) => Record<string, unknown> | null,
): string {
  if (table.fullKeys.length === 0) return llmText
  const obj = extractJsonObject(llmText)
  if (!obj || typeof obj !== 'object') return llmText
  const expanded = expandDoorplatesInJsonValue(obj, table)
  return `\`\`\`json\n${JSON.stringify(expanded, null, 2)}\n\`\`\``
}

/** 组窗说明：槽门牌契约一行 */
export function windowAliasContractHint(table: WindowAliasTable): string {
  if (table.fullKeys.length === 0) return ''
  const map = table.fullKeys
    .map((full) => table.aliasOf.get(full)!)
    .join(' ')
  return (
    `【材料槽】本窗按序 ${map}：上列为 ⟦n⟧ 独占行 + 正文；` +
    `JSON 门牌字段（bookKey/briefKey/key/queryKey/pathKey/seedRange 端点/bookKeys[]）只许回传上述 ⟦n⟧；` +
    `台落账前展开为全长键。禁止 wN、裸数字、slot、自造槽、h1/qk/ph 全长。`
  )
}
