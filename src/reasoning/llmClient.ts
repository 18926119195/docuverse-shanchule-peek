import { demoAuthHeaders } from './demoAuth'
import { loadDualModelConfig } from './modelRuntimeConfig'
import type { InstructionBundle, LlmCallResult } from './types'

export function llmConfigStatus(): {
  configured: boolean
  baseUrl: string
  model: string
} {
  const { reason } = loadDualModelConfig()
  // Server holds the real key; browser only needs protocol endpoint readiness.
  const viaProxy =
    reason.baseUrl.includes('/api/llm') ||
    reason.baseUrl.includes('/api/protocol') ||
    reason.baseUrl.trim() === '' ||
    reason.apiKey.trim().length > 0
  return {
    configured: viaProxy && reason.model.trim().length > 0,
    baseUrl: '/api/protocol/infer',
    model: reason.model || '(server)',
  }
}

/**
 * Protocol infer runs on the server (prompt assembly + LLM).
 * Browser only sends lock handle + readout + question — not the prompt template.
 */
export async function callLlmWithBundle(
  bundle: InstructionBundle,
): Promise<LlmCallResult> {
  try {
    const res = await fetch('/api/protocol/infer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...demoAuthHeaders(),
      },
      body: JSON.stringify({
        question: bundle.question,
        sourceExcerpt: bundle.sourceExcerpt,
        lock: {
          lockId: bundle.R.key,
          kind: bundle.R.kind,
          // page/start/end stay server-side only — do not echo stream coords on the wire
          faces: {
            text: Boolean(bundle.R.faces.text),
            fig: Boolean(bundle.R.faces.fig),
          },
        },
        forbidDirections: bundle.forbidDirections,
        edge: bundle.edge
          ? {
              fromKey: bundle.edge.fromKey,
              toKey: bundle.edge.toKey,
              relation: bundle.edge.relation,
              adjust: bundle.edge.adjust,
              linkType: bundle.edge.linkType,
              premiseConclusion: bundle.edge.premiseConclusion,
            }
          : undefined,
        premise: bundle.premise,
      }),
    })

    const data: unknown = await res.json().catch(() => null)
    if (
      typeof data !== 'object' ||
      data === null ||
      !('ok' in data) ||
      typeof (data as { ok: unknown }).ok !== 'boolean'
    ) {
      return {
        ok: false,
        usedMock: false,
        path: '',
        conclusion: '',
        error: `协议推理响应异常 HTTP ${res.status}`,
      }
    }

    const body = data as {
      ok: boolean
      path?: string
      conclusion?: string
      usedMock?: boolean
      error?: string
    }

    if (!body.ok) {
      return {
        ok: false,
        usedMock: Boolean(body.usedMock),
        path: '',
        conclusion: '',
        error: body.error || `协议推理失败 HTTP ${res.status}`,
      }
    }

    return {
      ok: true,
      usedMock: Boolean(body.usedMock),
      path: typeof body.path === 'string' ? body.path : '',
      conclusion: typeof body.conclusion === 'string' ? body.conclusion : '',
    }
  } catch (e) {
    return {
      ok: false,
      usedMock: false,
      path: '',
      conclusion: '',
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
