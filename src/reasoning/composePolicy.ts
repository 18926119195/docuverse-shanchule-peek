/**
 * Letter-writing recipe: checkboxes and strategy dialog share this object.
 */

export type CrossComposeMode = 'pages' | 'span' | 'exhaustive'

export interface ComposePolicy {
  includeFine: boolean
  includeSamePageCluster: boolean
  includeWindow: boolean
  includeCrossPage: boolean
  crossMode: CrossComposeMode
  /** 0-based page indices when crossMode === 'pages' */
  crossPages: number[]
  /** max |pageA-pageB| when crossMode === 'span' */
  crossSpan: number
  /** cap units when crossMode === 'exhaustive' (also soft-cap for other modes) */
  crossMaxUnits: number
  windowRadius: number
  /** Optional natural-language strategy (auditable) */
  strategyText?: string
}

export function defaultComposePolicy(): ComposePolicy {
  return {
    includeFine: true,
    includeSamePageCluster: true,
    includeWindow: false,
    includeCrossPage: false,
    crossMode: 'exhaustive',
    crossPages: [],
    crossSpan: 1,
    crossMaxUnits: 20,
    windowRadius: 1,
  }
}

/**
 * Rule-based strategy parser (stable; no LLM).
 * Merges onto `base` (usually current checkbox state).
 */
export function parseComposeStrategy(
  text: string,
  base: ComposePolicy = defaultComposePolicy(),
): { policy: ComposePolicy; note: string } {
  const raw = text.trim()
  if (!raw) {
    return { policy: { ...base, strategyText: '' }, note: '空策略，保持勾选' }
  }

  const policy: ComposePolicy = {
    ...base,
    strategyText: raw,
    crossPages: [...base.crossPages],
  }
  const notes: string[] = []

  if (/只要单槽|仅单槽|只要细槽|只做单槽/.test(raw)) {
    policy.includeFine = true
    policy.includeSamePageCluster = false
    policy.includeWindow = false
    policy.includeCrossPage = false
    notes.push('仅单槽')
  }

  if (/同页多槽|同页组合|同页袋|打开同页/.test(raw)) {
    policy.includeSamePageCluster = true
    notes.push('同页多槽开')
  }
  if (/不要同页|关闭同页|别同页/.test(raw)) {
    policy.includeSamePageCluster = false
    notes.push('同页多槽关')
  }

  if (/邻接窗|打开窗|\bwindow\b|±\s*1/.test(raw)) {
    policy.includeWindow = true
    notes.push('邻接窗开')
  }
  if (/不要邻接|关闭邻接|关窗|不要窗/.test(raw)) {
    policy.includeWindow = false
    notes.push('邻接窗关')
  }

  if (/不要单槽|关闭单槽|别单槽/.test(raw)) {
    policy.includeFine = false
    notes.push('单槽关')
  }
  if (/要单槽|打开单槽|含单槽/.test(raw) && !/不要单槽|关闭单槽/.test(raw)) {
    policy.includeFine = true
  }

  if (/跨页|cross\s*page/.test(raw)) {
    policy.includeCrossPage = true
    notes.push('跨页开')
  }
  if (/不要跨页|关闭跨页|别跨页/.test(raw)) {
    policy.includeCrossPage = false
    notes.push('跨页关')
  }

  if (/穷尽跨页|跨页穷尽|exhaustive/.test(raw)) {
    policy.includeCrossPage = true
    policy.crossMode = 'exhaustive'
    notes.push('跨页=穷尽')
  }

  const spanHit = raw.match(/跨\s*(\d+)\s*页|页距\s*[≤<=]?\s*(\d+)|span\s*[≤<=]?\s*(\d+)/i)
  if (spanHit) {
    const n = Number(spanHit[1] || spanHit[2] || spanHit[3])
    if (Number.isFinite(n) && n >= 0) {
      policy.includeCrossPage = true
      policy.crossMode = 'span'
      policy.crossSpan = n
      notes.push(`跨页=页距≤${n}`)
    }
  }

  const maxHit = raw.match(/最多\s*(\d+)|上限\s*(\d+)|max\s*[=:]?\s*(\d+)/i)
  if (maxHit) {
    const n = Number(maxHit[1] || maxHit[2] || maxHit[3])
    if (Number.isFinite(n) && n > 0) {
      policy.crossMaxUnits = n
      notes.push(`上限${n}`)
    }
  }

  // Pages: 「第3页和第7页」「页 3、7」「p3 p7」「跨页：3和7」
  const pageNums: number[] = []
  const pageRe =
    /(?:第\s*)?(\d+)\s*页|(?:^|[\s,，、:：和与+/]|p)(\d+)(?=\s*页|\s*[,，、]|p|\s*$)/gi
  let m: RegExpExecArray | null
  const scan = raw
  while ((m = pageRe.exec(scan)) !== null) {
    const n = Number(m[1] || m[2])
    if (Number.isFinite(n) && n >= 1) pageNums.push(n - 1)
  }
  if (
    pageNums.length >= 2 &&
    (/跨页|指定页|这几页|页\s*\d/.test(raw) || /和|与|、|,/.test(raw))
  ) {
    policy.includeCrossPage = true
    policy.crossMode = 'pages'
    policy.crossPages = [...new Set(pageNums)].sort((a, b) => a - b)
    notes.push(
      `跨页=指定页[${policy.crossPages.map((p) => p + 1).join(',')}]`,
    )
  }

  if (notes.length === 0) {
    notes.push('未识别到明确指令，保持勾选')
  }

  return { policy, note: notes.join(' · ') }
}
