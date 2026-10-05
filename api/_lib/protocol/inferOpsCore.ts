import { chatCompletion, tryParseJsonObject } from './llmChat.js'

export type AbBlockBody = {
  key: string
  text: string
  page?: number
  shortHandle?: string
}

export type InferOpsBody = {
  question: string
  blocks: AbBlockBody[]
  unitLabel?: string
}

export type InferOpsResult = {
  ok: boolean
  usedMock: boolean
  conclusion: string
  path: string
  usedKeys: string[]
  ops: unknown[]
  rawText?: string
  error?: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function parseInferOpsBody(raw: unknown): InferOpsBody | string {
  if (!isRecord(raw)) return 'body must be object'
  const question = typeof raw.question === 'string' ? raw.question.trim() : ''
  if (!question) return 'question required'
  if (!Array.isArray(raw.blocks) || raw.blocks.length === 0) {
    return 'blocks[] required'
  }
  const blocks: AbBlockBody[] = []
  for (const item of raw.blocks) {
    if (!isRecord(item)) continue
    const key = typeof item.key === 'string' ? item.key.trim() : ''
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    if (!key || !text) continue
    blocks.push({
      key,
      text,
      page: typeof item.page === 'number' ? item.page : undefined,
      shortHandle:
        typeof item.shortHandle === 'string' ? item.shortHandle : undefined,
    })
  }
  if (blocks.length === 0) return 'blocks need key+text'
  return {
    question,
    blocks,
    unitLabel:
      typeof raw.unitLabel === 'string' ? raw.unitLabel.trim() : undefined,
  }
}

const MAX_BLOCK_CHARS = 6000

function clipBlockText(text: string): string {
  if (text.length <= MAX_BLOCK_CHARS) return text
  return `${text.slice(0, MAX_BLOCK_CHARS)}\n…[袋内 text 已截断至 ${MAX_BLOCK_CHARS} 字，identity 仍完整]`
}

function buildBlocksPrompt(blocks: AbBlockBody[]): string {
  return blocks
    .map((b, i) => {
      const handle = b.shortHandle || `块${i + 1}`
      const page = typeof b.page === 'number' ? ` p${b.page}` : ''
      return `### ${handle}${page}\nkey: ${b.key}\ntext:\n${clipBlockText(b.text)}`
    })
    .join('\n\n')
}

export function buildInferOpsPrompt(input: InferOpsBody): string {
  const keys = input.blocks.map((b) => b.key)
  return [
    '你是教材分析助手。封闭木块袋（AllowedKeys）如下；只依据袋内 text。',
    '任务：依据递交材料回答用户问题，并写清逐步推导。',
    '正确性由监督 loop 与硬闸检查；不必输出 formal ops 步骤剧场。',
    input.unitLabel ? `单元标签：${input.unitLabel}` : '',
    '',
    '【AllowedKeys】',
    keys.join('\n'),
    '',
    '【木块】',
    buildBlocksPrompt(input.blocks),
    '',
    `【用户问题】${input.question}`,
    '',
    '只输出一个 JSON（不要围栏外文字）：',
    '- conclusion: string 最终结论',
    '- path: string 人话版逐步推导（先处理哪块、得出什么、如何接到下一步）',
    '- usedKeys: string[] 本结论实际用到的 AllowedKeys 完整串（须 ⊆ AllowedKeys）',
    '',
    '禁止：发明/截断 key；勿编造袋外事实。',
  ]
    .filter(Boolean)
    .join('\n')
}

export async function runInferWithOps(
  input: InferOpsBody,
): Promise<InferOpsResult> {
  const llm = await chatCompletion({
    system:
      '你只输出合法 JSON。依据 AllowedKeys 木块回答；usedKeys 必须是完整 key 串且 ⊆ AllowedKeys。不必输出 ops。',
    user: buildInferOpsPrompt(input),
    temperature: 0.25,
    maxTokens: 8192,
    timeoutMs: 12 * 60 * 1000,
    thinking: false,
  })
  if (!llm.ok) {
    return {
      ok: false,
      usedMock: false,
      conclusion: '',
      path: '',
      usedKeys: [],
      ops: [],
      error: llm.error,
    }
  }
  if (llm.usedMock) {
    const keys = input.blocks.map((b) => b.key)
    return {
      ok: true,
      usedMock: true,
      conclusion: `【Mock 测试一】针对「${input.question}」`,
      path: '1. 锁定木块\n2. 组合对照\n3. 给出结论（mock）',
      usedKeys: keys,
      ops: [],
      rawText: llm.content,
    }
  }

  const obj = tryParseJsonObject(llm.content)
  if (!obj) {
    return {
      ok: false,
      usedMock: false,
      conclusion: '',
      path: '',
      usedKeys: [],
      ops: [],
      rawText: llm.content,
      error: '模型未返回可解析 JSON',
    }
  }

  const conclusion =
    typeof obj.conclusion === 'string' ? obj.conclusion.trim() : ''
  const path = typeof obj.path === 'string' ? obj.path.trim() : ''
  const usedKeys = Array.isArray(obj.usedKeys)
    ? obj.usedKeys.filter((k): k is string => typeof k === 'string')
    : []
  const ops: unknown[] = []

  return {
    ok: Boolean(conclusion),
    usedMock: false,
    conclusion,
    path,
    usedKeys,
    ops,
    rawText: llm.content,
    error: conclusion ? undefined : '缺少 conclusion',
  }
}
