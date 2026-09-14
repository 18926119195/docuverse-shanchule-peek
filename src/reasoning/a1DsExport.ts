/**
 * Export A1 as DeepSeek closed-list: only key + T.
 */

import type { BookIndex, AChunk } from './pipelineA'
import { atomSearchText, isRetrievableAtom } from './hybridRetrieve'

export type A1DsRow = {
  key: string
  /** 原文 T */
  T: string
}

export type A1DsExportOptions = {
  /** Cap body text per row (0 = full). Default 1200；全局下载导出传 0。 */
  maxTextChars?: number
  /** Soft cap per downloaded pack. Default 90_000. 仅 buildA1DsPacks 分批用。 */
  maxCharsPerPack?: number
  /** Soft cap rows per pack. Default 100. 仅 buildA1DsPacks 分批用。 */
  maxRowsPerPack?: number
  /** Drop empty / fig placeholders. Default true. */
  retrievableOnly?: boolean
  /** 热启 peek：只导出这些 bookKey（书序已由调用方排好时可再滤） */
  onlyKeys?: ReadonlySet<string>
  /** 热启：未开门牌优先排前（仅影响行序） */
  preferKeysFirst?: readonly string[]
}

export type A1DsPack = {
  packIndex: number
  packCount: number
  rows: A1DsRow[]
  markdown: string
  jsonl: string
  tsv: string
  filenameBase: string
}

const DEFAULT_MAX_TEXT = 1200
const DEFAULT_MAX_CHARS = 90_000
const DEFAULT_MAX_ROWS = 100

/** Sticky instructions — top & bottom of every pack. */
export function a1DsPromptRules(): string {
  return [
    '【任务规则 · 必须遵守 · peek 契约】',
    '1. 下面是 A1 表：每行只有 KEY（= bookKey / 门牌）与 T（原文）。',
    '2. 只能从 KEY 列原样复制门牌，禁止编造、截断、改写 KEY。',
    '3. LLM out = 同一 bookKey + brief 正文；禁止输出 briefKey / queryKey / inferKey；禁止 items[] / keep[] / 整窗 coverage。',
    '   briefKey 由写信台落账铸造，模型不要写。',
    '   主协议 briefs[]：一元素一槽；同门多贴 = 多条同 key，或一行 briefs:["贴A","贴B"] 展开。',
    '   仅 sufficient（或有 brief 未报态）才铸键；unread/insufficient 不铸。',
    '4. brief = 门贴标签，必须用「名词 + 动词/关系」电报体，禁止完整陈述句。',
    '   - 格式：对象·动作｜关系（可用 · ｜ / 连接）；尽量短。',
    '   - 优先沿用 T 原文中的关键措辞立贴。',
    '5. rationale 可写半句「为何对问题有用」，勿把 brief 写成小作文。',
    '6. 输出 JSON（可包在 ```json 里）：',
    '   {"briefs":[{"key":"h1.…","brief":"名词·动词｜关系","status":"sufficient"},{"key":"h1.…","briefs":["贴A","贴B"],"status":"sufficient"}],"keyStatuses":[{"key":"h1.…","status":"unread|sufficient|insufficient"}],"answer":"可选总述"}',
    '7. briefs[].key 必须与表中 KEY 字符级完全一致；brief 必填非空；同 KEY 多槽勿合并成一条。',
    '8. 对每个输入 bookKey 报三态：unread=未读；sufficient=brief 充分可铸可递送；insufficient=已读但贴不够。',
    '9. 本批 KEY 看不清或证据不足：该 KEY 标 insufficient/unread，仍尽量对能读的 KEY 铸 brief；禁止空 briefs[] 并要求「请分批输入」（分批由台侧完成）。',
  ].join('\n')
}

/** 软整理 brief：去空白、去句末标点；仅防失控散文时软截断，不抛错、不拒收、不改词。 */
export function normalizeBriefTag(brief: string, maxChars = 64): string {
  let s = brief
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
  // 去掉句末标点，促电报体
  s = s.replace(/[。．.！？!?]+$/g, '').trim()
  if (maxChars > 0 && s.length > maxChars) {
    s = `${s.slice(0, maxChars).replace(/[·｜|/，,、\s]+$/g, '')}…`
  }
  return s
}

function safeDocSlug(docId: string): string {
  return (
    docId
      .replace(/^upload:/, '')
      .replace(/[^\w\u4e00-\u9fff.-]+/g, '_')
      .slice(0, 48) || 'doc'
  )
}

function sortChunks(chunks: AChunk[]): AChunk[] {
  return [...chunks].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page
    const dy = a.bbox[1] - b.bbox[1]
    if (Math.abs(dy) > 8) return dy
    return a.bbox[0] - b.bbox[0] || a.slotK - b.slotK
  })
}

function clipText(text: string, max: number): string {
  const t = text.replace(/\r\n/g, '\n').trim()
  if (max <= 0 || t.length <= max) return t
  return `${t.slice(0, max)}…`
}

export function collectA1DsRows(
  bookIndex: BookIndex,
  options: A1DsExportOptions = {},
): A1DsRow[] {
  const maxText = options.maxTextChars ?? DEFAULT_MAX_TEXT
  const retrievableOnly = options.retrievableOnly !== false
  const only = options.onlyKeys
  const rows: A1DsRow[] = []
  for (const c of sortChunks(bookIndex.chunks)) {
    if (only && !only.has(c.key)) continue
    if (retrievableOnly && !isRetrievableAtom(c)) continue
    const raw = atomSearchText(c)
    if (raw.trim().length < 4) continue
    rows.push({
      key: c.key,
      T: clipText(raw, maxText),
    })
  }
  const prefer = options.preferKeysFirst
  if (prefer && prefer.length > 0) {
    const rank = new Map(prefer.map((k, i) => [k, i]))
    rows.sort((a, b) => {
      const ra = rank.has(a.key) ? rank.get(a.key)! : 1e9
      const rb = rank.has(b.key) ? rank.get(b.key)! : 1e9
      return ra - rb
    })
  }
  return rows
}

function renderRowBlock(row: A1DsRow): string {
  return [`KEY: \`${row.key}\``, `T:`, row.T, ''].join('\n')
}

function renderMarkdownPack(input: {
  packIndex: number
  packCount: number
  rows: A1DsRow[]
  /** 全局一份时注明来源，避免 pack 1/N 误导 */
  global?: boolean
  label?: string
  docId?: string
}): string {
  const rules = a1DsPromptRules()
  const title = input.global ? `# A1 · KEY + T（全局一份）` : `# A1 · KEY + T`
  const meta = input.global
    ? [
        input.label ? `source: ${input.label}` : null,
        input.docId ? `docId: ${input.docId}` : null,
        `rows: ${input.rows.length} · fullText: true · packs: 1/1`,
      ]
        .filter(Boolean)
        .join('\n')
    : `pack: ${input.packIndex}/${input.packCount} · rows: ${input.rows.length}`
  const head = [
    title,
    ``,
    meta,
    ``,
    rules,
    ``,
    `---`,
    ``,
  ].join('\n')

  const body = input.rows.map(renderRowBlock).join('\n')

  const foot = [
    ``,
    `---`,
    ``,
    rules,
    ``,
    `请根据用户问题，只从上面 KEY 中选择，输出 JSON。`,
    ``,
  ].join('\n')

  return head + body + foot
}

function renderJsonl(rows: A1DsRow[]): string {
  return rows.map((r) => JSON.stringify({ key: r.key, T: r.T })).join('\n')
}

function renderTsv(rows: A1DsRow[]): string {
  const esc = (s: string) =>
    s.replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim()
  const lines = ['key\tT']
  for (const r of rows) {
    lines.push(`${esc(r.key)}\t${esc(r.T)}`)
  }
  return lines.join('\n')
}

function estimateMarkdownChars(rows: A1DsRow[]): number {
  let n = 1800
  for (const r of rows) n += r.key.length + r.T.length + 24
  return n
}

export function buildA1DsPacks(
  bookIndex: BookIndex,
  options: A1DsExportOptions = {},
): A1DsPack[] {
  const all = collectA1DsRows(bookIndex, options)
  if (all.length === 0) return []

  const maxChars = options.maxCharsPerPack ?? DEFAULT_MAX_CHARS
  const maxRows = options.maxRowsPerPack ?? DEFAULT_MAX_ROWS
  const slug = safeDocSlug(bookIndex.docId)

  const groups: A1DsRow[][] = []
  let cur: A1DsRow[] = []

  const flush = () => {
    if (cur.length) {
      groups.push(cur)
      cur = []
    }
  }

  for (const row of all) {
    const trial = [...cur, row]
    if (
      cur.length > 0 &&
      (trial.length > maxRows || estimateMarkdownChars(trial) > maxChars)
    ) {
      flush()
    }
    cur.push(row)
  }
  flush()

  const packCount = groups.length
  return groups.map((rows, idx) => {
    const packIndex = idx + 1
    const filenameBase = `a1-ds_${slug}_pack${String(packIndex).padStart(2, '0')}`
    return {
      packIndex,
      packCount,
      rows,
      markdown: renderMarkdownPack({ packIndex, packCount, rows }),
      jsonl: renderJsonl(rows),
      tsv: renderTsv(rows),
      filenameBase,
    }
  })
}

export function downloadTextFile(
  filename: string,
  body: string,
  mime = 'text/plain;charset=utf-8',
): void {
  const blob = new Blob([body], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** 全局导出默认：全文、不截断、不拆包（兼容语料包 bookIndex）。 */
const GLOBAL_EXPORT_DEFAULTS: A1DsExportOptions = {
  maxTextChars: 0,
  retrievableOnly: true,
}

/**
 * 完整干净提 A1：一书一文件（KEY+T），不再按 pack 拆多份。
 * 输入即语料表 bookIndex（上传 .docuverse.json 载入后的同结构）。
 */
export function buildA1GlobalExport(
  bookIndex: BookIndex,
  options: A1DsExportOptions = {},
): {
  rows: A1DsRow[]
  markdown: string
  jsonl: string
  tsv: string
  filenameBase: string
} {
  const rows = collectA1DsRows(bookIndex, {
    ...GLOBAL_EXPORT_DEFAULTS,
    ...options,
    maxTextChars: options.maxTextChars ?? 0,
  })
  const slug = safeDocSlug(bookIndex.docId)
  const filenameBase = `a1-ds_${slug}_GLOBAL`
  return {
    rows,
    markdown: renderMarkdownPack({
      packIndex: 1,
      packCount: 1,
      rows,
      global: true,
      docId: bookIndex.docId,
    }),
    jsonl: renderJsonl(rows),
    tsv: renderTsv(rows),
    filenameBase,
  }
}

export function exportA1ForDeepSeek(
  bookIndex: BookIndex,
  options: A1DsExportOptions = {},
): { packCount: number; rowCount: number; mode: 'single' | 'packs' } {
  const built = buildA1GlobalExport(bookIndex, options)
  if (built.rows.length === 0) {
    return { packCount: 0, rowCount: 0, mode: 'single' }
  }
  downloadTextFile(
    `${built.filenameBase}.md`,
    built.markdown,
    'text/markdown;charset=utf-8',
  )
  return { packCount: 1, rowCount: built.rows.length, mode: 'single' }
}

export function exportA1ForDeepSeekJsonl(
  bookIndex: BookIndex,
  options: A1DsExportOptions = {},
): { packCount: number; rowCount: number; mode: 'single' | 'packs' } {
  const built = buildA1GlobalExport(bookIndex, options)
  if (built.rows.length === 0) {
    return { packCount: 0, rowCount: 0, mode: 'single' }
  }
  downloadTextFile(
    `${built.filenameBase}.jsonl`,
    built.jsonl,
    'application/x-ndjson',
  )
  return { packCount: 1, rowCount: built.rows.length, mode: 'single' }
}

export function a1DsChatPromptStub(question: string): string {
  return [
    a1DsPromptRules(),
    '',
    '用户问题：',
    question.trim() || '（在此粘贴问题）',
    '',
    '请结合已上传的 A1 表（仅 KEY+T），只输出 JSON：{"briefs":[{"key":"h1.…","brief":"名词·动词｜关系","status":"sufficient"}],"answer":"…"}',
    'brief 必须电报体（贴 T 原词、尽量短），禁止完整陈述句。',
  ].join('\n')
}
