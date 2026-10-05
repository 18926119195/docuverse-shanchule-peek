/**
 * POST /api/llm/chat/completions → DeepSeek official API
 * Explicit path — Vercel does not treat [...path].ts as catch-all in this project setup.
 */
import { llmUpstream } from '../../_lib/env.js'
import { proxyUpstream } from '../../_lib/upstreamProxy.js'

export const config = { runtime: 'edge', maxDuration: 60 }

export default async function handler(req: Request): Promise<Response> {
  const { baseUrl, apiKey, chatModel } = llmUpstream()
  return proxyUpstream(req, {
    stripPrefix: '/api/llm',
    baseUrl,
    apiKey,
    forceModel: chatModel,
    missingKeyMessage:
      'LLM_API_KEY missing on server (set in Vercel Environment Variables)',
  })
}
