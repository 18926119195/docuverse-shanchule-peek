/**
 * 主推理路径：能回 Q 的解法穷举。
 * 一条 path = conclusion（解法总览）+ steps（总览内各推理步骤的材料溯源）；
 * 禁止把解法写成「1门→2门→3门」爬梯剧本。
 * inferKey / queryKey 由写信台落账微动作铸（方案 B），正文指纹仅副索引。
 */

import {
  contentFingerprint,
  expandIncrementSlots,
  mintInstanceKey,
  newSettleActionId,
} from './settleMint'

export interface InferStepRaw {
  /** 本步服务 conclusion 的哪一块（论证角色）；可空 */
  role: string
  /** ≥1；本步依据的材料门（溯源，非爬梯） */
  bookKeys: string[]
  /**
   * 与 bookKeys 等长：窗内槽号（展开前门牌 ⟦n⟧ 的 n）。
   * 供审计用正文 ⟦n⟧ 对回全长 bookKey。
   */
  bookSlots?: number[]
  /** 本步如何从上述材料推出（细粒度 infer；多门时含分述+【合推】） */
  infer: string
}

export interface InferPathRaw {
  /** 解法总览：直接回答如何解 Q_now */
  conclusion: string
  steps: InferStepRaw[]
}

/** @deprecated 正文副索引；勿当门牌。新代码用 contentFingerprint / settleOnce。 */
export function contentKey(prefix: string, raw: string): string {
  const fp = contentFingerprint(raw || 'empty')
  return `${prefix}_${fp.slice(3)}`
}

/** 落账铸 inferKey（方案 B · 一槽一 key） */
export function mintInferKey(settleActionId?: string): {
  settleActionId: string
  inferKey: string
} {
  const sid = settleActionId || newSettleActionId('infer')
  return { settleActionId: sid, inferKey: mintInstanceKey('infer', sid) }
}

/** 落账铸 queryKey（方案 B） */
export function mintQueryKey(settleActionId?: string): {
  settleActionId: string
  queryKey: string
} {
  const sid = settleActionId || newSettleActionId('query')
  return { settleActionId: sid, queryKey: mintInstanceKey('query', sid) }
}

/**
 * @deprecated 曾用正文哈希当 inferKey → 同文会合并成一枚 key（禁止）。
 * 落账必须用 mintInferKey()。
 */
export function inferKeyOf(_inferText: string): string {
  throw new Error(
    'inferKeyOf 已废除：禁止用正文哈希铸 inferKey（会合并本应分开的槽）。请用 mintInferKey()。',
  )
}

/**
 * @deprecated 曾用问句哈希当 queryKey。落账请用 mintQueryKey / ensureQueryKey。
 */
export function queryKeyOfQuestion(question: string): string {
  return contentKey('qk', question)
}

export function fingerprintOfInfer(inferText: string): string {
  return contentFingerprint(inferText || 'empty')
}

export function fingerprintOfQuestion(question: string): string {
  return contentFingerprint(question.trim() || 'empty')
}

/**
 * 模型常把裸换行/制表符写进 JSON 字符串 → 标准 JSON.parse 整段报废。
 * 只改字符串字面量内部的控制字符，结构外空白不动。
 */
export function escapeRawControlsInJsonStrings(text: string): string {
  let out = ''
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      if (escape) {
        out += c
        escape = false
        continue
      }
      if (c === '\\') {
        out += c
        escape = true
        continue
      }
      if (c === '"') {
        out += c
        inString = false
        continue
      }
      if (c === '\n') {
        out += '\\n'
        continue
      }
      if (c === '\r') {
        out += '\\r'
        continue
      }
      if (c === '\t') {
        out += '\\t'
        continue
      }
      out += c
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    out += c
  }
  return out
}

function tryParseJson(text: string): unknown | null {
  const repaired = escapeRawControlsInJsonStrings(text)
  for (const candidate of [repaired, text]) {
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      /* next */
    }
  }
  return null
}

/**
 * 截断 JSON 抢救：模型 finish_reason=length 时常在数组中途断掉。
 * 尽量闭合括号；或从 prospects/briefs/keyStatuses 里抠出已写完的对象。
 */
function salvageTruncatedJson(slice: string): unknown | null {
  const work = escapeRawControlsInJsonStrings(slice)

  // 1) 补全未闭合引号/括号后再 parse
  {
    let t = work
    let inString = false
    let escape = false
    const stack: string[] = []
    for (let i = 0; i < t.length; i++) {
      const c = t[i]!
      if (inString) {
        if (escape) escape = false
        else if (c === '\\') escape = true
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') {
        inString = true
        continue
      }
      if (c === '{') stack.push('}')
      else if (c === '[') stack.push(']')
      else if (c === '}' || c === ']') {
        if (stack.length && stack[stack.length - 1] === c) stack.pop()
      }
    }
    if (inString) t += '"'
    // 去掉尾部悬空逗号后再闭合
    t = t.replace(/,\s*$/, '')
    while (stack.length) t += stack.pop()
    const closed = tryParseJson(t)
    if (closed) return closed
  }

  // 2) 从常见增量数组抠完整对象；单条坏了跳过，不整段放弃
  const pickArray = (field: string): unknown[] => {
    const m = work.match(new RegExp(`"${field}"\\s*:\\s*\\[`))
    if (!m || m.index == null) return []
    const from = m.index + m[0].length
    const out: unknown[] = []
    let i = from
    while (i < work.length) {
      while (i < work.length && /[\s,]/.test(work[i]!)) i++
      if (work[i] === ']') break
      if (work[i] !== '{') break
      let depth = 0
      let inStr = false
      let esc = false
      let j = i
      for (; j < work.length; j++) {
        const c = work[j]!
        if (inStr) {
          if (esc) esc = false
          else if (c === '\\') esc = true
          else if (c === '"') inStr = false
          continue
        }
        if (c === '"') {
          inStr = true
          continue
        }
        if (c === '{') depth++
        else if (c === '}') {
          depth--
          if (depth === 0) {
            j++
            break
          }
        }
      }
      if (depth !== 0) break
      const obj = tryParseJson(work.slice(i, j))
      if (obj) out.push(obj)
      // 单条 parse 失败：跳过该对象，继续扫后面完整项
      i = j
    }
    return out
  }

  const prospects = pickArray('prospects')
  const briefs = pickArray('briefs')
  const keyStatuses = pickArray('keyStatuses')
  const judgments = pickArray('judgments')
  const matches = pickArray('matches')
  if (
    prospects.length === 0 &&
    briefs.length === 0 &&
    keyStatuses.length === 0 &&
    judgments.length === 0 &&
    matches.length === 0
  ) {
    const regexProspects = salvageProspectObjectsByRegex(work)
    if (regexProspects.length > 0) return { prospects: regexProspects }
    const regexJudgments = salvagePathJudgmentObjectsByRegex(work)
    return regexJudgments.length > 0 ? { judgments: regexJudgments } : null
  }
  const rebuilt: Record<string, unknown> = {}
  if (prospects.length) rebuilt.prospects = prospects
  if (briefs.length) rebuilt.briefs = briefs
  if (keyStatuses.length) rebuilt.keyStatuses = keyStatuses
  if (judgments.length) rebuilt.judgments = judgments
  else if (matches.length) rebuilt.matches = matches
  // 数组抠到一部分时，再用正则补漏（字段顺序乱/尾项截断）
  if (prospects.length > 0) {
    const extra = salvageProspectObjectsByRegex(work)
    if (extra.length > prospects.length) rebuilt.prospects = extra
  }
  if (judgments.length > 0 || matches.length > 0) {
    const extra = salvagePathJudgmentObjectsByRegex(work)
    const cur = (rebuilt.judgments as unknown[] | undefined)?.length ?? 0
    if (extra.length > cur) rebuilt.judgments = extra
  }
  return rebuilt
}

/** 从一段 `{...}` 里宽松抠 briefKey / prospect / status（字段顺序不限） */
function fieldsFromLooseObject(block: string): Record<string, unknown> | null {
  const briefKey =
    block.match(/"briefKey"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]?.trim() ||
    block.match(/"key"\s*:\s*"(bh_[^"]+)"/)?.[1]?.trim() ||
    ''
  const prospectRaw =
    block.match(/"prospect"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ??
    block.match(/"prospect"\s*:\s*"((?:[^"\\]|\\.|[\n\r])*?)"/)?.[1]
  const prospect = (prospectRaw ?? '')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .trim()
  const status =
    block.match(/"status"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]?.trim() || ''
  if (!briefKey) return null
  if (!prospect && !status) return null
  const row: Record<string, unknown> = { briefKey }
  if (prospect) row.prospect = prospect
  if (status) row.status = status
  return row
}

/** 正则/松散捞完整 prospect 行（坏/截断 JSON 兜底；字段顺序不限） */
export function salvageProspectObjectsByRegex(
  raw: string,
): Array<Record<string, unknown>> {
  const work = escapeRawControlsInJsonStrings(raw)
  const out: Array<Record<string, unknown>> = []
  const seen = new Set<string>()

  // 先按对象块扫（顺序不敏感）
  const blockRe = /\{[^{}]*\}/g
  let bm: RegExpExecArray | null
  while ((bm = blockRe.exec(work)) !== null) {
    const row = fieldsFromLooseObject(bm[0]!)
    if (!row) continue
    const id = `${row.briefKey}|${String(row.prospect ?? '').slice(0, 48)}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(row)
  }

  // 兼容旧顺序：briefKey → prospect → status
  const re =
    /"briefKey"\s*:\s*"([^"]+)"\s*,\s*"prospect"\s*:\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"status"\s*:\s*"([^"]*)")?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(work)) !== null) {
    const briefKey = m[1]!.trim()
    const prospect = m[2]!
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .trim()
    if (!briefKey || !prospect) continue
    const id = `${briefKey}|${prospect.slice(0, 48)}`
    if (seen.has(id)) continue
    seen.add(id)
    const row: Record<string, unknown> = { briefKey, prospect }
    const status = (m[3] ?? '').trim()
    if (status) row.status = status
    out.push(row)
  }
  return out
}

/** 从 LLM 正文抠 JSON（允许围栏/前后废话；截断时尽量抢救） */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const asObj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null
  // 优先抠「--- raw ---」后的正文（写信台落账日志包了一层 markdown）
  const rawSection = text.match(/---\s*raw\s*---\s*([\s\S]*)$/i)
  const source = rawSection?.[1]?.trim() || text
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = escapeRawControlsInJsonStrings((fenced?.[1] ?? source).trim())
  const start = body.indexOf('{')
  if (start < 0) {
    const regexProspects = salvageProspectObjectsByRegex(body)
    if (regexProspects.length > 0) return { prospects: regexProspects }
    const regexJudgments = salvagePathJudgmentObjectsByRegex(body)
    return regexJudgments.length > 0 ? { judgments: regexJudgments } : null
  }
  const slice = body.slice(start)
  const end = slice.lastIndexOf('}')
  if (end > 0) {
    const direct = asObj(tryParseJson(slice.slice(0, end + 1)))
    if (direct) return direct
  }
  const salvaged = asObj(salvageTruncatedJson(slice))
  if (salvaged) return salvaged
  const regexProspects = salvageProspectObjectsByRegex(slice)
  if (regexProspects.length > 0) return { prospects: regexProspects }
  const regexJudgments = salvagePathJudgmentObjectsByRegex(slice)
  return regexJudgments.length > 0 ? { judgments: regexJudgments } : null
}

/**
 * 规范化一步的 bookKeys：≥1、去空；连续重复压成一元（禁自环伪装二元）。
 */
export function asBookKeys(keys: unknown): string[] | null {
  if (!Array.isArray(keys) || keys.length < 1) return null
  const raw = keys
    .map((k) => String(k ?? '').trim())
    .filter(Boolean)
  if (raw.length < 1) return null
  // [a,a] → [a]（单门独自走向 Q，不是自环）
  if (raw.length === 2 && raw[0] === raw[1]) return [raw[0]!]
  // 保序去重，保留并肩多门
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of raw) {
    if (seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out.length > 0 ? out : null
}

/**
 * 解析 infer out → 解法列表。
 * 接受 { paths:[{ conclusion, steps:[{role?, bookKeys, infer|infers[]|rationale}] }] }。
 * 兼容旧输出（无 conclusion）：用各步 infer 拼总览。
 * 一槽一 infer：infers[] → 同 role/门下多枚步骤；禁止正文哈希合并。
 */
export function parseInferPaths(llmText: string): InferPathRaw[] {
  const obj = extractJsonObject(llmText)
  if (!obj || typeof obj !== 'object') return []

  const root = obj as Record<string, unknown>
  const pathNodes: unknown[] = Array.isArray(root.paths)
    ? root.paths
    : Array.isArray(root.steps)
      ? [{ steps: root.steps }]
      : []

  const out: InferPathRaw[] = []
  for (const p of pathNodes) {
    if (!p || typeof p !== 'object') continue
    const prow = p as {
      conclusion?: unknown
      summary?: unknown
      answer?: unknown
      steps?: unknown
    }
    const stepsRaw = prow.steps
    if (!Array.isArray(stepsRaw)) continue
    const steps: InferStepRaw[] = []
    for (const s of stepsRaw) {
      if (!s || typeof s !== 'object') continue
      const row = s as {
        bookKeys?: unknown
        bookSlots?: unknown
        infer?: unknown
        infers?: unknown
        rationale?: unknown
        role?: unknown
        part?: unknown
        serves?: unknown
      }
      const bookKeys = asBookKeys(row.bookKeys)
      if (!bookKeys) continue
      const role = String(row.role ?? row.part ?? row.serves ?? '').trim()
      const bookSlots = Array.isArray(row.bookSlots)
        ? row.bookSlots
            .map((x) => Number(x))
            .filter((n) => Number.isFinite(n) && n >= 1)
        : undefined
      const slotsAligned =
        bookSlots && bookSlots.length === bookKeys.length
          ? bookSlots
          : undefined
      const slots = expandIncrementSlots(
        row.infer ?? row.rationale,
        row.infers,
      )
      for (const slot of slots) {
        steps.push({
          role,
          bookKeys: [...bookKeys],
          bookSlots: slotsAligned ? [...slotsAligned] : undefined,
          infer: slot.text,
        })
      }
    }
    if (steps.length === 0) continue
    const conclusion =
      String(prow.conclusion ?? prow.summary ?? prow.answer ?? '').trim() ||
      steps
        .map((st) => st.infer.trim())
        .filter(Boolean)
        .join('；')
    if (!conclusion) continue
    out.push({ conclusion, steps })
  }
  return out
}

/**
 * 解析失败时不造伪槽（共用一段正文会把多义内容并进错误 key）。
 */
export function fallbackInferPaths(
  _bookKeys: string[],
  _llmText: string,
): InferPathRaw[] {
  return []
}

export interface ReuseJudgment {
  /** 复用闸主坐标：normKey（监督归一化） */
  normKey?: string
  /** 谱系 / 兼容：pathKey */
  pathKey: string
  /** 兼容旧闸：无 path 时曾用 inferKey */
  inferKey?: string
  canSolve: boolean
  rationale: string
}

/** 复用闸 out：{ judgments:[{normKey|pathKey,canSolve,rationale}] } */
export function parseReuseJudgments(llmText: string): ReuseJudgment[] {
  const obj = extractJsonObject(llmText)
  if (!obj || typeof obj !== 'object') return []
  const root = obj as Record<string, unknown>
  const rows: unknown[] = Array.isArray(root.judgments)
    ? root.judgments
    : root.pathKey != null ||
        root.normKey != null ||
        root.inferKey != null ||
        root.queryKey != null
      ? [root]
      : []
  const out: ReuseJudgment[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const row = r as Record<string, unknown>
    const normKey = String(row.normKey ?? '').trim()
    const pathKey = String(row.pathKey ?? '').trim()
    const inferKey = String(row.inferKey ?? row.queryKey ?? '').trim()
    if (!normKey && !pathKey && !inferKey) continue
    const canSolve =
      row.canSolve === true ||
      row.canSolve === 'true' ||
      row.reuse === true ||
      String(row.canSolve).toLowerCase() === 'yes'
    out.push({
      normKey: normKey || undefined,
      pathKey: pathKey || inferKey || normKey,
      inferKey: inferKey || undefined,
      canSolve,
      rationale: String(row.rationale ?? row.依据 ?? '').trim(),
    })
  }
  return out
}

/** decide prospect 槽：briefKey ↔ prospect 正文（台再 settle 铸 prospectKey） */
export interface DecideProspectRow {
  briefKey: string
  /** prospect 增量：该 brief 解 Q_now 的一种可能/预测 */
  prospect: string
}

/** @deprecated 用 DecideProspectRow */
export type DecideKeepRow = DecideProspectRow

/**
 * path/监督信效度行：主坐标 pathKey；充分时带归一化正文。
 * 兼容旧行：inferKey+prospectKey（台再映到已铸 pathKey）。
 */
export interface PathMatchRow {
  pathKey?: string
  inferKey?: string
  prospectKey?: string
  /** sufficient = 印证成立→台铸 normKey；insufficient = 不成案 */
  status?: 'sufficient' | 'insufficient' | 'unread'
  /** 充分必填：infer 为底、prospect 修饰的归一化推理正文 */
  normalizedText?: string
}

/** @deprecated 名保留；现解析 judgments/matches 上的信效度行 */
export function parsePathMatches(llmText: string): PathMatchRow[] {
  return parsePathValidityJudgments(llmText)
}

/**
 * { judgments|matches:[{pathKey,status,normalizedText?}] }
 * 兼容旧 {inferKey,prospectKey,status}
 */
export function parsePathValidityJudgments(llmText: string): PathMatchRow[] {
  const obj = extractJsonObject(llmText)
  const out: PathMatchRow[] = []
  const seen = new Set<string>()

  const push = (row: {
    pathKey?: string
    inferKey?: string
    prospectKey?: string
    statusRaw?: string
    normalizedText?: string
  }) => {
    const pathKey = (row.pathKey ?? '').trim()
    const inferKey = (row.inferKey ?? '').trim()
    const prospectKey = (row.prospectKey ?? '').trim()
    if (!pathKey && (!inferKey || !prospectKey)) return
    const id = pathKey || `${inferKey}::${prospectKey}`
    if (seen.has(id)) return
    seen.add(id)
    const raw = (row.statusRaw ?? '').trim().toLowerCase()
    let status: PathMatchRow['status']
    if (raw === 'sufficient' || raw === 'ok' || raw === 'pass') {
      status = 'sufficient'
    } else if (raw === 'insufficient' || raw === 'fail' || raw === 'weak') {
      status = 'insufficient'
    } else if (raw === 'unread') {
      status = 'unread'
    }
    const normalizedText = (row.normalizedText ?? '').trim() || undefined
    out.push({
      pathKey: pathKey || undefined,
      inferKey: inferKey || undefined,
      prospectKey: prospectKey || undefined,
      status,
      normalizedText,
    })
  }

  if (obj && typeof obj === 'object') {
    const root = obj as Record<string, unknown>
    const rows: unknown[] = Array.isArray(root.judgments)
      ? root.judgments
      : Array.isArray(root.matches)
        ? root.matches
        : Array.isArray(root.pairs)
          ? root.pairs
          : []
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue
      const row = r as Record<string, unknown>
      push({
        pathKey: String(row.pathKey ?? ''),
        inferKey: String(row.inferKey ?? ''),
        prospectKey: String(row.prospectKey ?? ''),
        statusRaw: String(row.status ?? ''),
        normalizedText: String(
          row.normalizedText ?? row.normalizedPath ?? row.normText ?? '',
        ),
      })
    }
  }

  const salvage = () => {
    for (const row of salvagePathJudgmentObjectsByRegex(llmText)) {
      push({
        pathKey: String(row.pathKey ?? ''),
        inferKey: String(row.inferKey ?? ''),
        prospectKey: String(row.prospectKey ?? ''),
        statusRaw: String(row.status ?? ''),
        normalizedText: String(
          row.normalizedText ?? row.normalizedPath ?? '',
        ),
      })
    }
  }
  if (out.length === 0) salvage()
  else salvage()
  return out
}

function fieldsFromLoosePathJudgment(
  block: string,
): Record<string, unknown> | null {
  const pathKey =
    block.match(/"pathKey"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]?.trim() || ''
  const inferKey =
    block.match(/"inferKey"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]?.trim() || ''
  const prospectKey =
    block.match(/"prospectKey"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]?.trim() || ''
  const status =
    block.match(/"status"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]?.trim() || ''
  const normalizedText =
    block.match(
      /"normalizedText"\s*:\s*"((?:[^"\\]|\\.)*)"/,
    )?.[1]?.trim() ||
    block.match(
      /"normalizedPath"\s*:\s*"((?:[^"\\]|\\.)*)"/,
    )?.[1]?.trim() ||
    ''
  if (!pathKey && (!inferKey || !prospectKey)) return null
  const row: Record<string, unknown> = {}
  if (pathKey) row.pathKey = pathKey
  if (inferKey) row.inferKey = inferKey
  if (prospectKey) row.prospectKey = prospectKey
  if (status) row.status = status
  if (normalizedText) row.normalizedText = normalizedText
  return row
}

/** 正则捞 path 信效度行（坏/截断 JSON 兜底；字段顺序不限） */
export function salvagePathJudgmentObjectsByRegex(
  raw: string,
): Array<Record<string, unknown>> {
  const work = escapeRawControlsInJsonStrings(raw)
  const out: Array<Record<string, unknown>> = []
  const seen = new Set<string>()

  const blockRe = /\{[^{}]*\}/g
  let bm: RegExpExecArray | null
  while ((bm = blockRe.exec(work)) !== null) {
    const row = fieldsFromLoosePathJudgment(bm[0]!)
    if (!row) continue
    const id = `${row.inferKey}|${row.prospectKey}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(row)
  }

  const re =
    /"inferKey"\s*:\s*"([^"]+)"\s*,\s*"prospectKey"\s*:\s*"([^"]+)"(?:\s*,\s*"status"\s*:\s*"([^"]*)")?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(work)) !== null) {
    const inferKey = m[1]!.trim()
    const prospectKey = m[2]!.trim()
    if (!inferKey || !prospectKey) continue
    const id = `${inferKey}|${prospectKey}`
    if (seen.has(id)) continue
    seen.add(id)
    const row: Record<string, unknown> = { inferKey, prospectKey }
    const status = (m[3] ?? '').trim()
    if (status) row.status = status
    out.push(row)
  }
  return out
}

/** queryLLM 出：对称子集 historic queryKey + 增量 neighbour（相关度） */
export interface QueryNeighbourRow {
  queryKey: string
  /** 相关度（归档：neighbour） */
  degree: string
  /**
   * query 硬闸：是否授权本条历史问进 reuse。
   * true=可开复用闸；false=只挂邻域喂材料；缺省=台侧用 degree 硬词判定。
   */
  reuseEligible?: boolean
}

/**
 * 解析 queryLLM out。
 * 架构：输出 queryKey（子集）+ neighbour（相关度）；挂在对应 historic queryKey 上。
 * 兼容旧字段 orderedQueryKeys（无 degree 时 degree 为空串）。
 */
export function parseQueryNeighbours(llmText: string): QueryNeighbourRow[] {
  const obj = extractJsonObject(llmText)
  if (!obj || typeof obj !== 'object') return []
  const root = obj as Record<string, unknown>
  const out: QueryNeighbourRow[] = []
  const seen = new Set<string>()

  const asBool = (v: unknown): boolean | undefined => {
    if (v === true || v === false) return v
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase()
      if (s === 'true' || s === 'yes' || s === '1') return true
      if (s === 'false' || s === 'no' || s === '0') return false
    }
    if (typeof v === 'number') {
      if (v === 1) return true
      if (v === 0) return false
    }
    return undefined
  }

  const push = (
    qk: string,
    degree: string,
    reuseEligible?: boolean,
  ) => {
    const key = qk.trim()
    if (!key || seen.has(key)) return
    seen.add(key)
    const row: QueryNeighbourRow = { queryKey: key, degree: degree.trim() }
    if (reuseEligible !== undefined) row.reuseEligible = reuseEligible
    out.push(row)
  }

  const neighbours = root.neighbours ?? root.neighbor ?? root.neighbour
  if (Array.isArray(neighbours)) {
    for (const row of neighbours) {
      if (typeof row === 'string') {
        push(row, '')
        continue
      }
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      push(
        String(r.queryKey ?? r.key ?? ''),
        String(r.degree ?? r.neighbour ?? r.relatedness ?? r.score ?? ''),
        asBool(r.reuseEligible ?? r.reuse ?? r.canReuse),
      )
    }
  }

  // 兼容旧：orderedQueryKeys 仅表示被选中的对称子集，相关度缺失
  if (out.length === 0) {
    const raw =
      root.orderedQueryKeys ?? root.queryKeys ?? root.ordered ?? null
    if (Array.isArray(raw)) {
      raw.forEach((x, i) => {
        if (typeof x === 'string') push(x, '')
        else if (x && typeof x === 'object') {
          const r = x as Record<string, unknown>
          push(
            String(r.queryKey ?? r.key ?? ''),
            String(r.degree ?? r.neighbour ?? '') || `rank=${i + 1}`,
            asBool(r.reuseEligible ?? r.reuse ?? r.canReuse),
          )
        }
      })
    }
  }

  return out
}

/** @deprecated 用 parseQueryNeighbours；仅返回被选中的 historic queryKey */
export function parseOrderedQueryKeys(llmText: string): string[] {
  return parseQueryNeighbours(llmText).map((r) => r.queryKey)
}
