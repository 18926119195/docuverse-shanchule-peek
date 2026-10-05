import { llmUpstream } from '../env.js'
import { chatCompletion } from './llmChat.js'
import {
  buildProtocolPrompt,
  mockInfer,
  parseModelText,
  type InferRequestBody,
} from './prompt.js'

const INFER_CHAT_TIMEOUT_MS = 12 * 60 * 1000
const INFER_MAX_TOKENS = 8192

export type InferResult = {
  ok: boolean
  path: string
  conclusion: string
  usedMock: boolean
  error?: string
  /** Acknowledgement only — does not echo full prompt */
  ack?: {
    lockId: string
    premiseCount: number
    forbidCount: number
    calledModel: boolean
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function parseInferBody(raw: unknown): InferRequestBody | string {
  if (!isRecord(raw)) return 'body must be object'
  const question = typeof raw.question === 'string' ? raw.question.trim() : ''
  const sourceExcerpt =
    typeof raw.sourceExcerpt === 'string' ? raw.sourceExcerpt.trim() : ''
  if (!question) return 'question required'
  if (!sourceExcerpt) return 'sourceExcerpt required (empty machine readout)'

  if (!isRecord(raw.lock)) return 'lock required'
  const lockId =
    typeof raw.lock.lockId === 'string' ? raw.lock.lockId.trim() : ''
  const kind = raw.lock.kind === 'fig' ? 'fig' : 'text'
  const page = typeof raw.lock.page === 'number' ? raw.lock.page : 0
  if (!lockId) return 'lock.lockId required'

  const facesRaw = isRecord(raw.lock.faces) ? raw.lock.faces : {}
  const faces = {
    text: Boolean(facesRaw.text),
    fig: Boolean(facesRaw.fig),
  }
  if (!faces.text && !faces.fig) return 'lock.faces must include text and/or fig'

  const forbidDirections: InferRequestBody['forbidDirections'] = []
  if (Array.isArray(raw.forbidDirections)) {
    for (const item of raw.forbidDirections) {
      if (!isRecord(item)) continue
      const questionSummary =
        typeof item.questionSummary === 'string' ? item.questionSummary : ''
      const conclusionSummary =
        typeof item.conclusionSummary === 'string' ? item.conclusionSummary : ''
      if (!questionSummary && !conclusionSummary) continue
      forbidDirections.push({
        directionId:
          typeof item.directionId === 'string' ? item.directionId : undefined,
        questionSummary,
        conclusionSummary,
      })
    }
  }

  let edge: InferRequestBody['edge']
  if (isRecord(raw.edge)) {
    edge = {
      fromKey: String(raw.edge.fromKey ?? ''),
      toKey: String(raw.edge.toKey ?? ''),
      relation: String(raw.edge.relation ?? ''),
      adjust:
        typeof raw.edge.adjust === 'string' ? raw.edge.adjust : undefined,
      linkType: String(raw.edge.linkType ?? ''),
      premiseConclusion:
        typeof raw.edge.premiseConclusion === 'string'
          ? raw.edge.premiseConclusion
          : undefined,
    }
  }

  let premise: InferRequestBody['premise']
  if (isRecord(raw.premise)) {
    premise = {
      conclusion: String(raw.premise.conclusion ?? ''),
      pathSummary: String(raw.premise.pathSummary ?? ''),
      fromKey: String(raw.premise.fromKey ?? ''),
    }
  }

  return {
    question,
    sourceExcerpt,
    lock: {
      lockId,
      kind,
      page,
      start: typeof raw.lock.start === 'number' ? raw.lock.start : undefined,
      end: typeof raw.lock.end === 'number' ? raw.lock.end : undefined,
      figId: typeof raw.lock.figId === 'string' ? raw.lock.figId : undefined,
      faces,
    },
    forbidDirections,
    edge,
    premise,
  }
}

export async function runProtocolInfer(
  input: InferRequestBody,
): Promise<InferResult> {
  const ack = {
    lockId: input.lock.lockId,
    premiseCount: input.premise ? 1 : 0,
    forbidCount: input.forbidDirections?.length ?? 0,
    calledModel: false,
  }

  const upstream = llmUpstream()
  if (!upstream.apiKey) {
    const m = mockInfer(input)
    return { ok: true, path: m.path, conclusion: m.conclusion, usedMock: true, ack }
  }

  const prompt = buildProtocolPrompt(input)
  const llm = await chatCompletion({
    system:
      '你是严谨的教材分析助手。只依据用户提供的分析对象原文作答，不要编造对象外事实。',
    user: prompt,
    temperature: 0.3,
    maxTokens: INFER_MAX_TOKENS,
    timeoutMs: INFER_CHAT_TIMEOUT_MS,
    thinking: false,
  })

  if (!llm.ok) {
    return {
      ok: false,
      path: '',
      conclusion: '',
      usedMock: false,
      error: llm.error,
      ack,
    }
  }

  if (!llm.content.trim()) {
    return {
      ok: false,
      path: '',
      conclusion: '',
      usedMock: false,
      error: 'LLM 响应为空',
      ack,
    }
  }

  const parsed = parseModelText(llm.content)
  return {
    ok: true,
    path: parsed.path,
    conclusion: parsed.conclusion,
    usedMock: false,
    ack: { ...ack, calledModel: true },
  }
}
