/**
 * Server-side InstructionBundle → prompt (protocol core).
 * Kept off the browser bundle; only /api/protocol/infer uses this.
 */

export interface ServerForbidItem {
  directionId?: string
  questionSummary: string
  conclusionSummary: string
}

export interface ServerEdge {
  fromKey: string
  toKey: string
  relation: string
  adjust?: string
  linkType: string
  premiseConclusion?: string
}

export interface ServerPremise {
  conclusion: string
  pathSummary: string
  fromKey: string
}

/** Minimal lock payload for grounding — no client-side prompt assembly. */
export interface ServerLockRef {
  /** Opaque display id; may equal key* but clients should treat as handle */
  lockId: string
  kind: 'text' | 'fig'
  page: number
  start?: number
  end?: number
  figId?: string
  faces: {
    text?: boolean
    fig?: boolean
  }
}

export interface InferRequestBody {
  question: string
  sourceExcerpt: string
  lock: ServerLockRef
  forbidDirections?: ServerForbidItem[]
  edge?: ServerEdge
  premise?: ServerPremise
}

export function buildProtocolPrompt(input: InferRequestBody): string {
  const forbid = input.forbidDirections ?? []
  const forbidBlock =
    forbid.length === 0
      ? '（无）'
      : forbid
          .map(
            (f, i) =>
              `${i + 1}. 勿沿此方向：问「${f.questionSummary}」→ 旧结论「${f.conclusionSummary}」`,
          )
          .join('\n')

  const edgeBlock = input.edge
    ? [
        `推理边: ${input.edge.fromKey} → ${input.edge.toKey}`,
        `relation=${input.edge.relation} adjust=${input.edge.adjust ?? '-'} linkType=${input.edge.linkType}`,
        input.edge.premiseConclusion
          ? `边前提结论: ${input.edge.premiseConclusion}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '（无跨对象边）'

  const premiseBlock = input.premise
    ? `增量/继承前提（来自 ${input.premise.fromKey}）:\n${input.premise.conclusion}\n路径: ${input.premise.pathSummary}`
    : '（无）'

  const faceTags = [
    input.lock.faces.text ? '文字脸' : null,
    input.lock.faces.fig ? '图脸' : null,
  ]
    .filter((x): x is string => Boolean(x))
    .join('+')

  const objectBlock = [
    `【位置锁 kind】${input.lock.kind}`,
    `【脸】${faceTags || '（无）'}`,
    input.lock.kind === 'fig' && input.lock.figId
      ? '【图锁】已附着图脸（勿复述内部 fig 标识）'
      : '【文字锁】已附着文字脸读值',
    '【机器读值 · 一锁两脸】',
    input.sourceExcerpt.trim(),
    '',
    '必须只依据上述读值作答。禁止离开该锁引用圈外段落、页标题或未提供的文字；有图脸时勿编造未给出的图内文字。OCR 与图不一致时以同锁对照说明，勿另起分析对象。',
    '禁止在推理路径或结论中写出：页码、槽号 k、字符区间、lockId/句柄字符串、fused/bm25 等内部索引字段。',
  ].join('\n')

  return [
    '你是教材分析助手。',
    '【分析对象】已由服务端锁定（不透明句柄，勿猜测或复述内部坐标）。',
    objectBlock,
    '若依据不足，明确说依据不足，不要离开该锁编造。',
    '',
    '【禁止重复的旧方向】',
    forbidBlock,
    '',
    '【跨对象推理边】',
    edgeBlock,
    '',
    '【前提】',
    premiseBlock,
    '',
    `【用户问题】${input.question.trim()}`,
    '',
    '请输出：',
    '1) 推理路径（详细步骤，越细越好）：逐步说明如何处理读值中的材料、每步得到什么中间判断、如何接到最终结论；不要只写「同/异对比」就结束。',
    '2) 结论（面向教师，可执行）',
  ].join('\n')
}

export function parseModelText(text: string): { path: string; conclusion: string } {
  const pathMatch = text.match(
    /(?:推理路径|路径)\s*[:：]?\s*([\s\S]*?)(?=(?:结论|$))/i,
  )
  const concMatch = text.match(/(?:结论)\s*[:：]?\s*([\s\S]*?)$/i)
  const path = redactCoordLeak(pathMatch?.[1]?.trim() || text.slice(0, 400))
  const conclusion = redactCoordLeak(
    concMatch?.[1]?.trim() || text.slice(0, 800),
  )
  return { path, conclusion }
}

/** Strip accidental page/slot/stream coords from model output before leaving server. */
export function redactCoordLeak(text: string): string {
  return text
    .replace(/第\s*\d+\s*页/g, '锁定页')
    .replace(/字符区间\s*\[[^\]]*\]/g, '已锁定读值区间')
    .replace(/\[\s*\d+\s*,\s*\d+\s*\)/g, '[已锁定区间]')
    .replace(/\bp\s*\d+\s*k\s*\d+\b/gi, '槽位')
    .replace(/\bk\s*=\s*\d+\b/gi, 'k=*')
    .replace(/h1\.[A-Za-z0-9_-]{12,}/g, 'h1.[已省略]')
    .replace(/\bfused\s*=\s*[\d.]+/gi, '')
    .replace(/\bdense\s*=\s*[\d.]+/gi, '')
    .replace(/\bbm25\s*=\s*[\d.]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function mockInfer(input: InferRequestBody): {
  path: string
  conclusion: string
  usedMock: true
} {
  const forbidNote =
    (input.forbidDirections?.length ?? 0) > 0
      ? `已排除 ${input.forbidDirections!.length} 条旧方向。`
      : '无负面清单。'
  const excerpt = input.sourceExcerpt.trim().slice(0, 160)
  return {
    usedMock: true,
    path: [
      '1. 锁定分析对象摘录',
      '2. 应用禁止方向（若有）',
      '3. 在对象内形成结论（服务端 mock，未调用远端模型）',
    ].join('\n'),
    conclusion: [
      `【Mock 结论】针对问题「${input.question.trim()}」。`,
      forbidNote,
      `对象摘录节选：${excerpt}${input.sourceExcerpt.trim().length > 160 ? '…' : ''}`,
      '（服务端配置 LLM_API_KEY 后改为真实模型）',
    ].join(' '),
  }
}
