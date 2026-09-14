import { chatCompletion, tryParseJsonObject } from './llmChat.js'
import type { AbBlockBody } from './inferOpsCore.js'

export type FormalizeBody = {
  question: string
  blocks: AbBlockBody[]
  gatewayConclusion: string
  gatewayPath: string
  unitLabel?: string
}

export type FormalizeResult = {
  ok: boolean
  usedMock: boolean
  formalConclusion: string
  usedKeys: string[]
  ops: unknown[]
  path?: string
  rawText?: string
  error?: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function parseFormalizeBody(raw: unknown): FormalizeBody | string {
  if (!isRecord(raw)) return 'body must be object'
  const question = typeof raw.question === 'string' ? raw.question.trim() : ''
  const gatewayConclusion =
    typeof raw.gatewayConclusion === 'string'
      ? raw.gatewayConclusion.trim()
      : ''
  const gatewayPath =
    typeof raw.gatewayPath === 'string' ? raw.gatewayPath.trim() : ''
  if (!question) return 'question required'
  if (!gatewayConclusion) return 'gatewayConclusion required'
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
    gatewayConclusion,
    gatewayPath,
    unitLabel:
      typeof raw.unitLabel === 'string' ? raw.unitLabel.trim() : undefined,
  }
}

function buildBlocksPrompt(blocks: AbBlockBody[]): string {
  return blocks
    .map((b, i) => {
      const handle = b.shortHandle || `块${i + 1}`
      return `### ${handle}\nkey: ${b.key}\ntext:\n${b.text}`
    })
    .join('\n\n')
}

export function buildFormalizePrompt(input: FormalizeBody): string {
  const keys = input.blocks.map((b) => b.key)
  const n = input.blocks.length
  return [
    '你是后置形式化助手：把网关已给出的「人话推理步骤 + 结」翻译成木块身份的有序互动。',
    '不要重推另一个结；formalConclusion 须与网关结同一主张。',
    '重点：把网关路径里「如何由前提得到结」逐句译成 ops；每步必须有 claim（中间主张）。',
    '越细越好；若网关路径较粗，可按木块拆开补全推导链，但仍不得改主张。',
    '',
    input.unitLabel ? `单元：${input.unitLabel}` : '',
    `【用户问题】${input.question}`,
    '',
    '【网关结】',
    input.gatewayConclusion,
    '',
    '【网关人话路径】',
    input.gatewayPath || '（无）',
    '',
    '【AllowedKeys】',
    keys.join('\n'),
    '',
    '【木块】',
    buildBlocksPrompt(input.blocks),
    '',
    '只输出 JSON：',
    '- formalConclusion: string（与网关结同向）',
    '- usedKeys: string[]',
    '- path?: string',
    '- ops: 至少 ' +
      String(Math.max(4, n + 2)) +
      ' 步；每项',
    '  { "op":"attend|infer|combine|contrast|conclude|defer", "keys":string[],',
    '    "note":string, "claim":string }',
    '禁止只 attend 完全部就 conclude；禁止空 claim；禁止发明 key。',
  ]
    .filter(Boolean)
    .join('\n')
}

export async function runFormalize(
  input: FormalizeBody,
): Promise<FormalizeResult> {
  const llm = await chatCompletion({
    system:
      '你只输出合法 JSON。把网关人话推导译成带 claim 的身份步骤；不另起主张。只用 AllowedKeys。',
    user: buildFormalizePrompt(input),
    temperature: 0.2,
    maxTokens: 8192,
    timeoutMs: 12 * 60 * 1000,
  })
  if (!llm.ok) {
    return {
      ok: false,
      usedMock: false,
      formalConclusion: '',
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
      formalConclusion: input.gatewayConclusion,
      usedKeys: keys,
      ops: [
        {
          op: 'attend',
          keys: [keys[0]],
          note: '对齐网关首步读块（mock）',
          claim: '从首块读出与网关路径一致的要点（mock）',
        },
        {
          op: 'infer',
          keys: [keys[0]],
          note: '译网关中间推导（mock）',
          claim: '中间主张对齐网关路径（mock）',
        },
        {
          op: 'conclude',
          keys,
          note: '对齐网关结（mock）',
          claim: input.gatewayConclusion,
        },
      ],
      path: 'formalize mock',
      rawText: llm.content,
    }
  }

  const obj = tryParseJsonObject(llm.content)
  if (!obj) {
    return {
      ok: false,
      usedMock: false,
      formalConclusion: '',
      usedKeys: [],
      ops: [],
      rawText: llm.content,
      error: '形式化未返回可解析 JSON',
    }
  }

  const formalConclusion =
    typeof obj.formalConclusion === 'string'
      ? obj.formalConclusion.trim()
      : typeof obj.conclusion === 'string'
        ? obj.conclusion.trim()
        : ''
  const usedKeys = Array.isArray(obj.usedKeys)
    ? obj.usedKeys.filter((k): k is string => typeof k === 'string')
    : []
  const ops = Array.isArray(obj.ops) ? obj.ops : []
  const path = typeof obj.path === 'string' ? obj.path : undefined

  return {
    ok: Boolean(formalConclusion),
    usedMock: false,
    formalConclusion,
    usedKeys,
    ops,
    path,
    rawText: llm.content,
    error: formalConclusion ? undefined : '缺少 formalConclusion',
  }
}
